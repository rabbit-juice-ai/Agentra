import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ReworkRequestRepository } from '../db/repositories/rework-request-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalService } from './approval-service'
import {
  type ControlNodeDeps,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
} from './control-nodes'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowRecoveryService } from './recovery-service'
import { ReworkService } from './rework-service'
import { WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const settings = {
  defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
  reworkPolicy: { maxRounds: 2 },
  failureStrategy: 'fail_branch',
  concurrency: { maxParallelNodes: 4 },
}

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

function referenceDefinition(): WorkflowDefinition {
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
    settings,
  } as unknown as WorkflowDefinition
}

type Runtime = {
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  reworks: ReworkRequestRepository
  approvals: ApprovalRepository
  approvalService: ApprovalService
  definitions: PublishedDefinitionProvider
  rework: ReworkService
}

function runtime(db: Database): Runtime {
  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const reworks = new ReworkRequestRepository(db)
  const approvals = new ApprovalRepository(db)
  const definitions = new PublishedDefinitionProvider(new WorkflowRepository(db))
  const rework = new ReworkService({
    db,
    runs,
    branches,
    nodes,
    reworks,
    approvals,
    definitions,
    now: () => NOW,
  })
  return {
    runs,
    branches,
    nodes,
    reworks,
    approvals,
    approvalService: new ApprovalService(db, approvals, nodes, branches, () => NOW, rework),
    definitions,
    rework,
  }
}

function controlDeps(db: Database, r: Runtime): ControlNodeDeps {
  return {
    db,
    runs: r.runs,
    branches: r.branches,
    nodes: r.nodes,
    definitions: r.definitions,
    approvals: r.approvalService,
    reworkTrigger: r.rework,
    now: () => NOW,
  }
}

function makeScheduler(
  db: Database,
  r: Runtime,
  testingPass: (attempt: number) => boolean,
): WorkflowScheduler {
  return new WorkflowScheduler({
    runs: r.runs,
    branches: r.branches,
    nodes: r.nodes,
    definitions: r.definitions,
    gates: defaultDispatchGates(allowAllResourcePorts()),
    onNodeStarted: (context) => {
      const nodeRunId = context.nodeRun.id
      switch (context.node.type) {
        case 'start':
          completeStartNode(controlDeps(db, r), nodeRunId)
          break
        case 'parallel_split':
          completeSplitNode(controlDeps(db, r), nodeRunId)
          break
        case 'join':
          completeJoinNode(controlDeps(db, r), nodeRunId)
          break
        case 'end':
          completeEndNode(controlDeps(db, r), nodeRunId)
          break
        case 'agent_task': {
          const output =
            context.node.key === 'testing'
              ? {
                  pass: testingPass(context.nodeRun.attempt),
                  failureReason: testingPass(context.nodeRun.attempt) ? '' : 'still broken',
                  relatedTasks: testingPass(context.nodeRun.attempt) ? [] : ['ui'],
                  impactScope: 'ui',
                  relatedArtifacts: [],
                }
              : {}
          r.nodes.transition(nodeRunId, ['running'], 'succeeded', NOW, {
            outputSnapshot: output,
          })
          if (context.node.key === 'testing') {
            r.rework.onTestResult({
              runId: context.run.id,
              reportNodeRunId: nodeRunId,
              reportNodeKey: 'testing',
              output,
            })
          }
          break
        }
        case 'condition':
        case 'human_approval':
          throw new Error(`unexpected node type ${context.node.type}`)
      }
    },
    now: () => NOW,
  })
}

function seedMidRework(db: Database): void {
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const workflowRepo = new WorkflowRepository(db)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const draft = definitionService.createDraft(template.id, referenceDefinition())
  definitionService.publish(draft.id)

  db.prepare(
    `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
     VALUES ('run-1', 'work-1', ?, 'running', ?, '{}', ?, ?)`,
  ).run(draft.id, NOW, NOW, NOW)

  const branch = (id: string, key: string, status: string) =>
    db
      .prepare(
        `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
         VALUES (?, 'run-1', ?, ?, ?, ?)`,
      )
      .run(id, key, status, NOW, NOW)
  branch('br-root', 'root', 'active')
  branch('br-ui', 'split_1/ui', 'completed')
  branch('br-api', 'split_1/api', 'completed')
  branch('br-rwk', 'split_1/ui#rwk-1-testreq1', 'active')

  const nodeRun = (
    id: string,
    key: string,
    branchId: string,
    status: string,
    attempt: number,
    output: Record<string, unknown> | null = null,
  ) =>
    db
      .prepare(
        `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
           input_snapshot_json, output_snapshot_json, created_at, updated_at)
         VALUES (?, 'run-1', ?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        id,
        key,
        branchId,
        status,
        attempt,
        output === null ? null : JSON.stringify(output),
        NOW,
        NOW,
      )

  nodeRun('nrn-start', 'start', 'br-root', 'succeeded', 1)
  nodeRun('nrn-split', 'split_1', 'br-root', 'succeeded', 1)
  nodeRun('nrn-ui-1', 'ui', 'br-ui', 'succeeded', 1)
  nodeRun('nrn-api-1', 'api', 'br-api', 'succeeded', 1)
  nodeRun('nrn-join-1', 'join', 'br-root', 'succeeded', 1)
  nodeRun('nrn-testing-1', 'testing', 'br-root', 'succeeded', 1, {
    pass: false,
    failureReason: 'ui broken',
    relatedTasks: ['ui'],
    impactScope: 'ui',
    relatedArtifacts: [],
  })
  nodeRun('nrn-ui-2', 'ui', 'br-rwk', 'blocked', 2)
  nodeRun('nrn-join-2', 'join', 'br-root', 'blocked', 2)
  nodeRun('nrn-testing-2', 'testing', 'br-root', 'blocked', 2)
  nodeRun('nrn-end', 'end', 'br-root', 'blocked', 1)

  db.prepare(
    `INSERT INTO rework_requests (
       id, workflow_run_id, branch_run_id, target_node_run_id, trigger_type, test_report_json,
       round, max_rounds, status, rework_node_run_id, created_by, created_at, updated_at
     ) VALUES ('rwk-testreq1', 'run-1', 'br-ui', 'nrn-ui-1', 'test_failure', ?, 1, 2,
               'in_rework', 'nrn-ui-2', 'system', ?, ?)`,
  ).run(
    JSON.stringify({
      pass: false,
      failureReason: 'ui broken',
      relatedTasks: ['ui'],
      impactScope: 'ui',
      relatedArtifacts: [],
      reportNodeKey: 'testing',
      scopeEndNodeKey: 'testing',
    }),
    NOW,
    NOW,
  )
}

describe('S4-7 G · 返工重启恢复', () => {
  it('keeps rounds, does not duplicate in_rework, and does not rerun completed side-effect tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-restart-'))
    dirs.push(dir)
    const file = path.join(dir, 'agentra.db')
    const first = openDatabase(file)
    migrate(first)
    seedMidRework(first)
    first.close() // 模拟进程退出；SQLite WAL 已提交

    const db = openDatabase(file)
    try {
      const r = runtime(db)
      // 重启后重复触发同一份报告：in_rework 已存在，不得重复创建
      const repeated = r.rework.requestForTestFailure({
        runId: 'run-1',
        reportNodeRunId: 'nrn-testing-1',
        reportNodeKey: 'testing',
        report: {
          pass: false,
          failureReason: 'ui broken',
          relatedTasks: ['ui'],
          impactScope: 'ui',
          relatedArtifacts: [],
        },
      })
      expect(repeated.map((request) => request.id)).toEqual(['rwk-testreq1'])
      expect(r.reworks.listByRun('run-1')).toHaveLength(1)

      const scheduler = makeScheduler(db, r, () => true)
      const recovery = new WorkflowRecoveryService(
        r.runs,
        r.branches,
        r.nodes,
        new ExecutionRepository(db),
        scheduler,
        undefined,
        undefined,
        () => NOW,
      )
      const report = await recovery.recover()
      expect(report.nodesMarkedReconciliationRequired).toEqual([])

      // 轮次计数不丢：仍是 round 1，且已完成
      const requests = r.reworks.listByRun('run-1')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ round: 1, status: 'completed' })

      // 已完成副作用任务不重跑：api 仍 attempt 1；返工目标 ui / 必要下游 join/testing 新 attempt
      expect(r.nodes.listByRunAndKey('run-1', 'api').map((node) => node.attempt)).toEqual([1])
      expect(r.nodes.listByRunAndKey('run-1', 'ui').map((node) => node.attempt)).toEqual([1, 2])
      expect(r.nodes.listByRunAndKey('run-1', 'join').map((node) => node.attempt)).toEqual([1, 2])
      expect(r.nodes.listByRunAndKey('run-1', 'testing').map((node) => node.attempt)).toEqual([
        1, 2,
      ])
      expect(r.runs.get('run-1')?.status).toBe('completed')
    } finally {
      db.close()
    }
  })

  it('increments the persisted round after restart instead of resetting to 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-restart-round-'))
    dirs.push(dir)
    const file = path.join(dir, 'agentra.db')
    const first = openDatabase(file)
    migrate(first)
    seedMidRework(first)
    first.close()

    const db = openDatabase(file)
    try {
      const r = runtime(db)
      // attempt 2 仍失败 → round 2；attempt 3 通过 → round 2 完成，run 结束
      const scheduler = makeScheduler(db, r, (attempt) => attempt >= 3)
      const recovery = new WorkflowRecoveryService(
        r.runs,
        r.branches,
        r.nodes,
        new ExecutionRepository(db),
        scheduler,
        undefined,
        undefined,
        () => NOW,
      )
      await recovery.recover()

      const requests = r.reworks.listByRun('run-1').sort((left, right) => left.round - right.round)
      expect(requests.map((request) => [request.round, request.status])).toEqual([
        [1, 'completed'],
        [2, 'completed'],
      ])
      expect(r.nodes.listByRunAndKey('run-1', 'ui').map((node) => node.attempt)).toEqual([1, 2, 3])
      expect(r.nodes.listByRunAndKey('run-1', 'testing').map((node) => node.attempt)).toEqual([
        1, 2, 3,
      ])
      expect(r.runs.get('run-1')?.status).toBe('completed')
    } finally {
      db.close()
    }
  })
})
