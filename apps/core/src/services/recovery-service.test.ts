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
  TeamTaskSubtaskRepository,
} from '../db/repositories/collaboration-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ProjectRepository } from '../db/repositories/project-repository'
import { RecoveryAttemptRepository } from '../db/repositories/recovery-attempt-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { AssignmentService } from './assignment-service'
import { CheckpointService } from './checkpoint-service'
import { RecoveryService } from './recovery-service'
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
  options: {
    highRisk?: boolean
    failStart?: boolean
    failAfterStart?: boolean
    beforeOnStarted?: () => void
    pendingClassification?: 'spawned' | 'not_started' | 'unconfirmed'
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-recovery-'))
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
    ) VALUES ('agt-1', 'Worker', '🤖', '', 'be careful', '[]', 'analyze', NULL, NULL, ?, 'provider-1', 5, 'active', ?, ?, NULL)`,
  ).run(JSON.stringify(toolPermissionsForAccessMode('analyze')), NOW, NOW)

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
  const agentRepository = new AgentRepository(db)
  const teamRuns = new TeamTaskRunRepository(db)
  const teamSubtasks = new TeamTaskSubtaskRepository(db)
  const worktrees = new WorktreeService(
    db,
    workRepository,
    assignmentRepository,
    path.join(dir, 'worktrees'),
    () => NOW,
  )
  const recoveryResultSink: { target: RecoveryService | null } = { target: null }
  const checkpointService = new CheckpointService({
    db,
    checkpoints: checkpointRepository,
    works: workRepository,
    executions: executionRepository,
    sessions: sessionRepository,
    assignments: assignmentRepository,
    nodes: new NodeRunRepository(db),
    teamRuns,
    workflowRuns: new WorkflowRunRepository(db),
    artifacts: new ArtifactRepository(db),
    logs: new ExecutionLogRepository(db),
    audit,
    agents: agentRepository,
    taskMemories: taskMemoryService,
    worktrees,
    teamMessages: new TeamTaskMessageRepository(db),
    artifactsRoot: path.join(dir, 'artifacts'),
    onCheckpointResult: (event) => recoveryResultSink.target?.onCheckpointResult(event),
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
  const assignmentService = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    sessionRepository,
    () => NOW,
  )
  const attempts = new RecoveryAttemptRepository(db)
  const started: Array<{ params: unknown; options: unknown }> = []
  const failStart = options.failStart === true
  const failAfterStart = options.failAfterStart === true
  const beforeOnStarted = options.beforeOnStarted
  const pendingClassification = options.pendingClassification ?? 'not_started'
  let recSeq = 0
  const fakeExecutions = {
    startRecovery: async (
      params: unknown,
      options: {
        recovery: {
          attemptId: string
          checkpointId: string
          teamRunId?: string | null
          reopenWork?: () => void
          onStarted?: () => void
        }
      },
    ) => {
      started.push({ params, options })
      if (failStart) throw new Error('simulated start failure')
      options.recovery.reopenWork?.()
      beforeOnStarted?.()
      options.recovery.onStarted?.()
      const seq = ++recSeq
      const execution: Execution = {
        id: `exe-rec-${seq}`,
        sessionId: `ses-rec-${seq}`,
        providerId: 'provider-1',
        agentId: 'agt-1',
        externalExecutionId: `ext-rec-${seq}`,
        processId: null,
        status: 'running',
        workingDirectory: path.join(dir, 'work'),
        startedAt: NOW,
        endedAt: null,
        exitCode: null,
        capabilities: capabilities(),
        createdAt: NOW,
        updatedAt: NOW,
      }
      sessionRepository.create({
        id: execution.sessionId,
        assignmentId: 'asg-1',
        providerId: 'provider-1',
        externalSessionId: execution.externalExecutionId as string,
        contextRef: 'agt-1',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        lastActiveAt: NOW,
      })
      executionRepository.create(execution)
      attempts.markRunning(
        options.recovery.attemptId,
        {
          executionId: execution.id,
          sessionId: execution.sessionId,
          teamRunId: options.recovery.teamRunId ?? null,
        },
        NOW,
      )
      if (failAfterStart) throw new Error('simulated failure after start')
      return execution
    },
    classifyPendingStart: async () => pendingClassification,
    failUnstartedExecution: (executionId: string) => {
      const execution = executionRepository.get(executionId)
      if (!execution || execution.status !== 'pending') return false
      executionRepository.finish(executionId, { status: 'failed', endedAt: NOW })
      return true
    },
    cancel: async () => ({}) as Execution,
  } as never

  const recoveryService = new RecoveryService({
    db,
    attempts,
    works: workRepository,
    workService,
    checkpoints: checkpointService,
    executions: fakeExecutions,
    executionRepository,
    assignments: assignmentService,
    assignmentRepository,
    agents: agentRepository,
    teams: teamRepository,
    teamRuns,
    teamSubtasks: teamSubtasks,
    teamMessages: new TeamTaskMessageRepository(db),
    taskMemories: taskMemoryService,
    audit,
    now: () => NOW,
  })
  recoveryResultSink.target = recoveryService

  const repoPath = path.join(dir, 'repo')
  initRepo(repoPath)
  const work = workService.create({
    name: 'Recovery Work',
    objective: 'recover',
    rootPath: repoPath,
    repositoryPath: repoPath,
    acceptanceCriteria: ['works'],
  })
  workService.activate(work.id)
  assignmentRepository.insert({
    id: 'asg-1',
    workId: work.id,
    agentId: 'agt-1',
    teamId: null,
    workRole: 'team-agt-1',
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
  const worktree = worktrees.create({ workId: work.id, branchName: 'agentra/rec' })
  fs.writeFileSync(path.join(worktree.worktreePath, 'app.ts'), 'export const x = 1\n')
  const execution: Execution = {
    id: 'exe-1',
    sessionId: 'ses-1',
    providerId: 'provider-1',
    agentId: 'agt-1',
    externalExecutionId: 'ext-exe-1',
    processId: null,
    status: 'succeeded',
    workingDirectory: worktree.worktreePath,
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    capabilities: capabilities(),
    createdAt: NOW,
    updatedAt: NOW,
  }
  executionRepository.create(execution)
  if (options.highRisk) {
    db.prepare(
      `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
       VALUES ('log-1', 'exe-1', 1, 'structured', ?, ?)`,
    ).run(
      JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git reset --hard' } }),
      NOW,
    )
  }
  const checkpoint = checkpointService.createForExecution('exe-1', 'generic')
  return {
    db,
    dir,
    work,
    workService,
    workRepository,
    attempts,
    teamRuns,
    teamSubtasks,
    executionRepository,
    teamMessageRepository: new TeamTaskMessageRepository(db),
    checkpointService,
    recoveryService,
    started,
    checkpointId: checkpoint.checkpointId as string,
    worktreePath: worktree.worktreePath,
  }
}

describe('RecoveryService', () => {
  function seedPendingAttempt(
    h: ReturnType<typeof harness>,
    input: { team?: boolean } = {},
  ): {
    attemptId: string
    executionId: string
    teamRunId: string | null
    subtaskId: string | null
  } {
    const executionId = 'exe-pending'
    const execution: Execution = {
      id: executionId,
      sessionId: 'ses-1',
      providerId: 'provider-1',
      agentId: 'agt-1',
      externalExecutionId: 'ext-pending',
      processId: null,
      status: 'pending',
      workingDirectory: h.dir,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      capabilities: capabilities(),
      createdAt: NOW,
      updatedAt: NOW,
    }
    h.executionRepository.create(execution)
    let subtaskId: string | null = null
    let teamRunId: string | null = null
    if (input.team) {
      subtaskId = 'sub-pending'
      h.teamSubtasks.insert({
        id: subtaskId,
        workId: h.work.id,
        title: 'pending member work',
        description: '',
        assigneeAgentId: 'agt-1',
        status: 'running',
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      })
      teamRunId = 'trun-pending'
      h.teamRuns.insert({
        id: teamRunId,
        workId: h.work.id,
        agentId: 'agt-1',
        role: 'member',
        triggerMessageId: null,
        subtaskId,
        status: 'running',
        executionId,
        errorCode: null,
        errorMessage: null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: NOW,
        endedAt: null,
      })
    }
    const attemptId = 'rec-pending'
    h.attempts.insert({
      id: attemptId,
      workId: h.work.id,
      checkpointId: h.checkpointId,
      kind: input.team ? 'team' : 'generic',
      baseDedupeKey: 'recovery:pending',
      dedupeKey: 'recovery:pending#attempt-1',
      idempotencyKey: 'idem-pending',
      attemptNo: 1,
      status: 'running',
      riskLevel: 'low',
      eligibilityStatus: 'eligible',
      originalWorkStatus: null,
      reopenReason: null,
      operatorConfirmationJson: '{}',
      planHash: 'hash',
      contextManifestJson: '{}',
      executionId,
      sessionId: 'ses-1',
      teamRunId,
      nodeRunId: null,
      workflowRunId: null,
      branchRunId: null,
      recoveredNodeRunId: null,
      chainAttemptNo: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      endedAt: null,
    })
    return { attemptId, executionId, teamRunId, subtaskId }
  }

  it('returns a read-only plan and creates a new recovery attempt on explicit start', async () => {
    const h = harness()
    const plan = h.recoveryService.plan(h.work.id, h.checkpointId)
    expect(plan.eligibility.status).toBe('eligible')
    expect(plan.limits.maxAttempts).toBe(3)
    expect(plan.reopen.required).toBe(false)

    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: h.checkpointId,
        confirm: false,
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_CONFIRMATION_REQUIRED' })

    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: h.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-1',
    })
    expect(started.status).toBe('running')
    expect(started.executionId).toBe('exe-rec-1')
    expect(started.sessionId).toBe('ses-rec-1')
    expect(h.started).toHaveLength(1)
    const attempt = h.attempts.get(started.recoveryAttemptId)
    expect(attempt).toMatchObject({ status: 'running', checkpointId: h.checkpointId })

    const replay = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: h.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-1',
    })
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.recoveryAttemptId).toBe(started.recoveryAttemptId)
    expect(h.started).toHaveLength(1)

    h.executionRepository.finish(started.executionId as string, {
      status: 'succeeded',
      endedAt: NOW,
    })
    h.recoveryService.onExecutionTerminal(started.executionId as string, 'succeeded')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('running')
    h.recoveryService.onCheckpointResult({
      executionId: started.executionId as string,
      outcome: 'created',
      checkpointId: 'chk-rec',
      blocked: false,
      riskLevel: 'low',
      evidenceStatus: 'verified',
      sideEffectCompleteness: 'not_tracked',
      reasons: [],
      checkpointState: 'valid',
    })
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('succeeded')
  })

  it('rejects high-risk recovery with not_tracked side effects even with acknowledgeRisk', async () => {
    const h = harness({ highRisk: true })
    const plan = h.recoveryService.plan(h.work.id, h.checkpointId)
    expect(plan.eligibility.status).toBe('blocked')
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: h.checkpointId,
        confirm: true,
        acknowledgeRisk: true,
        idempotencyKey: 'idem-risk',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_PLAN_BLOCKED' })
    expect(h.attempts.listByWork(h.work.id)).toHaveLength(0)
    expect(h.started).toHaveLength(0)
  })

  it('reopens completed Work only with final_delivery and a reason', async () => {
    const h = harness()
    h.workService.complete(h.work.id)
    const completed = h.workRepository.get(h.work.id)
    expect(completed?.status).toBe('completed')
    const finalCheckpoint = h.checkpointService.getLatestValid(h.work.id)
    expect(finalCheckpoint?.kind).toBe('final_delivery')
    if (!finalCheckpoint) throw new Error('missing final checkpoint')

    const plan = h.recoveryService.plan(h.work.id, finalCheckpoint.id)
    expect(plan.reopen).toMatchObject({ required: true, originalWorkStatus: 'completed' })
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: finalCheckpoint.id,
        confirm: true,
        idempotencyKey: 'idem-reopen',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_REOPEN_REASON_REQUIRED' })

    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: finalCheckpoint.id,
      confirm: true,
      idempotencyKey: 'idem-reopen',
      reopenReason: '客户要求补充交付',
    })
    expect(started.status).toBe('running')
    const attempt = h.attempts.get(started.recoveryAttemptId)
    expect(attempt?.originalWorkStatus).toBe('completed')
    expect(attempt?.reopenReason).toBe('客户要求补充交付')
    expect(h.workRepository.get(h.work.id)?.status).toBe('active')
  })

  it('enforces the three-attempt recovery limit', async () => {
    const h = harness()
    for (let index = 1; index <= 3; index += 1) {
      const started = await h.recoveryService.start({
        workId: h.work.id,
        checkpointId: h.checkpointId,
        confirm: true,
        idempotencyKey: `idem-${index}`,
      })
      expect(started.status).toBe('running')
      h.attempts.finish(started.recoveryAttemptId, 'failed', null, NOW)
      h.executionRepository.finish(started.executionId as string, {
        status: 'failed',
        endedAt: NOW,
      })
    }
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: h.checkpointId,
        confirm: true,
        idempotencyKey: 'idem-4',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_RETRY_LIMIT_REACHED' })
    expect(h.attempts.listByWork(h.work.id)).toHaveLength(3)
    expect(h.started).toHaveLength(3)
  })

  it('fails interrupted starting attempts without creating a new execution', () => {
    const h = harness()
    h.attempts.insert({
      id: 'rec-interrupted',
      workId: h.work.id,
      checkpointId: h.checkpointId,
      kind: 'generic',
      baseDedupeKey: 'recovery:interrupted',
      dedupeKey: 'recovery:interrupted#attempt-1',
      idempotencyKey: 'idem-interrupted',
      attemptNo: 1,
      status: 'starting',
      riskLevel: 'low',
      eligibilityStatus: 'eligible',
      originalWorkStatus: null,
      reopenReason: null,
      operatorConfirmationJson: '{}',
      planHash: 'hash',
      contextManifestJson: '{}',
      executionId: null,
      sessionId: null,
      teamRunId: null,
      nodeRunId: null,
      workflowRunId: null,
      branchRunId: null,
      recoveredNodeRunId: null,
      chainAttemptNo: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null,
      endedAt: null,
    })

    h.recoveryService.recoverOnStartup()
    const attempt = h.attempts.get('rec-interrupted')
    expect(attempt?.status).toBe('failed')
    expect(attempt?.errorJson).toContain('START_INTERRUPTED')
    expect(h.started).toHaveLength(0)
  })

  it('does not leave completed Work active when recovery Session creation fails', async () => {
    const h = harness({ failStart: true })
    h.workService.complete(h.work.id)
    const finalCheckpoint = h.checkpointService.getLatestValid(h.work.id)
    if (!finalCheckpoint) throw new Error('missing final checkpoint')
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: finalCheckpoint.id,
        confirm: true,
        idempotencyKey: 'idem-reopen-fail',
        reopenReason: '补充交付',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_START_FAILED' })
    expect(h.workRepository.get(h.work.id)?.status).toBe('completed')
    const attempt = h.attempts.getByIdempotencyKey(h.work.id, 'idem-reopen-fail')
    expect(attempt?.status).toBe('failed')
    expect(attempt?.executionId).toBeNull()
  })

  function seedMemberCheckpoint(h: ReturnType<typeof harness>): {
    checkpointId: string
    subtaskId: string
  } {
    const subtaskId = 'sub-member'
    h.teamSubtasks.insert({
      id: subtaskId,
      workId: h.work.id,
      title: 'member implementation',
      description: '',
      assigneeAgentId: 'agt-1',
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    })
    const execution: Execution = {
      id: 'exe-member',
      sessionId: 'ses-1',
      providerId: 'provider-1',
      agentId: 'agt-1',
      externalExecutionId: 'ext-member',
      processId: null,
      status: 'succeeded',
      workingDirectory: h.worktreePath,
      startedAt: NOW,
      endedAt: NOW,
      exitCode: 0,
      capabilities: capabilities(),
      createdAt: NOW,
      updatedAt: NOW,
    }
    h.executionRepository.create(execution)
    h.teamRuns.insert({
      id: 'trun-member',
      workId: h.work.id,
      agentId: 'agt-1',
      role: 'member',
      triggerMessageId: null,
      subtaskId,
      status: 'succeeded',
      executionId: 'exe-member',
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      endedAt: NOW,
    })
    const checkpoint = h.checkpointService.createForExecution('exe-member', 'team')
    if (!checkpoint.checkpointId) throw new Error('missing member checkpoint')
    return { checkpointId: checkpoint.checkpointId, subtaskId }
  }

  it('recovers a Team Member with subtask/attempt/run/execution consistent', async () => {
    const h = harness()
    const seeded = seedMemberCheckpoint(h)
    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: seeded.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-member-ok',
    })
    expect(started.status).toBe('running')
    expect(h.teamSubtasks.get(seeded.subtaskId)?.status).toBe('running')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('running')
    expect(h.teamRuns.get(started.teamRunId as string)?.status).toBe('running')
    expect(h.executionRepository.get(started.executionId as string)?.status).toBe('running')
  })

  it('does not leave a running subtask when Member recovery fails after start', async () => {
    const h = harness({ failAfterStart: true })
    const seeded = seedMemberCheckpoint(h)
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: seeded.checkpointId,
        confirm: true,
        idempotencyKey: 'idem-member-fail',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_START_FAILED' })
    expect(h.teamSubtasks.get(seeded.subtaskId)?.status).toBe('blocked')
    const attempt = h.attempts.getByIdempotencyKey(h.work.id, 'idem-member-fail')
    expect(attempt?.status).toBe('failed')
    if (attempt?.teamRunId) {
      expect(h.teamRuns.get(attempt.teamRunId)?.status).toBe('failed')
    }
  })

  it('rejects a Member recovery when the subtask becomes done concurrently', async () => {
    let subtaskIdForRace = ''
    let h!: ReturnType<typeof harness>
    h = harness({
      beforeOnStarted: () => {
        h.teamSubtasks.updateStatus(subtaskIdForRace, ['pending'], 'done', NOW)
      },
    })
    const seeded = seedMemberCheckpoint(h)
    subtaskIdForRace = seeded.subtaskId
    await expect(
      h.recoveryService.start({
        workId: h.work.id,
        checkpointId: seeded.checkpointId,
        confirm: true,
        idempotencyKey: 'idem-member-race',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_START_FAILED' })
    expect(h.teamSubtasks.get(seeded.subtaskId)?.status).toBe('done')
    const attempt = h.attempts.getByIdempotencyKey(h.work.id, 'idem-member-race')
    expect(attempt?.status).toBe('failed')
  })

  it('converges a confirmed-unstarted pending recovery without spawning again', async () => {
    const h = harness({ pendingClassification: 'not_started' })
    const seeded = seedPendingAttempt(h, { team: true })
    await h.recoveryService.reconcileInterruptedStarts(true)

    expect(h.executionRepository.get(seeded.executionId)?.status).toBe('failed')
    expect(h.attempts.get(seeded.attemptId)?.status).toBe('failed')
    expect(h.teamRuns.get(seeded.teamRunId as string)?.status).toBe('failed')
    expect(h.teamSubtasks.get(seeded.subtaskId as string)?.status).toBe('blocked')
    expect(h.started).toHaveLength(0)
    const audit = h.db
      .prepare("SELECT count(*) AS c FROM audit_logs WHERE action = 'recovery.crash_reconciled'")
      .get() as { c: number }
    expect(audit.c).toBeGreaterThan(0)
  })

  it('does not misclassify an already-spawned pending execution', async () => {
    const h = harness({ pendingClassification: 'spawned' })
    const seeded = seedPendingAttempt(h)
    await h.recoveryService.reconcileInterruptedStarts(true)
    expect(h.executionRepository.get(seeded.executionId)?.status).toBe('pending')
    expect(h.attempts.get(seeded.attemptId)?.status).toBe('running')
    expect(h.started).toHaveLength(0)
  })

  it('keeps an explicit unconfirmed state when start evidence cannot be established', async () => {
    const h = harness({ pendingClassification: 'unconfirmed' })
    const seeded = seedPendingAttempt(h)
    await h.recoveryService.reconcileInterruptedStarts(true)
    expect(h.executionRepository.get(seeded.executionId)?.status).toBe('pending')
    expect(h.attempts.get(seeded.attemptId)?.status).toBe('running')
    const audit = h.db
      .prepare("SELECT count(*) AS c FROM audit_logs WHERE action = 'recovery.start_unconfirmed'")
      .get() as { c: number }
    expect(audit.c).toBeGreaterThan(0)
    expect(h.started).toHaveLength(0)
  })

  it('marks recovery succeeded only after a successful Checkpoint result', async () => {
    const h = harness()
    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: h.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-checkpoint-ok',
    })
    const executionId = started.executionId as string
    h.executionRepository.finish(executionId, { status: 'succeeded', endedAt: NOW })
    h.recoveryService.onExecutionTerminal(executionId, 'succeeded')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('running')

    const checkpoint = h.checkpointService.createForExecution(executionId, 'generic')
    expect(checkpoint.outcome).toBe('created')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('succeeded')
    expect(h.executionRepository.get(executionId)?.status).toBe('succeeded')
  })

  it('marks recovery failed when Execution succeeds but Checkpoint creation fails', async () => {
    const h = harness()
    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: h.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-checkpoint-fail',
    })
    const executionId = started.executionId as string
    h.executionRepository.finish(executionId, { status: 'succeeded', endedAt: NOW })
    h.db
      .prepare('UPDATE task_memories SET memory_json = ? WHERE work_id = ?')
      .run('{not-json', h.work.id)
    const checkpoint = h.checkpointService.createForExecution(executionId, 'generic')
    expect(checkpoint.outcome).toBe('failed')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('failed')
    expect(h.executionRepository.get(executionId)?.status).toBe('succeeded')
    expect(
      h.db
        .prepare("SELECT count(*) AS c FROM audit_logs WHERE action = 'recovery.checkpoint_failed'")
        .get(),
    ).toEqual({ c: 1 })
  })

  it('keeps high-risk checkpoint failure blocking future execution', async () => {
    const h = harness()
    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: h.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-checkpoint-high',
    })
    const executionId = started.executionId as string
    h.executionRepository.finish(executionId, { status: 'succeeded', endedAt: NOW })
    h.db
      .prepare(
        `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
         VALUES ('log-rec-high', ?, 1, 'structured', ?, ?)`,
      )
      .run(
        executionId,
        JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git reset --hard' } }),
        NOW,
      )
    h.db
      .prepare('UPDATE task_memories SET memory_json = ? WHERE work_id = ?')
      .run('{not-json', h.work.id)
    const checkpoint = h.checkpointService.createForExecution(executionId, 'generic')
    expect(checkpoint.outcome).toBe('failed')
    expect(checkpoint.riskLevel).toBe('high')
    expect(h.attempts.get(started.recoveryAttemptId)?.status).toBe('failed')
    expect(() => h.checkpointService.assertCanStart(h.work.id)).toThrow(/RECOVERY_REQUIRED/)
  })

  it('creates a team recovery run for a team checkpoint', async () => {
    const h = harness()
    const execution: Execution = {
      id: 'exe-team',
      sessionId: 'ses-1',
      providerId: 'provider-1',
      agentId: 'agt-1',
      externalExecutionId: 'ext-team',
      processId: null,
      status: 'succeeded',
      workingDirectory: h.worktreePath,
      startedAt: NOW,
      endedAt: NOW,
      exitCode: 0,
      capabilities: capabilities(),
      createdAt: NOW,
      updatedAt: NOW,
    }
    h.executionRepository.create(execution)
    h.teamRuns.insert({
      id: 'trun-old',
      workId: h.work.id,
      agentId: 'agt-1',
      role: 'leader',
      triggerMessageId: null,
      subtaskId: null,
      status: 'succeeded',
      executionId: 'exe-team',
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      endedAt: NOW,
    })
    const teamCheckpoint = h.checkpointService.createForExecution('exe-team', 'team')
    expect(teamCheckpoint.outcome).toBe('created')
    if (!teamCheckpoint.checkpointId) throw new Error('missing team checkpoint')

    const started = await h.recoveryService.start({
      workId: h.work.id,
      checkpointId: teamCheckpoint.checkpointId,
      confirm: true,
      idempotencyKey: 'idem-team',
    })
    expect(started.status).toBe('running')
    const attempt = h.attempts.get(started.recoveryAttemptId)
    expect(attempt?.kind).toBe('team')
    expect(attempt?.teamRunId).toBeTruthy()
    expect(h.teamRuns.get(attempt?.teamRunId as string)?.status).toBe('running')
    expect(h.started.at(-1)?.options).toMatchObject({
      system: { purpose: 'team_leader' },
    })
  })

  function seedWorkflowNodeAttempt(
    h: ReturnType<typeof harness>,
    attemptNodeRunId: string,
  ): { attemptId: string; checkpointId: string } {
    h.db
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
         VALUES ('tpl-wf', 'T', '', '', ?, ?, NULL)`,
      )
      .run(NOW, NOW)
    h.db
      .prepare(
        `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json,
           checksum, status, created_at, published_at)
         VALUES ('wfv-wf', 'tpl-wf', 1, 1, '{}', 'checksum', 'published', ?, ?)`,
      )
      .run(NOW, NOW)
    h.db
      .prepare(
        `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at,
           ended_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-wf', ?, 'wfv-wf', 'running', ?, NULL, '{}', ?, ?)`,
      )
      .run(h.work.id, NOW, NOW, NOW)
    for (const [id, key, status] of [
      ['nrn-wf', 'task_1', 'succeeded'],
      ['nrn-old', 'task_old', 'failed'],
    ] as const) {
      h.db
        .prepare(
          `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status,
             attempt, input_snapshot_json, output_snapshot_json, created_at, updated_at)
           VALUES (?, 'run-wf', ?, NULL, ?, 1, '{}', NULL, ?, ?)`,
        )
        .run(id, key, status, NOW, NOW)
    }
    h.db
      .prepare(
        `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
           context_ref, status, created_at, updated_at, last_active_at)
         VALUES ('ses-wf', 'asg-1', 'provider-1', 'ext-wf', 'agt-1', 'active', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW)
    h.db
      .prepare(
        `INSERT INTO executions (id, session_id, node_run_id, provider_id, external_execution_id,
           process_id, status, working_directory, started_at, ended_at, exit_code,
           capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
         VALUES ('exe-wf', 'ses-wf', 'nrn-wf', 'provider-1', 'ext-exe-wf', NULL, 'succeeded', ?, ?, ?, 0,
           ?, NULL, ?, ?)`,
      )
      .run(h.worktreePath, NOW, NOW, JSON.stringify(capabilities()), NOW, NOW)
    const checkpoint = h.checkpointService.createForExecution('exe-wf', 'node')
    if (!checkpoint.checkpointId)
      throw new Error(`missing workflow node checkpoint: ${JSON.stringify(checkpoint)}`)
    const attemptId = `rec-wf-${attemptNodeRunId}`
    h.attempts.insert({
      id: attemptId,
      workId: h.work.id,
      checkpointId: checkpoint.checkpointId,
      kind: 'workflow_node',
      baseDedupeKey: 'workflow_node:nrn-wf',
      dedupeKey: `workflow_node:nrn-wf:${attemptNodeRunId}`,
      idempotencyKey: `idem-${attemptNodeRunId}`,
      attemptNo: 1,
      status: 'running',
      riskLevel: 'low',
      eligibilityStatus: 'eligible',
      originalWorkStatus: null,
      reopenReason: null,
      operatorConfirmationJson: '{}',
      planHash: 'hash',
      contextManifestJson: '{}',
      executionId: 'exe-wf',
      sessionId: 'ses-wf',
      teamRunId: null,
      nodeRunId: attemptNodeRunId,
      workflowRunId: 'run-wf',
      branchRunId: null,
      recoveredNodeRunId: 'nrn-wf',
      chainAttemptNo: 1,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      endedAt: null,
    })
    return { attemptId, checkpointId: checkpoint.checkpointId }
  }

  it('completes a workflow_node recovery only for a checkpoint owned by its Execution/NodeRun', () => {
    const h = harness()
    const { attemptId, checkpointId } = seedWorkflowNodeAttempt(h, 'nrn-wf')
    h.recoveryService.onCheckpointResult({
      executionId: 'exe-wf',
      checkpointId,
      checkpointState: 'valid',
      outcome: 'created',
    } as never)
    expect(h.attempts.get(attemptId)?.status).toBe('succeeded')
  })

  it('fails a workflow_node recovery when the checkpoint belongs to another NodeRun', () => {
    const h = harness()
    const { attemptId, checkpointId } = seedWorkflowNodeAttempt(h, 'nrn-old')
    h.recoveryService.onCheckpointResult({
      executionId: 'exe-wf',
      checkpointId,
      checkpointState: 'valid',
      outcome: 'created',
    } as never)
    const attempt = h.attempts.get(attemptId)
    expect(attempt?.status).toBe('failed')
    expect(attempt?.errorJson).toContain('CHECKPOINT_RECOVERY_MISMATCH')
  })
})
