import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ReworkRequestRepository } from '../db/repositories/rework-request-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalService } from './approval-service'
import { WorkflowAssignmentResolver } from './assignment-resolver'
import {
  type ControlNodeDeps,
  completeConditionNode,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
  enterHumanApproval,
} from './control-nodes'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { isTestReportConsumedByCondition } from './graph'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { type ReworkEvent, ReworkService } from './rework-service'
import { WorkflowRunService } from './run-service'
import { WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const settings = (maxRounds: number) => ({
  defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
  reworkPolicy: { maxRounds },
  failureStrategy: 'fail_branch',
  concurrency: { maxParallelNodes: 4 },
})

const node = (key: string, type: string, config: Record<string, unknown> = {}, y = 0) => ({
  key,
  type,
  label: '',
  position: { x: 0, y },
  config,
})

const task = (key: string, y = 1) =>
  node(key, 'agent_task', { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'x' }, y)

const testTask = (key: string, y = 1) =>
  node(
    key,
    'agent_task',
    {
      assignmentSelector: { workRole: 'dev' },
      taskPrompt: 'test',
      outputContract: { profile: 'test_result' },
    },
    y,
  )

function linearDefinition(maxRounds: number): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1'),
      testTask('test_1', 2),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'test_1' },
      { key: 'e3', source: 'test_1', target: 'end' },
    ],
    settings: settings(maxRounds),
  } as unknown as WorkflowDefinition
}

function parallelDefinition(maxRounds: number): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node('split_1', 'parallel_split', {}, 1),
      task('ui', 2),
      testTask('ui_test', 3),
      task('api', 2),
      testTask('api_test', 3),
      node('join', 'join', { pairWith: 'split_1' }, 4),
      node('end', 'end', {}, 5),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'ui', branchKey: 'ui' },
      { key: 'e3', source: 'split_1', target: 'api', branchKey: 'api' },
      { key: 'e4', source: 'ui', target: 'ui_test' },
      { key: 'e5', source: 'api', target: 'api_test' },
      { key: 'e6', source: 'ui_test', target: 'join' },
      { key: 'e7', source: 'api_test', target: 'join' },
      { key: 'e8', source: 'join', target: 'end' },
    ],
    settings: settings(maxRounds),
  } as unknown as WorkflowDefinition
}

/** 参考模板：Testing 在 Join 之后（分支已被 F-1 置 completed）。 */
function referenceDefinition(maxRounds: number): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node('split_1', 'parallel_split', {}, 1),
      task('ui', 2),
      task('api', 2),
      node('join', 'join', { pairWith: 'split_1' }, 3),
      testTask('testing', 4),
      node('end', 'end', {}, 5),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'ui', branchKey: 'ui' },
      { key: 'e3', source: 'split_1', target: 'api', branchKey: 'api' },
      { key: 'e4', source: 'ui', target: 'join' },
      { key: 'e5', source: 'api', target: 'join' },
      { key: 'e6', source: 'join', target: 'testing' },
      { key: 'e7', source: 'testing', target: 'end' },
    ],
    settings: settings(maxRounds),
  } as unknown as WorkflowDefinition
}

function conditionReworkDefinition(maxRounds: number): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1'),
      testTask('test_1', 2),
      node(
        'cond',
        'condition',
        {
          predicate: {
            kind: 'comparison',
            op: '==',
            left: { kind: 'field', path: 'nodes.test_1.output.pass' },
            right: { kind: 'literal', value: true },
          },
          falseBranch: { kind: 'rework', reportNodeKey: 'test_1' },
        },
        3,
      ),
      node('end', 'end', {}, 4),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'test_1' },
      { key: 'e3', source: 'test_1', target: 'cond' },
      { key: 'e4', source: 'cond', target: 'end', when: true },
    ],
    settings: settings(maxRounds),
  } as unknown as WorkflowDefinition
}

function approvalDefinition(maxRounds: number): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1'),
      node(
        'approval',
        'human_approval',
        { target: { nodeKey: 'task_1', phase: 'after_execute' } },
        2,
      ),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'approval' },
      { key: 'e3', source: 'approval', target: 'end' },
    ],
    settings: settings(maxRounds),
  } as unknown as WorkflowDefinition
}

type Outputs = (nodeKey: string, attempt: number) => Record<string, unknown>

type Harness = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  reworks: ReworkRequestRepository
  approvals: ApprovalRepository
  audit: AuditRepository
  approvalService: ApprovalService
  definitions: PublishedDefinitionProvider
  rework: ReworkService
  events: ReworkEvent[]
  runId: string
  definition: WorkflowDefinition
  close: () => void
}

function setup(definition: WorkflowDefinition): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-rework-'))
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
  const draft = definitionService.createDraft(template.id, definition)
  definitionService.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const reworks = new ReworkRequestRepository(db)
  const approvals = new ApprovalRepository(db)
  const audit = new AuditRepository(db)
  const events: ReworkEvent[] = []
  const rework = new ReworkService({
    db,
    runs,
    branches,
    nodes,
    reworks,
    approvals,
    definitions,
    audit,
    events: { publish: (event) => events.push(event) },
    now: () => NOW,
  })
  const approvalService = new ApprovalService(db, approvals, nodes, branches, () => NOW, rework)
  const runService = new WorkflowRunService(
    db,
    runs,
    branches,
    nodes,
    workRepo,
    definitions,
    new WorkflowAssignmentResolver(assignmentRepo),
    () => NOW,
  )
  const run = runService.createRun({ workId: 'work-1', workflowVersionId: draft.id })

  return {
    db,
    runs,
    branches,
    nodes,
    reworks,
    approvals,
    audit,
    approvalService,
    definitions,
    rework,
    events,
    runId: run.id,
    definition,
    close: () => db.close(),
  }
}

function controlDeps(h: Harness): ControlNodeDeps {
  return {
    db: h.db,
    runs: h.runs,
    branches: h.branches,
    nodes: h.nodes,
    definitions: h.definitions,
    approvals: h.approvalService,
    reworkTrigger: h.rework,
    now: () => NOW,
  }
}

async function drive(
  h: Harness,
  outputs: Outputs,
  options: { autoTestRework?: boolean } = {},
): Promise<void> {
  const scheduler = new WorkflowScheduler({
    runs: h.runs,
    branches: h.branches,
    nodes: h.nodes,
    definitions: h.definitions,
    gates: defaultDispatchGates(allowAllResourcePorts()),
    onNodeStarted: (context) => {
      const nodeRunId = context.nodeRun.id
      switch (context.node.type) {
        case 'start':
          completeStartNode(controlDeps(h), nodeRunId)
          break
        case 'parallel_split':
          completeSplitNode(controlDeps(h), nodeRunId)
          break
        case 'condition':
          completeConditionNode(controlDeps(h), nodeRunId)
          break
        case 'join':
          completeJoinNode(controlDeps(h), nodeRunId)
          break
        case 'end':
          completeEndNode(controlDeps(h), nodeRunId)
          break
        case 'human_approval':
          enterHumanApproval(controlDeps(h), nodeRunId)
          break
        case 'agent_task': {
          const output = outputs(context.node.key, context.nodeRun.attempt)
          h.nodes.transition(nodeRunId, ['running'], 'succeeded', NOW, {
            outputSnapshot: output,
          })
          if (
            options.autoTestRework !== false &&
            context.node.config.outputContract.profile === 'test_result' &&
            !isTestReportConsumedByCondition(context.definition, context.node.key)
          ) {
            h.rework.onTestResult({
              runId: h.runId,
              reportNodeRunId: nodeRunId,
              reportNodeKey: context.node.key,
              output,
            })
          }
          break
        }
      }
    },
    now: () => NOW,
  })
  await scheduler.runUntilIdle(h.runId, 100)
}

const pass = {
  pass: true,
  failureReason: '',
  relatedTasks: [],
  impactScope: '',
  relatedArtifacts: [],
}
const fail = (tasks: string[]) => ({
  pass: false,
  failureReason: 'broken',
  relatedTasks: tasks,
  impactScope: 'scope',
  relatedArtifacts: [],
})

describe('ReworkPolicy · 触发与定向返工', () => {
  it('A: passing tests create no ReworkRequest', async () => {
    const h = setup(parallelDefinition(2))
    try {
      await drive(h, (key) => (key === 'ui_test' || key === 'api_test' ? pass : {}))
      expect(h.reworks.listByRun(h.runId)).toEqual([])
      expect(h.runs.get(h.runId)?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('B: only the failed branch is reworked and retested', async () => {
    const h = setup(parallelDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'ui_test') return attempt === 1 ? fail(['ui']) : pass
        if (key === 'api_test') return pass
        return {}
      })

      const uiAttempts = h.nodes.listByRunAndKey(h.runId, 'ui')
      const apiAttempts = h.nodes.listByRunAndKey(h.runId, 'api')
      const uiTestAttempts = h.nodes.listByRunAndKey(h.runId, 'ui_test')
      const apiTestAttempts = h.nodes.listByRunAndKey(h.runId, 'api_test')
      expect(uiAttempts).toHaveLength(2)
      expect(uiTestAttempts).toHaveLength(2)
      expect(apiAttempts).toHaveLength(1)
      expect(apiTestAttempts).toHaveLength(1)

      const requests = h.reworks.listByRun(h.runId)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        triggerType: 'test_failure',
        round: 1,
        status: 'completed',
        targetNodeRunId: uiAttempts[0]?.id,
      })
      expect(h.runs.get(h.runId)?.status).toBe('completed')
      expect(h.events.map((event) => event.type)).toEqual([
        'rework.requested',
        'rework.started',
        'rework.completed',
      ])
      expect(h.audit.listByAction('workflow.rework.started')).toHaveLength(1)
      expect(h.audit.listByAction('workflow.rework.completed')).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('C: a failing api branch does not rerun ui', async () => {
    const h = setup(parallelDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'api_test') return attempt === 1 ? fail(['api']) : pass
        if (key === 'ui_test') return pass
        return {}
      })
      expect(h.nodes.listByRunAndKey(h.runId, 'api')).toHaveLength(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'ui')).toHaveLength(1)
      expect(h.nodes.listByRunAndKey(h.runId, 'ui_test')).toHaveLength(1)
      expect(h.runs.get(h.runId)?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('D: two failed branches create two independent ReworkRequests', async () => {
    const h = setup(parallelDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'ui_test') return attempt === 1 ? fail(['ui']) : pass
        if (key === 'api_test') return attempt === 1 ? fail(['api']) : pass
        return {}
      })
      const requests = h.reworks.listByRun(h.runId)
      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.status)).toEqual(['completed', 'completed'])
      expect(new Set(requests.map((request) => request.targetNodeRunId)).size).toBe(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'ui')).toHaveLength(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'api')).toHaveLength(2)
      expect(h.runs.get(h.runId)?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('E: retest runs on a new attempt of the test node', async () => {
    const h = setup(linearDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'test_1') return attempt === 1 ? fail(['task_1']) : pass
        return {}
      })
      expect(h.nodes.listByRunAndKey(h.runId, 'test_1').map((node) => node.attempt)).toEqual([1, 2])
      expect(h.nodes.listByRunAndKey(h.runId, 'task_1')).toHaveLength(2)
      expect(h.runs.get(h.runId)?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('reopens a completed split branch when Testing after Join fails (reference template)', async () => {
    const h = setup(referenceDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'testing') return attempt === 1 ? fail(['ui']) : pass
        return {}
      })
      expect(h.nodes.listByRunAndKey(h.runId, 'ui')).toHaveLength(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'api')).toHaveLength(1)
      expect(h.nodes.listByRunAndKey(h.runId, 'testing')).toHaveLength(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'join')).toHaveLength(2)

      const branches = h.branches.listByRun(h.runId)
      const reworkBranch = branches.find((branch) => branch.branchKey.startsWith('split_1/ui#rwk-'))
      expect(reworkBranch?.status).toBe('completed')
      expect(branches.find((branch) => branch.branchKey === 'split_1/api')?.status).toBe(
        'completed',
      )
      expect(h.runs.get(h.runId)?.status).toBe('completed')
      expect(h.reworks.listByRun(h.runId)[0]?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('condition falseBranch=rework re-evaluates after the retest and completes the request', async () => {
    const h = setup(conditionReworkDefinition(2))
    try {
      await drive(h, (key, attempt) => {
        if (key === 'test_1') return attempt === 1 ? fail(['task_1']) : pass
        return {}
      })
      const requests = h.reworks.listByRun(h.runId)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.status).toBe('completed')
      expect(h.nodes.listByRunAndKey(h.runId, 'cond').map((node) => node.attempt)).toEqual([1, 2])
      expect(h.runs.get(h.runId)?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('supports the cancelled terminal state and rejects transitions out of it', () => {
    const h = setup(linearDefinition(2))
    try {
      for (const key of ['task_1', 'test_1']) {
        const nodeRun = h.nodes.listByRunAndKey(h.runId, key)[0]
        if (!nodeRun) throw new Error(`missing ${key}`)
        h.nodes.transition(nodeRun.id, ['blocked'], 'ready', NOW)
        h.nodes.transition(nodeRun.id, ['ready'], 'running', NOW)
        h.nodes.transition(nodeRun.id, ['running'], 'succeeded', NOW, {
          outputSnapshot: key === 'test_1' ? fail(['task_1']) : {},
        })
      }
      const reportNode = h.nodes.listByRunAndKey(h.runId, 'test_1')[0]
      if (!reportNode) throw new Error('missing report node')
      const [request] = h.rework.requestForTestFailure({
        runId: h.runId,
        reportNodeRunId: reportNode.id,
        reportNodeKey: 'test_1',
        report: fail(['task_1']),
      })
      if (!request) throw new Error('missing request')
      expect(h.rework.finish(request.id, 'cancelled').status).toBe('cancelled')
      expect(() => h.rework.finish(request.id, 'completed')).toThrow(
        /illegal rework_request transition/,
      )
      expect(() => h.rework.start(request.id)).toThrow(/cannot start/)
    } finally {
      h.close()
    }
  })

  it('condition rework also honours maxRounds and pauses the branch on exhaustion', async () => {
    const h = setup(conditionReworkDefinition(1))
    try {
      await drive(h, (key) => (key === 'test_1' ? fail(['task_1']) : {}))
      const requests = h.reworks.listByRun(h.runId).sort((left, right) => left.round - right.round)
      expect(requests.map((request) => [request.round, request.status])).toEqual([
        [1, 'completed'],
        [2, 'exhausted'],
      ])
      expect(h.nodes.listByRunAndKey(h.runId, 'cond')).toHaveLength(2)
      expect(h.branches.getByKey(h.runId, 'root')?.status).toBe('paused')
      expect(h.runs.get(h.runId)?.status).toBe('running')
    } finally {
      h.close()
    }
  })

  it('is idempotent while a rework is already in progress', () => {
    const h = setup(linearDefinition(2))
    try {
      for (const key of ['task_1', 'test_1']) {
        const nodeRun = h.nodes.listByRunAndKey(h.runId, key)[0]
        if (!nodeRun) throw new Error(`missing ${key}`)
        h.nodes.transition(nodeRun.id, ['blocked'], 'ready', NOW)
        h.nodes.transition(nodeRun.id, ['ready'], 'running', NOW)
        h.nodes.transition(nodeRun.id, ['running'], 'succeeded', NOW, {
          outputSnapshot: key === 'test_1' ? fail(['task_1']) : {},
        })
      }
      const reportNode = h.nodes.listByRunAndKey(h.runId, 'test_1')[0]
      if (!reportNode) throw new Error('missing report node')
      const first = h.rework.requestForTestFailure({
        runId: h.runId,
        reportNodeRunId: reportNode.id,
        reportNodeKey: 'test_1',
        report: fail(['task_1']),
      })
      const second = h.rework.requestForTestFailure({
        runId: h.runId,
        reportNodeRunId: reportNode.id,
        reportNodeKey: 'test_1',
        report: fail(['task_1']),
      })
      expect(first).toHaveLength(1)
      expect(second[0]?.id).toBe(first[0]?.id)
      expect(h.reworks.listByRun(h.runId)).toHaveLength(1)
      expect(h.nodes.listByRunAndKey(h.runId, 'task_1')).toHaveLength(2)
    } finally {
      h.close()
    }
  })
})

describe('ReworkPolicy · 轮次上限（C-7）', () => {
  it('maxRounds=1 exhausts on the second rework and pauses the branch', async () => {
    const h = setup(linearDefinition(1))
    try {
      await drive(h, (key) => (key === 'test_1' ? fail(['task_1']) : {}))
      const requests = h.reworks.listByRun(h.runId).sort((left, right) => left.round - right.round)
      expect(requests.map((request) => [request.round, request.status])).toEqual([
        [1, 'completed'],
        [2, 'exhausted'],
      ])
      expect(h.nodes.listByRunAndKey(h.runId, 'task_1')).toHaveLength(2)
      expect(h.nodes.listByRunAndKey(h.runId, 'test_1')).toHaveLength(2)
      expect(h.branches.getByKey(h.runId, 'root')?.status).toBe('paused')
      expect(h.runs.get(h.runId)?.status).toBe('running')
      expect(h.events.filter((event) => event.type === 'rework.exhausted')).toHaveLength(1)
      expect(h.audit.listByAction('workflow.rework.requested')).toHaveLength(1)
      expect(h.audit.listByAction('workflow.rework.exhausted')).toHaveLength(1)
      expect(h.audit.listByAction('workflow.branch.paused')[0]).toMatchObject({
        targetType: 'branch_run',
        details: { reason: 'rework_exhausted' },
      })
    } finally {
      h.close()
    }
  })

  it('maxRounds=2 allows two reworks and exhausts on the third', async () => {
    const h = setup(linearDefinition(2))
    try {
      await drive(h, (key) => (key === 'test_1' ? fail(['task_1']) : {}))
      const requests = h.reworks.listByRun(h.runId).sort((left, right) => left.round - right.round)
      expect(requests.map((request) => [request.round, request.status])).toEqual([
        [1, 'completed'],
        [2, 'completed'],
        [3, 'exhausted'],
      ])
      expect(h.nodes.listByRunAndKey(h.runId, 'task_1')).toHaveLength(3)
      expect(h.nodes.listByRunAndKey(h.runId, 'test_1')).toHaveLength(3)
      expect(h.branches.getByKey(h.runId, 'root')?.status).toBe('paused')
      expect(h.runs.get(h.runId)?.status).toBe('running')
    } finally {
      h.close()
    }
  })
})

describe('ReworkPolicy · request_changes 触发', () => {
  it('creates a linked ReworkRequest, reruns the target, and completes on approval re-entry', async () => {
    const h = setup(approvalDefinition(2))
    try {
      await drive(h, () => ({}))
      const approvalRun = h.nodes.listByRunAndKey(h.runId, 'approval')[0]
      if (!approvalRun) throw new Error('missing approval node')
      const firstApproval = h.db
        .prepare('SELECT * FROM approvals WHERE node_run_id = ?')
        .get(approvalRun.id) as { id: string; target_node_run_id: string }
      expect(firstApproval.target_node_run_id).toBe(
        h.nodes.listByRunAndKey(h.runId, 'task_1')[0]?.id,
      )

      h.approvalService.decide(approvalRun.id, 'request_changes', {
        decidedBy: 'user-1',
        comment: 'please fix',
      })

      const requests = h.reworks.listByRun(h.runId)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        triggerType: 'request_changes',
        triggerApprovalId: firstApproval.id,
        status: 'in_rework',
        round: 1,
      })
      const linked = h.approvals.get(firstApproval.id)
      expect(linked?.reworkRequestId).toBe(requests[0]?.id)
      expect(h.audit.listByAction('workflow.rework.requested')[0]).toMatchObject({
        actorType: 'user',
        actorId: 'user-1',
        targetType: 'rework_request',
        targetId: requests[0]?.id,
      })
      expect(h.audit.listByAction('workflow.branch.resumed').length).toBeGreaterThanOrEqual(1)
      // 同一决策重复提交：approvals 不新增、ReworkRequest 不重复
      h.approvalService.decide(approvalRun.id, 'request_changes', {
        decidedBy: 'user-1',
        comment: 'please fix',
      })
      expect(h.reworks.listByRun(h.runId)).toHaveLength(1)
      expect(
        h.db.prepare('SELECT COUNT(*) AS count FROM approvals').get() as { count: number },
      ).toEqual({ count: 1 })
      expect(h.nodes.listByRunAndKey(h.runId, 'task_1')).toHaveLength(2)
      expect(h.branches.getByKey(h.runId, 'root')?.status).toBe('active')

      await drive(h, () => ({}))
      expect(h.reworks.get(requests[0]?.id ?? '')?.status).toBe('completed')
      const approvals = h.db
        .prepare('SELECT round, status, target_node_run_id FROM approvals ORDER BY round')
        .all() as { round: number; status: string; target_node_run_id: string }[]
      expect(approvals).toHaveLength(2)
      expect(approvals[1]).toMatchObject({ round: 2, status: 'pending' })
      expect(approvals[1]?.target_node_run_id).toBe(
        h.nodes.listByRunAndKey(h.runId, 'task_1')[1]?.id,
      )
    } finally {
      h.close()
    }
  })
})
