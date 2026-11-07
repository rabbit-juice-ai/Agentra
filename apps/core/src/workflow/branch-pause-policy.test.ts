import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Execution } from '@agentra/protocol'
import type { ProviderCapabilities } from '@agentra/runtime-sdk'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { WorkflowAssignmentResolver } from './assignment-resolver'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowRunService } from './run-service'
import { WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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
        config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'x' },
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

function execution(
  id: string,
  capabilities: Partial<ProviderCapabilities>,
  status: Execution['status'] = 'running',
): Execution {
  return {
    id,
    sessionId: 'ses-1',
    providerId: `prov-${id}`,
    agentId: 'agent-1',
    externalExecutionId: null,
    processId: null,
    status,
    workingDirectory: '/tmp/w',
    startedAt: NOW,
    endedAt: null,
    exitCode: null,
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'native',
      checkpoint: 'unsupported',
      permissionRequests: 'native',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
      ...capabilities,
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

type Harness = {
  db: ReturnType<typeof openDatabase>
  executions: ExecutionRepository
  nodes: NodeRunRepository
  audit: AuditRepository
  branches: BranchRunRepository
  runId: string
  branchId: string
  nodeRunId: string
  close: () => void
}

function setup(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-pause-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO agent_profiles (id, name, avatar, description, system_prompt, skill_ids_json,
       access_mode, system_kind, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
       tool_permissions_json)
     VALUES ('agent-1', 'A', '🤖', '', '', '[]', 'edit', NULL, NULL, 1, 'active', ?, ?, NULL,
       '{"version":1,"allow":["Read"],"deny":[]}')`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
       concurrency_limit, context_ref, created_at, updated_at)
     VALUES ('as-1', 'work-1', 'agent-1', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
  ).run(NOW, NOW)
  const workRepo = new WorkRepository(db)
  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const service = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = service.createTemplate({ name: 't' })
  const draft = service.createDraft(template.id, definition())
  service.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const executions = new ExecutionRepository(db)
  const audit = new AuditRepository(db)
  const runService = new WorkflowRunService(
    db,
    runs,
    branches,
    nodes,
    workRepo,
    definitions,
    new WorkflowAssignmentResolver(new AssignmentRepository(db)),
    () => NOW,
  )
  const run = runService.createRun({ workId: 'work-1', workflowVersionId: draft.id })
  const branch = branches.listByRun(run.id)[0]
  if (!branch) throw new Error('missing branch')
  const nodeRun = nodes.listByRun(run.id).find((node) => node.workflowNodeKey === 'task_1')
  if (!nodeRun) throw new Error('missing task node run')
  nodes.transition(nodeRun.id, ['blocked'], 'ready', NOW)
  nodes.transition(nodeRun.id, ['ready'], 'running', NOW)

  return {
    db,
    executions,
    nodes,
    audit,
    branches,
    runId: run.id,
    branchId: branch.id,
    nodeRunId: nodeRun.id,
    close: () => db.close(),
  }
}

function bind(h: Harness, execution: Execution, nodeRunId: string | null = h.nodeRunId): void {
  h.db
    .prepare(
      `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
       VALUES (?, 'cli', 'P', '{}', 'healthy', ?, ?)`,
    )
    .run(execution.providerId, NOW, NOW)
  h.db
    .prepare(
      `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
       VALUES (?, NULL, ?, NULL, NULL, 'active', ?, ?, NULL)`,
    )
    .run(`ses-${execution.id}`, execution.providerId, NOW, NOW)
  h.db
    .prepare(
      `INSERT INTO executions (
         id, session_id, node_run_id, provider_id, status, working_directory,
         capabilities_snapshot_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '/tmp/w', ?, ?, ?)`,
    )
    .run(
      execution.id,
      `ses-${execution.id}`,
      nodeRunId,
      execution.providerId,
      execution.status,
      JSON.stringify(execution.capabilities),
      NOW,
      NOW,
    )
}

describe('S4-07 · 三档暂停策略', () => {
  it('tier 1: interrupts a native interrupt+resume execution and audits it', async () => {
    const h = setup()
    try {
      const interrupted: string[] = []
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: h.branches,
        nodes: h.nodes,
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: {
          interrupt: async (executionId) => {
            interrupted.push(executionId)
            return { interrupted: true }
          },
        },
        now: () => NOW,
      })
      bind(h, execution('exe-1', { interrupt: 'native', resume: 'native' }))

      const paused = await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(paused).toBe(true)
      expect(h.branches.get(h.branchId)?.status).toBe('paused')
      expect(interrupted).toEqual(['exe-1'])
      expect(h.audit.listByAction('workflow.execution.interrupted')[0]).toMatchObject({
        action: 'workflow.execution.interrupted',
        targetType: 'execution',
        targetId: 'exe-1',
        details: expect.objectContaining({
          runId: h.runId,
          branchRunId: h.branchId,
          nodeRunId: h.nodeRunId,
          interrupted: true,
          resumeUsable: true,
        }),
      })
    } finally {
      h.close()
    }
  })

  it('tier 1b: interrupts an interrupt+no-resume execution and records resumeUsable=false', async () => {
    const h = setup()
    try {
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: h.branches,
        nodes: h.nodes,
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: {
          interrupt: async () => ({ interrupted: true }),
        },
        now: () => NOW,
      })
      bind(h, execution('exe-1', { interrupt: 'native', resume: 'unsupported' }))

      await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(h.audit.listByAction('workflow.execution.interrupted')[0]?.details).toMatchObject({
        resumeUsable: false,
      })
    } finally {
      h.close()
    }
  })

  it('tier 2: leaves interrupt=unsupported execution running and audits awaiting_completion', async () => {
    const h = setup()
    try {
      const interrupts: string[] = []
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: h.branches,
        nodes: h.nodes,
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: {
          interrupt: async (executionId) => {
            interrupts.push(executionId)
            return { interrupted: true }
          },
        },
        now: () => NOW,
      })
      bind(h, execution('exe-1', { interrupt: 'unsupported', resume: 'unsupported' }))

      const paused = await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(paused).toBe(true)
      expect(interrupts).toEqual([])
      expect(h.executions.get('exe-1')?.status).toBe('running')
      expect(h.audit.listByAction('workflow.execution.awaiting_completion')[0]).toMatchObject({
        targetType: 'execution',
        targetId: 'exe-1',
        details: expect.objectContaining({
          runId: h.runId,
          branchRunId: h.branchId,
          nodeRunId: h.nodeRunId,
          interrupt: 'unsupported',
        }),
      })
    } finally {
      h.close()
    }
  })

  it('tier 3: interrupt failure degrades to awaiting_completion without losing the pause', async () => {
    const h = setup()
    try {
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: h.branches,
        nodes: h.nodes,
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: {
          interrupt: async () => {
            throw new Error('daemon unreachable')
          },
        },
        pauseLogger: { warn: () => {} },
        now: () => NOW,
      })
      bind(h, execution('exe-1', { interrupt: 'native', resume: 'native' }))

      const paused = await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(paused).toBe(true)
      expect(h.branches.get(h.branchId)?.status).toBe('paused')
      expect(
        h.audit.listByAction('workflow.execution.awaiting_completion')[0]?.details,
      ).toMatchObject({
        reason: 'interrupt_failed',
        error: 'daemon unreachable',
      })
    } finally {
      h.close()
    }
  })

  it('handles multiple executions on one branch with mixed capabilities', async () => {
    const h = setup()
    try {
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: h.branches,
        nodes: h.nodes,
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: {
          interrupt: async (executionId) => {
            return { interrupted: executionId === 'exe-native' }
          },
        },
        now: () => NOW,
      })
      const endRun = h.nodes.listByRun(h.runId).find((node) => node.workflowNodeKey === 'end')
      if (!endRun) throw new Error('missing end node run')
      bind(h, execution('exe-native', { interrupt: 'native', resume: 'native' }))
      bind(
        h,
        execution('exe-unsup', { interrupt: 'unsupported', resume: 'unsupported' }),
        endRun.id,
      )

      await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(h.audit.listByAction('workflow.execution.interrupted')[0]?.targetId).toBe('exe-native')
      expect(h.audit.listByAction('workflow.execution.awaiting_completion')[0]?.targetId).toBe(
        'exe-unsup',
      )
    } finally {
      h.close()
    }
  })
})
