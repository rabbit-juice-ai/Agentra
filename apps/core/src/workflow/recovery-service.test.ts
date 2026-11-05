import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowRecoveryService } from './recovery-service'
import { WorkflowRunQueryService } from './run-query-service'
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

type Harness = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  executions: ExecutionRepository
  definitions: PublishedDefinitionProvider
  scheduler: WorkflowScheduler
  recovery: WorkflowRecoveryService
  query: WorkflowRunQueryService
  runId: string
  close: () => void
}

function setup(
  options: {
    runStatus?: 'running' | 'paused'
    nodeStatus?: 'running' | 'ready'
    backfill?: boolean
  } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-recovery-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const draft = definitionService.createDraft(template.id, definition())
  definitionService.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const executions = new ExecutionRepository(db)
  const run = runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, NOW)
  runs.transition('run-1', ['pending'], 'running', NOW)
  if (options.runStatus === 'paused') runs.transition('run-1', ['running'], 'paused', NOW)
  const branch = branches.create({ id: 'br-root', workflowRunId: run.id, branchKey: 'root' }, NOW)
  nodes.create(
    {
      id: 'nrn-start',
      workflowRunId: run.id,
      workflowNodeKey: 'start',
      branchRunId: branch.id,
      status: 'succeeded',
    },
    NOW,
  )
  nodes.create(
    {
      id: 'nrn-task',
      workflowRunId: run.id,
      workflowNodeKey: 'task_1',
      branchRunId: branch.id,
      status: (options.nodeStatus ?? 'running') as never,
    },
    NOW,
  )
  nodes.create(
    {
      id: 'nrn-end',
      workflowRunId: run.id,
      workflowNodeKey: 'end',
      branchRunId: branch.id,
    },
    NOW,
  )

  const scheduler = new WorkflowScheduler({
    runs,
    branches,
    nodes,
    definitions,
    gates: defaultDispatchGates(allowAllResourcePorts()),
    onNodeStarted: (context) => {
      nodes.transition(context.nodeRun.id, ['running'], 'succeeded', NOW)
    },
    now: () => NOW,
  })
  const recovery = new WorkflowRecoveryService(
    runs,
    branches,
    nodes,
    executions,
    scheduler,
    options.backfill
      ? () => {
          nodes.transition('nrn-task', ['running'], 'succeeded', NOW)
        }
      : undefined,
    undefined,
    undefined,
    () => NOW,
  )
  return {
    db,
    runs,
    branches,
    nodes,
    executions,
    definitions,
    scheduler,
    recovery,
    query: new WorkflowRunQueryService(runs, branches, nodes),
    runId: run.id,
    close: () => db.close(),
  }
}

function bindExecution(
  h: Harness,
  nodeRunId: string,
  status: 'pending' | 'running' | 'succeeded',
): void {
  h.db
    .prepare(
      `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
       VALUES ('prov-1', 'cli', 'P', '{}', 'healthy', ?, ?)`,
    )
    .run(NOW, NOW)
  h.db
    .prepare(
      `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
       VALUES ('ses-1', NULL, 'prov-1', NULL, NULL, 'active', ?, ?, NULL)`,
    )
    .run(NOW, NOW)
  h.db
    .prepare(
      `INSERT INTO executions (id, session_id, node_run_id, provider_id, status, working_directory,
         capabilities_snapshot_json, created_at, updated_at)
       VALUES ('exe-1', 'ses-1', ?, 'prov-1', ?, '/tmp/w', ?, ?, ?)`,
    )
    .run(
      nodeRunId,
      status,
      JSON.stringify({
        streaming: 'native',
        structuredEvents: 'native',
        interrupt: 'native',
        resume: 'native',
        checkpoint: 'unsupported',
        permissionRequests: 'native',
        sessionPersistence: 'native',
        workingDirectory: 'native',
        toolControl: 'native',
      }),
      NOW,
      NOW,
    )
}

describe('WorkflowRecoveryService', () => {
  it('marks a running node without a live execution as reconciliation_required', async () => {
    const h = setup()
    try {
      const report = await h.recovery.recover()
      expect(report.nodesMarkedReconciliationRequired).toEqual([
        { nodeRunId: 'nrn-task', nodeKey: 'task_1', runId: 'run-1' },
      ])
      expect(h.nodes.get('nrn-task')?.status).toBe('reconciliation_required')
      // RPC 可查：恢复状态必须在查询里可见
      const view = h.query.get(h.runId)
      expect(view.nodes.find((node) => node.workflowNodeKey === 'task_1')?.status).toBe(
        'reconciliation_required',
      )
      expect(h.runs.get(h.runId)?.status).toBe('running')
    } finally {
      h.close()
    }
  })

  it('keeps a running node when its execution is still live', async () => {
    const h = setup()
    try {
      bindExecution(h, 'nrn-task', 'running')
      const report = await h.recovery.recover()
      expect(report.nodesMarkedReconciliationRequired).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('running')
    } finally {
      h.close()
    }
  })

  it('re-enqueues ready nodes through the scheduler', async () => {
    const h = setup({ nodeStatus: 'ready' })
    try {
      const report = await h.recovery.recover()
      expect(report.runsKicked).toContain(h.runId)
      expect(h.nodes.get('nrn-task')?.status).toBe('succeeded')
    } finally {
      h.close()
    }
  })

  it('backfills a terminal execution that was not recorded on the node', async () => {
    const h = setup({ backfill: true })
    try {
      bindExecution(h, 'nrn-task', 'succeeded')
      const report = await h.recovery.recover()
      expect(report.nodesMarkedReconciliationRequired).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('succeeded')
    } finally {
      h.close()
    }
  })

  it('does not tick paused runs but still reconciles their running nodes', async () => {
    const h = setup({ runStatus: 'paused' })
    try {
      const report = await h.recovery.recover()
      expect(report.runsKicked).toEqual([])
      expect(report.nodesMarkedReconciliationRequired).toHaveLength(1)
      expect(h.nodes.get('nrn-task')?.status).toBe('reconciliation_required')
    } finally {
      h.close()
    }
  })

  it('is idempotent across repeated startup recovery', async () => {
    const h = setup()
    try {
      await h.recovery.recover()
      const second = await h.recovery.recover()
      expect(second.nodesMarkedReconciliationRequired).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('reconciliation_required')
    } finally {
      h.close()
    }
  })

  it('A4: daemon unavailable marks node AND run reconciliation_required without kicking', async () => {
    const h = setup()
    try {
      bindExecution(h, 'nrn-task', 'running')
      const report = await h.recovery.recover({ daemonAvailable: false })
      expect(report.nodesMarkedReconciliationRequired.map((n) => n.nodeRunId)).toEqual(['nrn-task'])
      expect(report.runsMarkedReconciliationRequired).toEqual([h.runId])
      expect(report.runsKicked).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('reconciliation_required')
      expect(h.runs.get(h.runId)?.status).toBe('reconciliation_required')
    } finally {
      h.close()
    }
  })

  it('A3: unconfirmed execution marks the node but keeps the run running (W2)', async () => {
    const h = setup()
    try {
      bindExecution(h, 'nrn-task', 'running')
      const report = await h.recovery.recover({
        daemonAvailable: true,
        unconfirmedExecutionIds: new Set(['exe-1']),
      })
      expect(report.nodesMarkedReconciliationRequired.map((n) => n.nodeRunId)).toEqual(['nrn-task'])
      expect(report.runsMarkedReconciliationRequired).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('reconciliation_required')
      expect(h.runs.get(h.runId)?.status).toBe('running')
    } finally {
      h.close()
    }
  })

  it('A1: confirmed-active execution keeps the node running', async () => {
    const h = setup()
    try {
      bindExecution(h, 'nrn-task', 'running')
      const report = await h.recovery.recover({
        daemonAvailable: true,
        unconfirmedExecutionIds: new Set(),
      })
      expect(report.nodesMarkedReconciliationRequired).toEqual([])
      expect(h.nodes.get('nrn-task')?.status).toBe('running')
      expect(h.runs.get(h.runId)?.status).toBe('running')
    } finally {
      h.close()
    }
  })
})
