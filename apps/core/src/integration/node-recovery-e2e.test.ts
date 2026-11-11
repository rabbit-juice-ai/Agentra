import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION,
  type RpcResponse,
  WORKFLOW_NODE_RECOVERY_START_METHOD,
} from '@agentra/protocol'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { computeChecksum, type WorkflowDefinition } from '@agentra/workflow-schema'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { probeSocket } from '../daemon-launcher'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { CheckpointRepository } from '../db/repositories/checkpoint-repository'
import {
  TeamTaskMessageRepository,
  TeamTaskRunRepository,
} from '../db/repositories/collaboration-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { CheckpointService } from '../services/checkpoint-service'
import { TaskMemoryService } from '../services/task-memory-service'
import { WorktreeService } from '../services/worktree-service'

const CORE_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url))
const CLI_FIXTURE = fileURLToPath(new URL('./node-recovery-agent-fixture.mjs', import.meta.url))
const NOW = '2026-11-11T00:00:00.000Z'
const dirs: string[] = []
const cores: ChildProcess[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
}

function spawnCore(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', CORE_ENTRY], {
    env: { ...process.env, AGENTRA_DATA_DIR: dataDir, AGENTRA_CLAUDE_PATH: CLI_FIXTURE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  cores.push(child)
  return child
}

function call(
  socketPath: string,
  method: string,
  params: unknown,
  timeoutMs = 60_000,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:`)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`rpc ${method} timed out`))
    }, timeoutMs)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
          protocolVersion: PROTOCOL_VERSION,
          method,
          params,
        }),
      ),
    )
    ws.on('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(String(data)) as RpcResponse)
      ws.close()
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

function stopDaemon(dataDir: string): void {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'runtime', 'daemon.pid'), 'utf8')
    const { pid } = JSON.parse(raw) as { pid?: number }
    if (typeof pid === 'number') process.kill(pid, 'SIGTERM')
  } catch {
    // daemon 未启动或已退出。
  }
}

afterAll(async () => {
  for (const core of cores.splice(0)) {
    if (core.exitCode === null && core.signalCode === null) core.kill('SIGTERM')
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const dir of dirs.splice(0)) {
    stopDaemon(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const CAPABILITIES = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'unsupported',
  checkpoint: 'unsupported',
  permissionRequests: 'unsupported',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
}

const TOOL_POLICY = {
  version: 1,
  allow: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  deny: [],
}

function seed(dataDir: string, repoDir: string): { checkpointId: string } {
  const paths = agentraPaths(dataDir)
  ensureDirs(paths)
  const db = openDatabase(paths.database)
  migrate(db)
  db.prepare(
    `INSERT INTO runtime_providers (
       id, provider_type, provider_name, executable_path, version, capabilities_json,
       health_status, last_discovered_at, created_at, updated_at
     ) VALUES ('claude-code', 'cli', 'Claude Code', ?, '9.9.9', ?, 'healthy', ?, ?, ?)`,
  ).run(CLI_FIXTURE, JSON.stringify(CAPABILITIES), NOW, NOW, NOW)
  db.prepare(
    `INSERT INTO agent_profiles (
       id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
       model, tool_permissions_json, default_provider_id, max_concurrency, status,
       created_at, updated_at, archived_at
     ) VALUES ('agt-rec', 'Recovery Worker', '🤖', '', '', '[]', 'edit', NULL, NULL,
       ?, 'claude-code', 5, 'active', ?, ?, NULL)`,
  ).run(JSON.stringify(TOOL_POLICY), NOW, NOW)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-rec', 'Recovery Work', '', '', 'active', 'normal', ?, ?, '{}', ?, ?, NULL)`,
  ).run(repoDir, repoDir, NOW, NOW)

  const assignmentRepository = new AssignmentRepository(db)
  assignmentRepository.insert({
    id: 'asg-rec',
    workId: 'work-rec',
    agentId: 'agt-rec',
    teamId: null,
    workRole: 'dev',
    taskScope: '',
    status: 'active',
    concurrencyLimit: null,
    contextRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const sessionRepository = new SessionRepository(db)
  sessionRepository.create({
    id: 'ses-seed',
    assignmentId: 'asg-rec',
    providerId: 'claude-code',
    externalSessionId: 'ext-seed',
    contextRef: 'agt-rec',
    status: 'ended',
    createdAt: NOW,
    updatedAt: NOW,
    lastActiveAt: NOW,
  })
  const executionRepository = new ExecutionRepository(db)
  executionRepository.create({
    id: 'exe-seed',
    sessionId: 'ses-seed',
    providerId: 'claude-code',
    agentId: 'agt-rec',
    externalExecutionId: 'ext-exe-seed',
    processId: null,
    status: 'succeeded',
    workingDirectory: repoDir,
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    capabilities: CAPABILITIES as never,
    createdAt: NOW,
    updatedAt: NOW,
  })

  const workRepository = new WorkRepository(db)
  const audit = new AuditRepository(db)
  const taskMemories = new TaskMemoryService({
    db,
    memories: new TaskMemoryRepository(db),
    audit,
    now: () => NOW,
  })
  const worktrees = new WorktreeService(
    db,
    workRepository,
    assignmentRepository,
    paths.worktrees,
    () => NOW,
  )
  const checkpointService = new CheckpointService({
    db,
    checkpoints: new CheckpointRepository(db),
    works: workRepository,
    executions: executionRepository,
    sessions: sessionRepository,
    assignments: assignmentRepository,
    nodes: new NodeRunRepository(db),
    teamRuns: new TeamTaskRunRepository(db),
    workflowRuns: new WorkflowRunRepository(db),
    artifacts: new ArtifactRepository(db),
    logs: new ExecutionLogRepository(db),
    audit,
    agents: new AgentRepository(db),
    taskMemories,
    worktrees,
    teamMessages: new TeamTaskMessageRepository(db),
    artifactsRoot: paths.artifacts,
    now: () => NOW,
  })
  const checkpoint = checkpointService.createForExecution('exe-seed', 'generic')
  if (!checkpoint.checkpointId) {
    throw new Error(`seed checkpoint failed: ${JSON.stringify(checkpoint)}`)
  }

  const definition = {
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
          taskPrompt: 'TASK_RECOVER_WITH_ARTIFACT',
          inputArtifactRefs: [],
          artifacts: [{ name: 'spec', type: 'markdown', required: true }],
          workingDirectoryPolicy: 'worktree',
          outputContract: { profile: 'generic', fields: [] },
        },
      },
      {
        key: 'task_2',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 2 },
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'TASK_FOLLOWUP',
          inputArtifactRefs: [],
          artifacts: [],
          workingDirectoryPolicy: 'work_root',
          outputContract: { profile: 'generic', fields: [] },
        },
      },
      { key: 'end', type: 'end', label: '', position: { x: 0, y: 3 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'task_2' },
      { key: 'e3', source: 'task_2', target: 'end' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  }
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES ('tpl-rec', 'Recovery', '', '', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json,
       checksum, status, created_at, published_at)
     VALUES ('wfv-rec', 'tpl-rec', 1, 1, ?, ?, 'published', ?, ?)`,
  ).run(
    JSON.stringify(definition),
    computeChecksum(definition as unknown as WorkflowDefinition),
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, ended_at,
       runtime_state_json, created_at, updated_at)
     VALUES ('run-rec', 'work-rec', 'wfv-rec', 'reconciliation_required', ?, NULL, '{}', ?, ?)`,
  ).run(NOW, NOW, NOW)
  db.prepare(
    `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
     VALUES ('brn-rec', 'run-rec', 'root', 'active', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
       input_snapshot_json, output_snapshot_json, created_at, updated_at)
     VALUES ('nrn-rec', 'run-rec', 'task_1', 'brn-rec', 'reconciliation_required', 1,
       '{}', NULL, ?, ?)`,
  ).run(NOW, NOW)
  for (const [id, key] of [
    ['nrn-t2', 'task_2'],
    ['nrn-end', 'end'],
  ] as const) {
    db.prepare(
      `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
         input_snapshot_json, output_snapshot_json, created_at, updated_at)
       VALUES (?, 'run-rec', ?, 'brn-rec', 'blocked', 1, '{}', NULL, ?, ?)`,
    ).run(id, key, NOW, NOW)
  }
  db.close()
  return { checkpointId: checkpoint.checkpointId }
}

function seedInterruptedRecovery(dataDir: string, repoDir: string, checkpointId: string): void {
  const db = openDatabase(path.join(dataDir, 'agentra.db'))
  try {
    db.prepare(
      `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
         context_ref, status, created_at, updated_at, last_active_at)
       VALUES ('ses-crash', 'asg-rec', 'claude-code', 'ext-crash', 'agt-rec', 'active', ?, ?, ?)`,
    ).run(NOW, NOW, NOW)
    db.prepare(
      `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
         input_snapshot_json, output_snapshot_json, created_at, updated_at)
       VALUES ('nrn-crash', 'run-rec', 'task_1', 'brn-rec', 'running', 2, '{}', NULL, ?, ?)`,
    ).run(NOW, NOW)
    db.prepare(
      `INSERT INTO executions (id, session_id, node_run_id, provider_id, external_execution_id,
         process_id, status, working_directory, started_at, ended_at, exit_code,
         capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
       VALUES ('exe-crash', 'ses-crash', 'nrn-crash', 'claude-code', 'ext-exe-crash', NULL, 'pending',
         ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(repoDir, JSON.stringify(CAPABILITIES), NOW, NOW)
    db.prepare(
      `INSERT INTO task_recovery_attempts (
         id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
         attempt_no, status, risk_level, eligibility_status, original_work_status,
         reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
         execution_id, session_id, team_run_id, node_run_id, workflow_run_id,
         branch_run_id, recovered_node_run_id, chain_attempt_no,
         error_json, created_at, updated_at, started_at, ended_at
       ) VALUES ('rec-crash', 'work-rec', ?, 'workflow_node', 'workflow_node:nrn-rec',
         'workflow_node:nrn-rec:1', 'idem-crash', 1, 'running', 'low', 'eligible', NULL, NULL,
         '{}', 'hash', '{}', 'exe-crash', 'ses-crash', NULL, 'nrn-crash', 'run-rec', 'brn-rec',
         'nrn-rec', 1, NULL, ?, ?, ?, NULL)`,
    ).run(checkpointId, NOW, NOW, NOW)
  } finally {
    db.close()
  }
}

function seedT2Crash(dataDir: string, checkpointId: string): void {
  const db = openDatabase(path.join(dataDir, 'agentra.db'))
  try {
    db.prepare(
      `INSERT INTO task_recovery_attempts (
         id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
         attempt_no, status, risk_level, eligibility_status, original_work_status,
         reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
         execution_id, session_id, team_run_id, node_run_id, workflow_run_id,
         branch_run_id, recovered_node_run_id, chain_attempt_no,
         error_json, created_at, updated_at, started_at, ended_at
       ) VALUES ('rec-t2-crash', 'work-rec', ?, 'workflow_node', 'workflow_node:nrn-rec',
         'workflow_node:nrn-rec:1', 'idem-t2-crash', 1, 'starting', 'low', 'eligible', NULL, NULL,
         '{}', 'hash', ?, NULL, NULL, NULL, NULL, 'run-rec', 'brn-rec', 'nrn-rec', 1, NULL, ?, ?, NULL, NULL)`,
    ).run(
      checkpointId,
      JSON.stringify({
        worktree: {
          state: 'creating',
          worktreeId: 'wt-t2-crash',
          worktreePath: path.join(dataDir, 'never-created', 'wt-t2-crash'),
          branchName: 'agentra/run-rec/task-1/t2-crash',
          newNodeRunId: 'nrn-t2-crash',
          worktreeOwnerToken: 'owner-t2',
          workflowRunId: 'run-rec',
          workId: 'work-rec',
        },
      }),
      NOW,
      NOW,
    )
  } finally {
    db.close()
  }
}

function seedT2Worktree(
  dataDir: string,
  checkpointId: string,
  options: {
    attemptId: string
    idempotencyKey: string
    chainAttemptNo: number
    state: 'ready' | 'creating'
  },
): void {
  const paths = agentraPaths(dataDir)
  const db = openDatabase(paths.database)
  try {
    const workRepository = new WorkRepository(db)
    const worktrees = new WorktreeService(
      db,
      workRepository,
      new AssignmentRepository(db),
      paths.worktrees,
      () => NOW,
    )
    const record = worktrees.create({
      workId: 'work-rec',
      branchName: `agentra/t2-${options.state}`,
    })
    if (!record.baseCommit) throw new Error('worktree base commit missing')
    const commonRaw = execFileSync(
      'git',
      ['-C', record.worktreePath, 'rev-parse', '--git-common-dir'],
      {
        encoding: 'utf8',
      },
    ).trim()
    const gitCommonDir = fs.realpathSync(path.resolve(record.worktreePath, commonRaw))
    const facts = {
      state: options.state,
      worktreeId: record.id,
      worktreePath: fs.realpathSync(record.worktreePath),
      branchName: record.branchName,
      baseCommit: record.baseCommit,
      gitCommonDir,
      registeredWorktreePath: fs.realpathSync(record.worktreePath),
      worktreeOwnerToken: `owner-${options.attemptId}`,
      newNodeRunId: `nrn-${options.attemptId}`,
      workflowRunId: 'run-rec',
      workId: 'work-rec',
    }
    db.prepare(
      `INSERT INTO task_recovery_attempts (
         id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
         attempt_no, status, risk_level, eligibility_status, original_work_status,
         reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
         execution_id, session_id, team_run_id, node_run_id, workflow_run_id,
         branch_run_id, recovered_node_run_id, chain_attempt_no,
         error_json, created_at, updated_at, started_at, ended_at
       ) VALUES (?, 'work-rec', ?, 'workflow_node', 'workflow_node:nrn-rec',
         ?, ?, 1, 'starting', 'low', 'eligible', NULL, NULL,
         '{}', 'hash', ?, NULL, NULL, NULL, NULL, 'run-rec', 'brn-rec', 'nrn-rec', ?, NULL, ?, ?, NULL, NULL)`,
    ).run(
      options.attemptId,
      checkpointId,
      `workflow_node:nrn-rec:${options.chainAttemptNo}`,
      options.idempotencyKey,
      JSON.stringify({ worktree: facts }),
      options.chainAttemptNo,
      NOW,
      NOW,
    )
  } finally {
    db.close()
  }
}

describe('workflow node recovery end-to-end (real Core + Daemon + fake CLI)', () => {
  it('recovers a reconciliation-required node, commits an artifact and succeeds the attempt', async () => {
    const dataDir = tempDir('a-nr-e2e-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    spawnCore(dataDir)

    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)
    const startResponse = await call(coreSocket, WORKFLOW_NODE_RECOVERY_START_METHOD, {
      workflowRunId: 'run-rec',
      nodeRunId: 'nrn-rec',
      checkpointId,
      confirm: true,
      idempotencyKey: 'idem-e2e',
    })
    expect(startResponse.ok).toBe(true)
    if (!startResponse.ok) throw new Error(JSON.stringify(startResponse.error))

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare("SELECT status FROM task_recovery_attempts WHERE idempotency_key = 'idem-e2e'")
          .get() as { status?: string } | undefined
        return row?.status === 'succeeded' || row?.status === 'failed'
      }, 60_000)
      const attempt = db
        .prepare(
          "SELECT status, error_json, node_run_id, execution_id FROM task_recovery_attempts WHERE idempotency_key = 'idem-e2e'",
        )
        .get() as {
        status: string
        error_json: string | null
        node_run_id: string
        execution_id: string
      }
      const diagnostics = db
        .prepare(
          `SELECT
             (SELECT error_json FROM node_runs WHERE id = ?) AS nodeError,
             (SELECT GROUP_CONCAT(content, ' | ') FROM (
                SELECT content FROM execution_logs WHERE execution_id = ? ORDER BY sequence_no DESC LIMIT 8
              )) AS logs`,
        )
        .get(attempt.node_run_id, attempt.execution_id) as {
        nodeError: string | null
        logs: string | null
      }
      expect(
        attempt.status,
        JSON.stringify({
          attemptError: attempt.error_json,
          nodeError: diagnostics.nodeError,
          logs: diagnostics.logs,
        }),
      ).toBe('succeeded')

      const nodeRun = db
        .prepare('SELECT status FROM node_runs WHERE id = ?')
        .get(attempt.node_run_id) as { status: string }
      expect(nodeRun.status).toBe('succeeded')
      const oldNode = db
        .prepare("SELECT status, error_json FROM node_runs WHERE id = 'nrn-rec'")
        .get() as { status: string; error_json: string | null }
      expect(oldNode.status).toBe('failed')
      expect(oldNode.error_json).toContain('recovery_superseded')

      const artifacts = db
        .prepare(
          'SELECT COUNT(*) AS c FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id',
        )
        .get() as { c: number }
      expect(artifacts.c).toBeGreaterThan(0)
      const checkpoint = db
        .prepare(
          "SELECT COUNT(*) AS c FROM task_checkpoints WHERE execution_id = ? AND node_run_id = ? AND state = 'valid'",
        )
        .get(attempt.execution_id, attempt.node_run_id) as { c: number }
      expect(checkpoint.c).toBeGreaterThan(0)

      await waitFor(async () => {
        const run = db.prepare("SELECT status FROM workflow_runs WHERE id = 'run-rec'").get() as {
          status: string
        }
        return run.status === 'completed'
      }, 60_000)
      const run = db.prepare("SELECT status FROM workflow_runs WHERE id = 'run-rec'").get() as {
        status: string
      }
      expect(run.status).toBe('completed')

      const task1Attempts = db
        .prepare(
          "SELECT attempt, status FROM node_runs WHERE workflow_node_key = 'task_1' ORDER BY attempt",
        )
        .all() as { attempt: number; status: string }[]
      expect(task1Attempts).toEqual([
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'succeeded' },
      ])
      const task2 = db
        .prepare(
          "SELECT status, COUNT(*) OVER () AS c FROM node_runs WHERE workflow_node_key = 'task_2'",
        )
        .get() as { status: string; c: number }
      expect(task2).toMatchObject({ status: 'succeeded', c: 1 })
      const task2Executions = db
        .prepare("SELECT COUNT(*) AS c FROM executions WHERE node_run_id = 'nrn-t2'")
        .get() as { c: number }
      expect(task2Executions.c).toBe(1)
      const endNode = db
        .prepare("SELECT status FROM node_runs WHERE workflow_node_key = 'end'")
        .get() as { status: string }
      expect(endNode.status).toBe('succeeded')
    } finally {
      db.close()
    }
  }, 120_000)

  it('converges a T3-committed/not-spawned recovery after restart without duplicate execution', async () => {
    const dataDir = tempDir('a-nr-crash-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    seedInterruptedRecovery(dataDir, repoDir, checkpointId)
    spawnCore(dataDir)
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare("SELECT status FROM task_recovery_attempts WHERE id = 'rec-crash'")
          .get() as { status?: string } | undefined
        return row?.status === 'failed'
      }, 60_000)
      const attempt = db
        .prepare("SELECT status, error_json FROM task_recovery_attempts WHERE id = 'rec-crash'")
        .get() as { status: string; error_json: string | null }
      expect(attempt.status).toBe('failed')
      const execution = db
        .prepare("SELECT status FROM executions WHERE id = 'exe-crash'")
        .get() as { status: string }
      expect(execution.status).toBe('failed')
      const executions = db
        .prepare("SELECT COUNT(*) AS c FROM executions WHERE node_run_id = 'nrn-crash'")
        .get() as { c: number }
      expect(executions.c).toBe(1)
      const node = db.prepare("SELECT status FROM node_runs WHERE id = 'nrn-crash'").get() as {
        status: string
      }
      expect(node.status).toBe('reconciliation_required')
      const replacements = db
        .prepare(
          "SELECT COUNT(*) AS c FROM node_runs WHERE workflow_node_key = 'task_1' AND attempt > 2",
        )
        .get() as { c: number }
      expect(replacements.c).toBe(0)
    } finally {
      db.close()
    }
  }, 120_000)

  it('reconciles an interrupted T2 worktree intent on restart without claiming or reusing it', async () => {
    const dataDir = tempDir('a-nr-t2-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    seedT2Crash(dataDir, checkpointId)
    spawnCore(dataDir)
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare("SELECT status FROM task_recovery_attempts WHERE id = 'rec-t2-crash'")
          .get() as { status?: string } | undefined
        return row?.status === 'failed'
      }, 60_000)
      const attempt = db
        .prepare(
          "SELECT status, context_manifest_json FROM task_recovery_attempts WHERE id = 'rec-t2-crash'",
        )
        .get() as { status: string; context_manifest_json: string }
      expect(attempt.status).toBe('failed')
      expect(attempt.context_manifest_json).toContain('abandoned')
      expect(attempt.context_manifest_json).toContain('WORKTREE_CREATION_INTERRUPTED')
      const claimed = db
        .prepare("SELECT COUNT(*) AS c FROM node_runs WHERE id = 'nrn-t2-crash'")
        .get() as { c: number }
      expect(claimed.c).toBe(0)
      const executions = db
        .prepare("SELECT COUNT(*) AS c FROM executions WHERE node_run_id = 'nrn-t2-crash'")
        .get() as { c: number }
      expect(executions.c).toBe(0)
    } finally {
      db.close()
    }
  }, 120_000)

  it('reconciles a ready-but-unstarted T2 worktree as orphan on restart', async () => {
    const dataDir = tempDir('a-nr-ready-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    seedT2Worktree(dataDir, checkpointId, {
      attemptId: 'rec-t2-ready',
      idempotencyKey: 'idem-t2-ready',
      chainAttemptNo: 2,
      state: 'ready',
    })
    spawnCore(dataDir)
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare("SELECT status FROM task_recovery_attempts WHERE id = 'rec-t2-ready'")
          .get() as { status?: string } | undefined
        return row?.status === 'failed'
      }, 60_000)
      const attempt = db
        .prepare(
          "SELECT status, context_manifest_json FROM task_recovery_attempts WHERE id = 'rec-t2-ready'",
        )
        .get() as { status: string; context_manifest_json: string }
      expect(attempt.status).toBe('failed')
      expect(attempt.context_manifest_json).toContain('orphaned')
      expect(attempt.context_manifest_json).toContain('START_INTERRUPTED')
      const claimed = db
        .prepare("SELECT COUNT(*) AS c FROM node_runs WHERE id = 'nrn-t2-ready'")
        .get() as { c: number }
      expect(claimed.c).toBe(0)
      const worktree = db
        .prepare("SELECT status FROM worktrees WHERE branch_name = 'agentra/t2-ready'")
        .get() as { status: string }
      expect(worktree.status).toBe('active')
    } finally {
      db.close()
    }
  }, 120_000)

  it('reconciles a creating worktree that Git already registered as orphan', async () => {
    const dataDir = tempDir('a-nr-created-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    seedT2Worktree(dataDir, checkpointId, {
      attemptId: 'rec-t2-created',
      idempotencyKey: 'idem-t2-created',
      chainAttemptNo: 3,
      state: 'creating',
    })
    spawnCore(dataDir)
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare("SELECT status FROM task_recovery_attempts WHERE id = 'rec-t2-created'")
          .get() as { status?: string } | undefined
        return row?.status === 'failed'
      }, 60_000)
      const attempt = db
        .prepare(
          "SELECT context_manifest_json FROM task_recovery_attempts WHERE id = 'rec-t2-created'",
        )
        .get() as { context_manifest_json: string }
      expect(attempt.context_manifest_json).toContain('orphaned')
      expect(attempt.context_manifest_json).toContain('WORKTREE_CREATED_UNCONFIRMED')
      const claimed = db
        .prepare("SELECT COUNT(*) AS c FROM node_runs WHERE id = 'nrn-rec-t2-created'")
        .get() as { c: number }
      expect(claimed.c).toBe(0)
    } finally {
      db.close()
    }
  }, 120_000)

  it('keeps an unconfirmable worktree in manual review without failing the attempt', async () => {
    const dataDir = tempDir('a-nr-manual-')
    const repoDir = tempDir('a-nr-repo-')
    initRepo(repoDir)
    const { checkpointId } = seed(dataDir, repoDir)
    seedT2Worktree(dataDir, checkpointId, {
      attemptId: 'rec-t2-manual',
      idempotencyKey: 'idem-t2-manual',
      chainAttemptNo: 3,
      state: 'creating',
    })
    // 仓库不可读 → Git 注册状态无法确认，必须保留人工处理。
    fs.rmSync(repoDir, { recursive: true, force: true })
    spawnCore(dataDir)

    const db = openDatabase(path.join(dataDir, 'agentra.db'))
    try {
      await waitFor(async () => {
        const row = db
          .prepare(
            "SELECT context_manifest_json FROM task_recovery_attempts WHERE id = 'rec-t2-manual'",
          )
          .get() as { context_manifest_json?: string } | undefined
        return row?.context_manifest_json?.includes('needs_manual_review') ?? false
      }, 60_000)
      const attempt = db
        .prepare(
          "SELECT status, context_manifest_json FROM task_recovery_attempts WHERE id = 'rec-t2-manual'",
        )
        .get() as { status: string; context_manifest_json: string }
      expect(attempt.status).toBe('starting')
      const claimed = db
        .prepare("SELECT COUNT(*) AS c FROM node_runs WHERE id = 'nrn-rec-t2-manual'")
        .get() as { c: number }
      expect(claimed.c).toBe(0)
    } finally {
      db.close()
    }
  }, 120_000)
})
