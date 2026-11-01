/**
 * S4-7 真实重启探针：父进程 seed 一个「返工 in_rework」的库，子进程打开后 kill -9，
 * 再起第二个子进程跑 Execution/Workflow 恢复，验证轮次、attempt 与 run 终态。
 *
 * 运行：pnpm exec tsx scripts/s4-7-restart-probe.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { openDatabase } from '../apps/core/src/db/database'
import { migrate } from '../apps/core/src/db/migrations'
import { ApprovalRepository } from '../apps/core/src/db/repositories/approval-repository'
import { BranchRunRepository } from '../apps/core/src/db/repositories/branch-run-repository'
import { ExecutionRepository } from '../apps/core/src/db/repositories/execution-repository'
import { NodeRunRepository } from '../apps/core/src/db/repositories/node-run-repository'
import { ReworkRequestRepository } from '../apps/core/src/db/repositories/rework-request-repository'
import { WorkflowRepository } from '../apps/core/src/db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../apps/core/src/db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../apps/core/src/services/workflow-definition-service'
import { ApprovalService } from '../apps/core/src/workflow/approval-service'
import {
  type ControlNodeDeps,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
} from '../apps/core/src/workflow/control-nodes'
import {
  allowAllResourcePorts,
  defaultDispatchGates,
} from '../apps/core/src/workflow/dispatch-gates'
import { PublishedDefinitionProvider } from '../apps/core/src/workflow/published-definition-provider'
import { WorkflowRecoveryService } from '../apps/core/src/workflow/recovery-service'
import { ReworkService } from '../apps/core/src/workflow/rework-service'
import { WorkflowScheduler } from '../apps/core/src/workflow/scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
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

function definition(): WorkflowDefinition {
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

async function seed(file: string): Promise<void> {
  const db = openDatabase(file)
  try {
    migrate(db)
    db.prepare(
      `INSERT INTO works (id, name, description, objective, status, priority, root_path,
         repository_path, settings_json, created_at, updated_at, completed_at)
       VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
    ).run(NOW, NOW)
    const workflowRepo = new WorkflowRepository(db)
    const service = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    service.publish(draft.id)
    db.prepare(
      `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
       VALUES ('run-1', 'work-1', ?, 'running', ?, '{}', ?, ?)`,
    ).run(draft.id, NOW, NOW, NOW)
    const branch = db.prepare(
      `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
       VALUES (?, 'run-1', ?, ?, ?, ?)`,
    )
    branch.run('br-root', 'root', 'active', NOW, NOW)
    branch.run('br-ui', 'split_1/ui', 'blocked', NOW, NOW)
    branch.run('br-api', 'split_1/api', 'blocked', NOW, NOW)
    const nodeRun = db.prepare(
      `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
         input_snapshot_json, output_snapshot_json, created_at, updated_at)
       VALUES (?, 'run-1', ?, ?, 'blocked', 1, '{}', NULL, ?, ?)`,
    )
    nodeRun.run('nrn-start', 'start', 'br-root', NOW, NOW)
    nodeRun.run('nrn-split', 'split_1', 'br-root', NOW, NOW)
    nodeRun.run('nrn-ui-1', 'ui', 'br-ui', NOW, NOW)
    nodeRun.run('nrn-api-1', 'api', 'br-api', NOW, NOW)
    nodeRun.run('nrn-join-1', 'join', 'br-root', NOW, NOW)
    nodeRun.run('nrn-testing-1', 'testing', 'br-root', NOW, NOW)
    nodeRun.run('nrn-end', 'end', 'br-root', NOW, NOW)

    // 真实 S4-6 流程推进到「测试失败、返工 in_rework」，而不是手写返工行。
    const r = runtime(db)
    const scheduler = schedulerFor(db, r, (attempt) => attempt > 1)
    for (let tick = 0; tick < 30; tick += 1) {
      await scheduler.tick('run-1')
      if (r.reworks.listByRun('run-1').some((request) => request.status === 'in_rework')) break
    }
    const active = r.reworks.listByRun('run-1')
    if (active.length !== 1 || active[0]?.status !== 'in_rework') {
      throw new Error(`failed to reach in_rework: ${JSON.stringify(active)}`)
    }
  } finally {
    db.close()
  }
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

function runtime(db: ReturnType<typeof openDatabase>): Runtime {
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

function controlDeps(db: ReturnType<typeof openDatabase>, r: Runtime): ControlNodeDeps {
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

function schedulerFor(
  db: ReturnType<typeof openDatabase>,
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
                  failureReason: testingPass(context.nodeRun.attempt) ? '' : 'ui broken',
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
        default:
          throw new Error(`unexpected node type ${context.node.type}`)
      }
    },
    now: () => NOW,
  })
}

async function recover(file: string): Promise<void> {
  const db = openDatabase(file)
  try {
    const r = runtime(db)
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
    const recovery = new WorkflowRecoveryService(
      r.runs,
      r.branches,
      r.nodes,
      new ExecutionRepository(db),
      schedulerFor(db, r, () => true),
      undefined,
      undefined,
      undefined,
      () => NOW,
    )
    await recovery.recover()
    const requests = r.reworks.listByRun('run-1')
    const summary = {
      repeatedRequestIds: repeated.map((request) => request.id),
      reworkId: requests[0]?.id,
      reworkCount: requests.length,
      reworkStatus: requests[0]?.status,
      reworkRound: requests[0]?.round,
      runStatus: r.runs.get('run-1')?.status,
      apiAttempts: r.nodes.listByRunAndKey('run-1', 'api').map((nodeRun) => nodeRun.attempt),
      uiAttempts: r.nodes.listByRunAndKey('run-1', 'ui').map((nodeRun) => nodeRun.attempt),
      joinAttempts: r.nodes.listByRunAndKey('run-1', 'join').map((nodeRun) => nodeRun.attempt),
      testingAttempts: r.nodes
        .listByRunAndKey('run-1', 'testing')
        .map((nodeRun) => nodeRun.attempt),
    }
    process.stdout.write(`RECOVERY_RESULT ${JSON.stringify(summary)}\n`)
  } finally {
    db.close()
  }
}

async function child(file: string): Promise<void> {
  const db = openDatabase(file)
  db.prepare('SELECT 1').get()
  process.stdout.write('CHILD_READY\n')
  // 保持进程存活，等父进程 SIGKILL（真实 kill -9，不走 graceful shutdown）。
  setInterval(() => {}, 1000)
}

function runChild(
  args: string[],
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const script = fileURLToPath(import.meta.url)
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: path.dirname(path.dirname(script)),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('CHILD_READY') && args[0] === '--child') {
        setTimeout(() => proc.kill('SIGKILL'), 100)
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-s4-7-probe-'))
  const file = path.join(dir, 'agentra.db')
  await seed(file)
  const killed = await runChild(['--child', file])
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`child did not die by SIGKILL: ${JSON.stringify(killed)}`)
  }
  const recovered = await runChild(['--recover', file])
  const line = recovered.stdout.split('\n').find((entry) => entry.startsWith('RECOVERY_RESULT '))
  if (!line) throw new Error(`missing recovery result: ${JSON.stringify(recovered)}`)
  const summary = JSON.parse(line.slice('RECOVERY_RESULT '.length)) as Record<string, unknown>
  const expected = {
    repeatedRequestIds: [summary.reworkId],
    reworkId: summary.reworkId,
    reworkCount: 1,
    reworkStatus: 'completed',
    reworkRound: 1,
    runStatus: 'completed',
    apiAttempts: [1],
    uiAttempts: [1, 2],
    joinAttempts: [1, 2],
    testingAttempts: [1, 2],
  }
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new Error(`unexpected summary: ${JSON.stringify(summary)}`)
  }
  console.log(`KILL9_SIGNAL=${killed.signal}`)
  console.log(`RECOVERY_RESULT=${JSON.stringify(summary)}`)
  console.log('S4_7_RESTART_PROBE_PASS')
  fs.rmSync(dir, { recursive: true, force: true })
}

const mode = process.argv[2]
if (mode === '--child') {
  void child(process.argv[3] as string)
} else if (mode === '--recover') {
  void recover(process.argv[3] as string)
} else {
  void main()
}
