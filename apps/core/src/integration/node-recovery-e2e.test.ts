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
          taskPrompt: 'TASK_RECOVER',
          inputArtifactRefs: [],
          artifacts: [{ name: 'spec', type: 'markdown', required: true }],
          workingDirectoryPolicy: 'worktree',
          outputContract: { profile: 'generic', fields: [] },
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
  db.close()
  return { checkpointId: checkpoint.checkpointId }
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
      const run = db.prepare("SELECT status FROM workflow_runs WHERE id = 'run-rec'").get() as {
        status: string
      }
      expect(run.status).toBe('running')
    } finally {
      db.close()
    }
  }, 120_000)
})
