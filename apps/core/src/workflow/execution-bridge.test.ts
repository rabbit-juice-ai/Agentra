import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Execution } from '@agentra/protocol'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ReworkRequestRepository } from '../db/repositories/rework-request-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { WorktreeService } from '../services/worktree-service'
import { WorkflowAssignmentResolver } from './assignment-resolver'
import type { DispatchContext } from './dispatch-gates'
import {
  type ExecutionStarter,
  type TaskEvent,
  type TaskEventSink,
  type TestResultReworkPort,
  WorkflowExecutionBridge,
} from './execution-bridge'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { ReworkService } from './rework-service'
import { WorkflowRunService } from './run-service'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CAPABILITIES = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'unsupported',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
} as const

function execution(
  id: string,
  status: Execution['status'],
  exitCode: number | null = null,
): Execution {
  return {
    id,
    sessionId: 'ses-1',
    providerId: 'prov-1',
    agentId: 'agent-1',
    externalExecutionId: null,
    processId: null,
    status,
    workingDirectory: '/tmp/w',
    startedAt: NOW,
    endedAt: NOW,
    exitCode,
    capabilities: { ...CAPABILITIES },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function definition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task_1',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 1 },
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'do it',
          outputContract: { profile: 'test_result' },
          retryPolicy: { maxAttempts: 2 },
        },
      },
      { key: 'end', type: 'end', label: '', position: { x: 0, y: 2 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'end' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

class FakeStarter implements ExecutionStarter {
  readonly calls: { nodeRunId: string; params: Record<string, unknown> }[] = []
  private readonly map = new Map<string, string>()

  async startForNode(
    nodeRunId: string,
    params: { agentId: string; workId: string; prompt: string; worktreeId?: string },
  ): Promise<Execution> {
    this.calls.push({ nodeRunId, params })
    const id = `exe-${this.calls.length}`
    this.map.set(id, nodeRunId)
    return execution(id, 'running')
  }

  getNodeRunId(executionId: string): string | null {
    return this.map.get(executionId) ?? null
  }

  /** 测试辅助：把已存在的执行直接绑定到 NodeRun（不经过 startForNode）。 */
  bind(executionId: string, nodeRunId: string): void {
    this.map.set(executionId, nodeRunId)
  }
}

function setup(
  rework?: TestResultReworkPort,
  taskEvents?: TaskEventSink,
  assignmentOverride?: (runId: string, nodeKey: string) => string | null,
): {
  db: Database
  bridge: WorkflowExecutionBridge
  starter: FakeStarter
  outputs: Map<string, Record<string, unknown>>
  context: DispatchContext
  nodes: NodeRunRepository
  reworks: ReworkRequestRepository
  reworkService: ReworkService
  nodeRunId: string
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-bridge-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json,
       default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
       tool_permissions_json)
     VALUES ('agent-1', 'A', 'dev', '', '', '[]', NULL, 1, 'active', ?, ?, NULL,
       '{"version":1,"allow":["Read"],"deny":[]}')`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
       concurrency_limit, context_ref, created_at, updated_at)
     VALUES ('as-1', 'work-1', 'agent-1', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
  ).run(NOW, NOW)

  const workRepo = new WorkRepository(db)
  const assignmentRepo = new AssignmentRepository(db)
  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const draft = definitionService.createDraft(template.id, definition())
  definitionService.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const resolver = new WorkflowAssignmentResolver(assignmentRepo)
  const runService = new WorkflowRunService(
    db,
    runs,
    branches,
    nodes,
    workRepo,
    definitions,
    resolver,
    () => NOW,
  )
  const run = runService.createRun({ workId: 'work-1', workflowVersionId: draft.id })
  const nodeRun = nodes.listByRun(run.id).find((node) => node.workflowNodeKey === 'task_1')
  if (!nodeRun) throw new Error('missing task node run')
  nodes.transition(nodeRun.id, ['blocked'], 'ready', NOW)
  nodes.transition(nodeRun.id, ['ready'], 'running', NOW)
  const branch = branches.listByRun(run.id)[0]
  if (!branch) throw new Error('missing root branch')

  const starter = new FakeStarter()
  const outputs = new Map<string, Record<string, unknown>>()
  const reworks = new ReworkRequestRepository(db)
  const reworkService = new ReworkService({
    db,
    runs,
    branches,
    nodes,
    reworks,
    approvals: new ApprovalRepository(db),
    definitions,
    now: () => NOW,
  })
  const bridge = new WorkflowExecutionBridge({
    db,
    runs,
    nodes,
    works: workRepo,
    worktrees: new WorktreeService(
      db,
      workRepo,
      assignmentRepo,
      path.join(dir, 'worktrees'),
      () => NOW,
    ),
    definitions,
    resolver,
    executions: starter,
    outputs: (executionId) => outputs.get(executionId) ?? null,
    rework: rework ?? reworkService,
    ...(taskEvents ? { taskEvents } : {}),
    ...(assignmentOverride ? { assignmentOverride } : {}),
    now: () => NOW,
  })

  return {
    db,
    bridge,
    starter,
    outputs,
    nodes,
    reworks,
    reworkService,
    nodeRunId: nodeRun.id,
    context: {
      run,
      nodeRun,
      node: definition().nodes.find((node) => node.key === 'task_1') as never,
      branch,
      branchKey: 'root',
      definition: definition(),
    },
    close: () => db.close(),
  }
}

describe('WorkflowExecutionBridge · 启动', () => {
  it('binds the execution to the NodeRun via startForNode', async () => {
    const h = setup()
    try {
      await h.bridge.onNodeStarted(h.context)
      expect(h.starter.calls).toHaveLength(1)
      expect(h.starter.calls[0]?.nodeRunId).toBe(h.nodeRunId)
      expect(h.starter.calls[0]?.params).toMatchObject({ agentId: 'agent-1', workId: 'work-1' })
    } finally {
      h.close()
    }
  })

  it('fails the node with assignment_inactive instead of rebinding when the assignment is paused', async () => {
    const h = setup()
    try {
      h.db.prepare("UPDATE assignments SET status = 'paused' WHERE id = 'as-1'").run()
      await h.bridge.onNodeStarted(h.context)
      expect(h.starter.calls).toHaveLength(0)
      const node = h.nodes.get(h.nodeRunId)
      expect(node?.status).toBe('failed')
      expect(node?.error?.category).toBe('assignment_inactive')
    } finally {
      h.close()
    }
  })
})

describe('WorkflowExecutionBridge · 完成与输出契约', () => {
  it('succeeds the node when the execution succeeded and the contract is satisfied', () => {
    const h = setup()
    try {
      const output = {
        pass: true,
        failureReason: '',
        relatedTasks: [],
        impactScope: 'none',
        relatedArtifacts: [],
      }
      h.outputs.set('exe-1', output)
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      const node = h.nodes.get(h.nodeRunId)
      expect(node?.status).toBe('succeeded')
      expect(node?.outputSnapshot).toEqual(output)
    } finally {
      h.close()
    }
  })

  it('fails the node with output_contract_violation when output is missing (no rework)', () => {
    const calls: unknown[] = []
    const h = setup({ onTestResult: (input) => calls.push(input) })
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      const node = h.nodes.get(h.nodeRunId)
      expect(node?.status).toBe('failed')
      expect(node?.error?.category).toBe('output_contract_violation')
      expect(h.nodes.listByRunAndKey(h.context.run.id, 'task_1')).toHaveLength(1)
      // 契约失败不得触发返工（v12 后这条终于有真实落点）
      expect(calls).toEqual([])
    } finally {
      h.close()
    }
  })

  it('creates no rework_requests when the test_result contract is violated (O-1 full check)', () => {
    const h = setup()
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      const node = h.nodes.get(h.nodeRunId)
      expect(node?.status).toBe('failed')
      expect(node?.error?.category).toBe('output_contract_violation')
      expect(h.reworks.listByRun(h.context.run.id)).toEqual([])
    } finally {
      h.close()
    }
  })

  it('fails closed when pass=false has no relatedTasks (no rework)', () => {
    const h = setup()
    try {
      h.outputs.set('exe-1', {
        pass: false,
        failureReason: 'unknown',
        relatedTasks: [],
        impactScope: 'unknown',
        relatedArtifacts: [],
      })
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      const node = h.nodes.get(h.nodeRunId)
      expect(node?.status).toBe('failed')
      expect(node?.error?.category).toBe('output_contract_violation')
      expect(node?.error?.message).toContain('relatedTasks')
      expect(h.reworks.listByRun(h.context.run.id)).toEqual([])
    } finally {
      h.close()
    }
  })

  it('triggers rework only after a valid test_result report', () => {
    const calls: { reportNodeKey: string; output: Record<string, unknown> }[] = []
    const h = setup({
      onTestResult: (input) =>
        calls.push({ reportNodeKey: input.reportNodeKey, output: input.output }),
    })
    try {
      const output = {
        pass: false,
        failureReason: 'ui broken',
        relatedTasks: ['task_1'],
        impactScope: 'ui',
        relatedArtifacts: [],
      }
      h.outputs.set('exe-1', output)
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      expect(h.nodes.get(h.nodeRunId)?.status).toBe('succeeded')
      expect(calls).toEqual([{ reportNodeKey: 'task_1', output }])
    } finally {
      h.close()
    }
  })
})

describe('WorkflowExecutionBridge · NodeRun 级重试', () => {
  it('creates the next attempt while under maxAttempts', () => {
    const h = setup()
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'failed', 1))
      const attempts = h.nodes.listByRunAndKey(h.context.run.id, 'task_1')
      expect(attempts).toHaveLength(2)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[1]?.status).toBe('ready')
      expect(attempts[1]?.attempt).toBe(2)
    } finally {
      h.close()
    }
  })

  it('does not create a further attempt once maxAttempts is reached', () => {
    const h = setup()
    try {
      const second = h.nodes.create(
        {
          id: 'nrn-attempt-2',
          workflowRunId: h.context.run.id,
          workflowNodeKey: 'task_1',
          status: 'running',
          attempt: 2,
        },
        NOW,
      )
      h.starter.bind('exe-1', second.id)
      h.bridge.onExecutionFinished(execution('exe-1', 'failed', 1))
      expect(h.nodes.get(second.id)?.status).toBe('failed')
      // 已达 maxAttempts=2：不再创建 attempt 3
      expect(h.nodes.listByRunAndKey(h.context.run.id, 'task_1')).toHaveLength(2)
    } finally {
      h.close()
    }
  })
})

function recordingSink(): { events: TaskEvent[]; sink: TaskEventSink } {
  const events: TaskEvent[] = []
  return {
    events,
    sink: {
      onTaskStarted: (event) => events.push(event),
      onTaskSucceeded: (event) => events.push(event),
      onTaskFailed: (event) => events.push(event),
      onTaskCancelled: (event) => events.push(event),
      onVerificationReport: (event) => events.push(event),
    },
  }
}

describe('WorkflowExecutionBridge · 任务事件', () => {
  it('emits started, succeeded and verification for a passing test_result', async () => {
    const { events, sink } = recordingSink()
    const h = setup(undefined, sink)
    try {
      h.outputs.set('exe-1', {
        pass: true,
        failureReason: '',
        relatedTasks: [],
        impactScope: 'none',
        relatedArtifacts: [],
      })
      await h.bridge.onNodeStarted(h.context)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      expect(events.map((event) => event.kind)).toEqual(['started', 'succeeded', 'verification'])
      expect(events[0]).toMatchObject({ nodeKey: 'task_1', attempt: 1, agentId: 'agent-1' })
      expect(events[2]).toMatchObject({ passed: true, relatedTasks: [] })
    } finally {
      h.close()
    }
  })

  it('emits failed with willRetry when the execution fails under maxAttempts', () => {
    const { events, sink } = recordingSink()
    const h = setup(undefined, sink)
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'failed', 1))
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'failed',
          category: 'execution_failure',
          willRetry: true,
          attempt: 1,
        }),
      ])
    } finally {
      h.close()
    }
  })

  it('emits failed without retry on output contract violation', () => {
    const { events, sink } = recordingSink()
    const h = setup(undefined, sink)
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'failed',
          category: 'output_contract_violation',
          willRetry: false,
        }),
      ])
    } finally {
      h.close()
    }
  })

  it('emits cancelled when the execution is cancelled', () => {
    const { events, sink } = recordingSink()
    const h = setup(undefined, sink)
    try {
      h.starter.bind('exe-1', h.nodeRunId)
      h.bridge.onExecutionFinished(execution('exe-1', 'cancelled'))
      expect(events).toEqual([expect.objectContaining({ kind: 'cancelled' })])
    } finally {
      h.close()
    }
  })

  it('keeps the state machine running when the sink throws', async () => {
    const throwing: TaskEventSink = {
      onTaskStarted: () => {
        throw new Error('sink down')
      },
      onTaskSucceeded: () => {
        throw new Error('sink down')
      },
      onTaskFailed: () => {
        throw new Error('sink down')
      },
      onTaskCancelled: () => {
        throw new Error('sink down')
      },
      onVerificationReport: () => {
        throw new Error('sink down')
      },
    }
    const h = setup(undefined, throwing)
    try {
      h.outputs.set('exe-1', {
        pass: true,
        failureReason: '',
        relatedTasks: [],
        impactScope: 'none',
        relatedArtifacts: [],
      })
      await h.bridge.onNodeStarted(h.context)
      h.bridge.onExecutionFinished(execution('exe-1', 'succeeded', 0))
      expect(h.nodes.get(h.nodeRunId)?.status).toBe('succeeded')
    } finally {
      h.close()
    }
  })
})

describe('WorkflowExecutionBridge · 显式改派', () => {
  it('dispatches the override agent for the next attempt', async () => {
    const h = setup(undefined, undefined, () => 'agent-2')
    try {
      h.db
        .prepare(
          `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json,
             default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
             tool_permissions_json)
           VALUES ('agent-2', 'B', 'dev', '', '', '[]', NULL, 1, 'active', ?, ?, NULL,
             '{"version":1,"allow":["Read"],"deny":[]}')`,
        )
        .run(NOW, NOW)
      h.db
        .prepare(
          `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
             concurrency_limit, context_ref, created_at, updated_at)
           VALUES ('as-2', 'work-1', 'agent-2', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
        )
        .run(NOW, NOW)

      await h.bridge.onNodeStarted(h.context)

      expect(h.starter.calls).toHaveLength(1)
      expect(h.starter.calls[0]?.params.agentId).toBe('agent-2')
    } finally {
      h.close()
    }
  })
})
