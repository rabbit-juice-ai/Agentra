import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Execution } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
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
import { ProjectRepository } from '../db/repositories/project-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { CheckpointService } from './checkpoint-service'
import { TaskMemoryService } from './task-memory-service'
import { WorkService } from './work-service'
import { WorktreeService } from './worktree-service'

const NOW = '2026-11-09T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function capabilities() {
  return {
    streaming: 'native' as const,
    structuredEvents: 'native' as const,
    interrupt: 'native' as const,
    resume: 'unsupported' as const,
    checkpoint: 'unsupported' as const,
    permissionRequests: 'unsupported' as const,
    sessionPersistence: 'native' as const,
    workingDirectory: 'native' as const,
    toolControl: 'native' as const,
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

function harness(
  options: { accessMode?: 'analyze' | 'edit'; rootExists?: boolean; repo?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-checkpoint-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)

  db.prepare(
    `INSERT INTO runtime_providers (
      id, provider_type, provider_name, executable_path, version, capabilities_json, health_status,
      last_discovered_at, created_at, updated_at
    ) VALUES ('provider-1', 'cli', 'Test Provider', '/bin/true', '1', ?, 'healthy', ?, ?, ?)`,
  ).run(JSON.stringify(capabilities()), NOW, NOW, NOW)
  db.prepare(
    `INSERT INTO agent_profiles (
      id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
      model, tool_permissions_json, default_provider_id, max_concurrency, status,
      created_at, updated_at, archived_at
    ) VALUES ('agt-1', 'Worker', '🤖', '', '', '[]', ?, NULL, NULL, ?, 'provider-1', 5, 'active', ?, ?, NULL)`,
  ).run(
    options.accessMode ?? 'analyze',
    JSON.stringify(toolPermissionsForAccessMode(options.accessMode ?? 'analyze')),
    NOW,
    NOW,
  )

  const workRepository = new WorkRepository(db)
  const teamRepository = new TeamRepository(db)
  const audit = new AuditRepository(db)
  const projects = new ProjectRepository(db)
  const taskMemoryService = new TaskMemoryService({
    db,
    memories: new TaskMemoryRepository(db),
    audit,
    now: () => NOW,
  })
  const checkpointRepository = new CheckpointRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const sessionRepository = new SessionRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const artifactRepository = new ArtifactRepository(db)
  const worktrees = new WorktreeService(
    db,
    workRepository,
    assignmentRepository,
    path.join(dir, 'worktrees'),
    () => NOW,
  )
  const checkpointService = new CheckpointService({
    db,
    checkpoints: checkpointRepository,
    works: workRepository,
    executions: executionRepository,
    sessions: sessionRepository,
    assignments: assignmentRepository,
    nodes: new NodeRunRepository(db),
    teamRuns: new TeamTaskRunRepository(db),
    workflowRuns: new WorkflowRunRepository(db),
    artifacts: artifactRepository,
    logs: new ExecutionLogRepository(db),
    audit,
    agents: new AgentRepository(db),
    taskMemories: taskMemoryService,
    worktrees,
    teamMessages: new TeamTaskMessageRepository(db),
    artifactsRoot: path.join(dir, 'artifacts'),
    now: () => NOW,
  })
  const workService = new WorkService(
    db,
    workRepository,
    teamRepository,
    audit,
    () => NOW,
    undefined,
    projects,
    taskMemoryService,
    (id, to, now) => {
      if (to === 'completed') checkpointService.createFinalDelivery(id, now)
    },
  )

  const repoPath = path.join(dir, 'repo')
  if (options.repo) initRepo(repoPath)
  const rootPath = options.rootExists === false ? path.join(dir, 'missing-root') : repoPath
  if (options.rootExists !== false && !options.repo) fs.mkdirSync(rootPath, { recursive: true })
  const work = workService.create({
    name: 'Checkpoint Work',
    objective: 'verify checkpoint',
    rootPath,
    repositoryPath: options.repo ? repoPath : null,
    acceptanceCriteria: ['criterion'],
  })
  workService.activate(work.id)
  assignmentRepository.insert({
    id: 'asg-1',
    workId: work.id,
    agentId: 'agt-1',
    teamId: null,
    workRole: 'dev',
    taskScope: '',
    status: 'active',
    concurrencyLimit: null,
    contextRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
  sessionRepository.create({
    id: 'ses-1',
    assignmentId: 'asg-1',
    providerId: 'provider-1',
    externalSessionId: 'ext-1',
    contextRef: 'agt-1',
    status: 'ended',
    createdAt: NOW,
    updatedAt: NOW,
    lastActiveAt: NOW,
  })

  return {
    db,
    dir,
    work,
    workService,
    workRepository,
    checkpointService,
    checkpointRepository,
    executionRepository,
    sessionRepository,
    assignmentRepository,
    worktrees,
    checkpoint: checkpointService,
    createExecution(
      input: { id?: string; status?: Execution['status']; workingDirectory?: string } = {},
    ) {
      const execution: Execution = {
        id: input.id ?? 'exe-1',
        sessionId: 'ses-1',
        providerId: 'provider-1',
        agentId: 'agt-1',
        externalExecutionId: `ext-${input.id ?? 'exe-1'}`,
        processId: null,
        status: input.status ?? 'succeeded',
        workingDirectory: input.workingDirectory ?? rootPath,
        startedAt: NOW,
        endedAt: NOW,
        exitCode: 0,
        capabilities: capabilities(),
        createdAt: NOW,
        updatedAt: NOW,
      }
      executionRepository.create(execution)
      return execution
    },
  }
}

describe('CheckpointService', () => {
  it('creates an immutable valid checkpoint and deduplicates terminal replays', () => {
    const h = harness({ repo: true })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    h.createExecution({ workingDirectory: worktree.worktreePath })

    const first = h.checkpointService.createForExecution('exe-1', 'generic')
    expect(first.outcome).toBe('created')
    expect(first.blocked).toBe(false)
    expect(first.riskLevel).toBe('low')
    expect(first.evidenceStatus).toBe('not_required')
    expect(first.checkpointId).toBeTruthy()

    const record = h.checkpointRepository.get(first.checkpointId as string)
    expect(record).toMatchObject({ state: 'valid', seq: 1, attemptNo: 1 })
    expect(record?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    if (!record) throw new Error('checkpoint not found')

    const second = h.checkpointService.createForExecution('exe-1', 'generic')
    expect(second.outcome).toBe('existing')
    expect(second.checkpointId).toBe(first.checkpointId)
    expect(h.db.prepare('SELECT count(*) AS c FROM task_checkpoints').get()).toEqual({ c: 1 })

    expect(() =>
      h.db.prepare("UPDATE task_checkpoints SET state = 'failed' WHERE id = ?").run(record.id),
    ).toThrow(/immutable/)
    expect(() => h.db.prepare('DELETE FROM task_checkpoints WHERE id = ?').run(record.id)).toThrow(
      /immutable/,
    )
  })

  it('returns a read-only eligible recovery plan without creating sessions or agents', () => {
    const h = harness({ repo: true })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    h.createExecution({ workingDirectory: worktree.worktreePath })
    const created = h.checkpointService.createForExecution('exe-1', 'generic')

    const result = h.checkpointService.getRecoveryPlan(h.work.id)
    expect(result.eligibility.status).toBe('eligible')
    expect(result.eligibility.planOnly).toBe(true)
    expect(result.plan?.checkpointId).toBe(created.checkpointId)
    expect(result.plan?.sections.p0).toContain('P0 · Work')
    expect(result.plan?.sections.p1).toContain('P1 · Task memory')
    expect(result.plan?.manifest.totalChars).toBeGreaterThan(0)
    expect(h.db.prepare('SELECT count(*) AS c FROM agent_sessions').get()).toEqual({ c: 1 })
  })

  it('marks high-risk checkpoints as blocked when side effects are not tracked', () => {
    const h = harness({ repo: true, accessMode: 'edit' })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    h.createExecution({ workingDirectory: worktree.worktreePath })
    h.db
      .prepare(
        `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
         VALUES ('log-1', 'exe-1', 1, 'structured', ?, ?)`,
      )
      .run(
        JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }),
        NOW,
      )

    const created = h.checkpointService.createForExecution('exe-1', 'generic')
    expect(created.outcome).toBe('created')
    expect(created.riskLevel).toBe('high')
    expect(created.blocked).toBe(true)
    expect(created.sideEffectCompleteness).toBe('not_tracked')
    const plan = h.checkpointService.getRecoveryPlan(h.work.id)
    expect(plan.eligibility.status).toBe('blocked')
    expect(plan.plan).toBeNull()
    expect(plan.eligibility.reasonCodes).toContain('SIDE_EFFECTS_NOT_TRACKED')
  })

  it('records failed attempts, blocks high-risk starts, and retries with a new attempt', () => {
    const h = harness({ repo: false, rootExists: false, accessMode: 'edit' })
    h.createExecution()
    h.db
      .prepare(
        `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
         VALUES ('log-1', 'exe-1', 1, 'structured', ?, ?)`,
      )
      .run(
        JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git reset --hard' } }),
        NOW,
      )
    const original = h.db
      .prepare('SELECT memory_json FROM task_memories WHERE work_id = ?')
      .get(h.work.id) as { memory_json: string }
    h.db
      .prepare('UPDATE task_memories SET memory_json = ? WHERE work_id = ?')
      .run('{not-json', h.work.id)

    const failed = h.checkpointService.createForExecution('exe-1', 'generic')
    expect(failed.outcome).toBe('failed')
    expect(failed.blocked).toBe(true)
    expect(failed.riskLevel).toBe('high')
    expect(() => h.checkpointService.assertCanStart(h.work.id)).toThrow(/RECOVERY_REQUIRED/)
    const failedRecord = h.checkpointRepository.get(failed.checkpointId as string)
    expect(failedRecord?.state).toBe('failed')
    if (!failedRecord) throw new Error('failed checkpoint not found')
    expect(() =>
      h.db.prepare("UPDATE task_checkpoints SET state = 'valid' WHERE id = ?").run(failedRecord.id),
    ).toThrow(/immutable/)

    h.db
      .prepare('UPDATE task_memories SET memory_json = ? WHERE work_id = ?')
      .run(original.memory_json, h.work.id)
    h.checkpointService.retryPending(10)
    const latest = h.checkpointRepository.getLatestValid(h.work.id)
    expect(latest?.state).toBe('valid')
    expect(latest?.attemptNo).toBe(2)
    expect(latest?.riskLevel).toBe('high')
    expect(() => h.checkpointService.assertCanStart(h.work.id)).not.toThrow()
  })

  it('stops retrying after MAX_CHECKPOINT_ATTEMPTS and keeps all failed records', () => {
    const h = harness({ repo: false, rootExists: false, accessMode: 'edit' })
    h.createExecution()
    h.db
      .prepare(
        `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
         VALUES ('log-1', 'exe-1', 1, 'structured', ?, ?)`,
      )
      .run(
        JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git reset --hard' } }),
        NOW,
      )
    h.db
      .prepare('UPDATE task_memories SET memory_json = ? WHERE work_id = ?')
      .run('{not-json', h.work.id)

    h.checkpointService.createForExecution('exe-1', 'generic')
    h.checkpointService.retryPending(10)
    h.checkpointService.retryPending(10)
    h.checkpointService.retryPending(10)
    const rows = h.db
      .prepare('SELECT attempt_no, state FROM task_checkpoints ORDER BY attempt_no')
      .all() as { attempt_no: number; state: string }[]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.state === 'failed')).toBe(true)
    expect(rows.map((row) => row.attempt_no)).toEqual([1, 2, 3])
    expect(() => h.checkpointService.assertCanStart(h.work.id)).toThrow(/RECOVERY_REQUIRED/)
  })

  it('blocks recovery when a verified file changes after the checkpoint', () => {
    const h = harness({ repo: true })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    fs.writeFileSync(path.join(worktree.worktreePath, 'app.ts'), 'export const x = 1\n')
    h.createExecution({ workingDirectory: worktree.worktreePath })
    const created = h.checkpointService.createForExecution('exe-1', 'generic')
    expect(created.evidenceStatus).toBe('verified')

    fs.writeFileSync(path.join(worktree.worktreePath, 'app.ts'), 'export const x = 2\n')
    const plan = h.checkpointService.getRecoveryPlan(h.work.id)
    expect(plan.eligibility.status).toBe('blocked')
    expect(plan.plan).toBeNull()
    expect(plan.eligibility.reasonCodes).toContain('FILE_HASH_MISMATCH')
  })

  it('blocks recovery when the worktree is removed', () => {
    const h = harness({ repo: true })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    fs.writeFileSync(path.join(worktree.worktreePath, 'app.ts'), 'export const x = 1\n')
    h.createExecution({ workingDirectory: worktree.worktreePath })
    h.checkpointService.createForExecution('exe-1', 'generic')
    h.worktrees.remove(worktree.id, true)
    const plan = h.checkpointService.getRecoveryPlan(h.work.id)
    expect(plan.eligibility.status).toBe('blocked')
    expect(plan.eligibility.reasonCodes).toContain('WORKTREE_MISSING')
  })

  it('rejects a checkpoint that belongs to another Work', () => {
    const h = harness({ repo: true })
    const worktree = h.worktrees.create({ workId: h.work.id, branchName: 'agentra/chk' })
    h.createExecution({ workingDirectory: worktree.worktreePath })
    const created = h.checkpointService.createForExecution('exe-1', 'generic')
    const other = h.workService.create({
      name: 'Other Work',
      rootPath: path.join(h.dir, 'repo'),
    })
    const plan = h.checkpointService.getRecoveryPlan(other.id, created.checkpointId ?? undefined)
    expect(plan.eligibility.status).toBe('blocked')
    expect(plan.eligibility.reasonCodes).toContain('CHECKPOINT_WORK_MISMATCH')
    expect(plan.plan).toBeNull()
  })

  it('creates a final delivery checkpoint when the Work completes', () => {
    const h = harness({ repo: true })
    h.workService.complete(h.work.id)
    const latest = h.checkpointRepository.getLatestValid(h.work.id)
    expect(latest?.kind).toBe('final_delivery')
    expect(latest?.seq).toBe(1)
    expect(latest?.state).toBe('valid')
  })
})
