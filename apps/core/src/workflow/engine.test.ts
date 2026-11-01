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
import { WorkflowEventRepository } from '../db/repositories/workflow-event-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalService } from './approval-service'
import { WorkflowAssignmentResolver } from './assignment-resolver'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { WorkflowEngine } from './engine'
import { WorkflowEventRecorder } from './event-recorder'
import type { WorkflowExecutionBridge } from './execution-bridge'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { ReworkService } from './rework-service'
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

function setup(): {
  db: Database
  engine: WorkflowEngine
  scheduler: WorkflowScheduler
  nodes: NodeRunRepository
  runs: WorkflowRunRepository
  events: WorkflowEventRepository
  runId: string
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-engine-'))
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
  const service = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = service.createTemplate({ name: 't' })
  const draft = service.createDraft(template.id, definition())
  service.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const reworks = new ReworkRequestRepository(db)
  const approvals = new ApprovalRepository(db)
  const run = runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, NOW)
  runs.transition('run-1', ['pending'], 'running', NOW)
  const branch = branches.create({ id: 'br-root', workflowRunId: run.id, branchKey: 'root' }, NOW)
  for (const [id, key] of [
    ['nrn-start', 'start'],
    ['nrn-task', 'task_1'],
    ['nrn-end', 'end'],
  ] as const) {
    nodes.create({ id, workflowRunId: run.id, workflowNodeKey: key, branchRunId: branch.id }, NOW)
  }

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
  const approvalService = new ApprovalService(db, approvals, nodes, branches, () => NOW, rework)
  const events = new WorkflowEventRepository(db)
  const recorder = new WorkflowEventRecorder(events, () => NOW)
  const bridge = {
    onNodeStarted: async () => {},
    onExecutionFinished: () => {
      nodes.transition('nrn-task', ['running'], 'succeeded', NOW)
    },
  } as unknown as WorkflowExecutionBridge

  let engine: WorkflowEngine | undefined
  const scheduler = new WorkflowScheduler({
    runs,
    branches,
    nodes,
    definitions,
    gates: defaultDispatchGates(allowAllResourcePorts()),
    onNodeStarted: (context) => engine?.onNodeStarted(context),
    now: () => NOW,
  })
  engine = new WorkflowEngine({
    db,
    runs,
    branches,
    nodes,
    definitions,
    approvals: approvalService,
    scheduler,
    bridge,
    rework,
    executions: { getNodeRunId: () => 'nrn-task' },
    eventSink: recorder,
    runService: new WorkflowRunService(
      db,
      runs,
      branches,
      nodes,
      new WorkRepository(db),
      definitions,
      new WorkflowAssignmentResolver(new AssignmentRepository(db)),
      () => NOW,
    ),
    now: () => NOW,
  })
  return { db, engine, scheduler, nodes, runs, events, runId: run.id, close: () => db.close() }
}

describe('WorkflowEngine 装配', () => {
  it('dispatches control nodes and advances downstream after execution completion', async () => {
    const h = setup()
    try {
      await h.scheduler.runUntilIdle(h.runId)
      expect(h.nodes.get('nrn-start')?.status).toBe('succeeded')
      expect(h.nodes.get('nrn-task')?.status).toBe('running')
      expect(h.nodes.get('nrn-end')?.status).toBe('blocked')

      h.engine.onExecutionFinished({ id: 'exe-1' } as Execution)
      await h.engine.kick(h.runId)

      expect(h.nodes.get('nrn-task')?.status).toBe('succeeded')
      expect(h.nodes.get('nrn-end')?.status).toBe('succeeded')
      expect(h.runs.get(h.runId)?.status).toBe('completed')
      expect(h.events.listByRun(h.runId).map((event) => event.eventType)).toEqual([
        'workflow.completed',
      ])

      // 重复推进不得重复写事件
      await h.engine.kick(h.runId)
      expect(h.events.listByRun(h.runId)).toHaveLength(1)
    } finally {
      h.close()
    }
  })
})
