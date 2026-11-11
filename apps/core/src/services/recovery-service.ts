import {
  ExecutionExitedPayload,
  ExecutionStatePayload,
  RpcMethodError,
  type RuntimeEvent,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { AssignmentRepository } from '../db/repositories/assignment-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { CheckpointRecord } from '../db/repositories/checkpoint-repository'
import type {
  TeamTaskMessageRepository,
  TeamTaskRunRecord,
  TeamTaskRunRepository,
  TeamTaskSubtaskRepository,
} from '../db/repositories/collaboration-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type {
  RecoveryAttemptRecord,
  RecoveryAttemptRepository,
} from '../db/repositories/recovery-attempt-repository'
import type { TeamRepository } from '../db/repositories/team-repository'
import type { WorkRecord, WorkRepository } from '../db/repositories/work-repository'
import type { AssignmentService } from './assignment-service'
import { canonicalJson, sha256Hex } from './checkpoint-hash'
import { CheckpointEvidenceSchema, CheckpointJsonSchema } from './checkpoint-schemas'
import type { CheckpointCreationEvent, CheckpointService } from './checkpoint-service'
import {
  buildRecoveryPrompt,
  ContextBudgetExceededError,
  DEFAULT_CONTEXT_BUDGET,
} from './context-builder'
import type { CoreEventHub } from './event-hub'
import type { ExecutionService } from './execution-service'
import type { TaskMemoryService } from './task-memory-service'
import { TEAM_LEADER_TOOL_POLICY } from './team-collaboration-service'

export const MAX_RECOVERY_ATTEMPTS = 3

export type RecoveryPlanView = {
  workId: string
  checkpointId: string
  checkpointSeq: number
  checkpointKind: string
  isLatest: boolean
  workStatus: string
  workIssueStatus: string
  eligibility: {
    status: 'eligible' | 'conditional' | 'blocked'
    planOnly: true
    reasonCodes: string[]
    riskLevel: 'low' | 'medium' | 'high' | null
    evidenceStatus: string | null
    sideEffectCompleteness: string | null
  }
  limits: {
    maxAttempts: number
    attemptsUsed: number
    remainingAttempts: number
    activeAttemptId: string | null
  }
  contextBudget: {
    totalChars: number
    p0Chars: number
    p0Bytes: number
    p1Bytes: number
    p2Bytes: number
    p3Bytes: number
    trimmed: { p1: boolean; p2: boolean; p3: boolean }
  }
  reopen: {
    required: boolean
    originalWorkStatus: 'completed' | null
    reasonRequired: boolean
  }
  sections: { p0: string; p1: string; p2: string; p3: string } | null
}

export type RecoveryStartInput = {
  workId: string
  checkpointId: string
  confirm: boolean
  acknowledgeRisk?: boolean
  idempotencyKey: string
  reopenReason?: string
  actorType?: 'user' | 'agent' | 'system'
  actorId?: string | null
}

export type RecoveryStartResult = {
  recoveryAttemptId: string
  status: RecoveryAttemptRecord['status']
  executionId: string | null
  sessionId: string | null
  teamRunId: string | null
  idempotentReplay: boolean
}

export type RecoveryServiceDeps = {
  db: Database
  attempts: RecoveryAttemptRepository
  works: WorkRepository
  workService: {
    reopenCompletedInTransaction: (
      id: string,
      input: {
        reason: string
        recoveryAttemptId: string
        checkpointId: string
        actorType?: 'user' | 'agent' | 'system'
        actorId?: string | null
      },
      now: string,
    ) => WorkRecord
  }
  checkpoints: CheckpointService
  executions: ExecutionService
  executionRepository: ExecutionRepository
  assignments: AssignmentService
  assignmentRepository: AssignmentRepository
  agents: AgentRepository
  teams: TeamRepository
  teamRuns: TeamTaskRunRepository
  teamSubtasks: TeamTaskSubtaskRepository
  teamMessages: TeamTaskMessageRepository
  taskMemories: TaskMemoryService
  audit: AuditRepository
  now?: () => string
  logger?: { warn(message: string, data?: Record<string, unknown>): void }
  /** Phase 1B-2B：workflow_node 恢复 Attempt 终态后，交给 Run 收敛协调器。 */
  onWorkflowAttemptSettled?: (input: { workflowRunId: string; recoveryAttemptId: string }) => void
}

type RecoveryTarget =
  | {
      kind: 'team'
      agentId: string
      role: 'leader' | 'member'
      subtaskId: string | null
      teamId: string | null
    }
  | { kind: 'generic'; agentId: string }

type PreparedPrompt = {
  prompt: string
  manifest: Record<string, unknown>
}

export class RecoveryService {
  private readonly now: () => string

  constructor(private readonly deps: RecoveryServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  plan(workId: string, checkpointId?: string): RecoveryPlanView {
    const work = this.deps.works.get(workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${workId}`)
    const record = this.deps.checkpoints.getCheckpoint(workId, checkpointId)
    if (!record) throw new RpcMethodError('RECOVERY_CHECKPOINT_NOT_FOUND', 'checkpoint not found')
    const planResult = this.deps.checkpoints.getRecoveryPlan(workId, record.id)
    const attemptsUsed = this.deps.attempts.countByCheckpoint(workId, record.id)
    const active = this.deps.attempts.getActiveByWork(workId)
    const activeExecution = this.deps.executionRepository
      .listByWork(workId)
      .find((execution) => execution.status === 'pending' || execution.status === 'running')
    const activeTeamRun = this.deps.teamRuns.getActiveByWork(workId)
    const latest = this.deps.checkpoints.getLatestValid(workId)
    const reasons = [...(planResult.eligibility.reasonCodes ?? [])]
    let status = planResult.eligibility.status
    try {
      this.deps.checkpoints.assertCanStart(workId)
    } catch {
      status = 'blocked'
      reasons.push('RECOVERY_REQUIRED')
    }
    if (work.status === 'cancelled' || work.status === 'archived') {
      status = 'blocked'
      reasons.push('RECOVERY_WORK_STATUS_INVALID')
    }
    if (work.status === 'completed' && record.kind !== 'final_delivery') {
      status = 'blocked'
      reasons.push('RECOVERY_WORK_STATUS_INVALID')
    }
    if (active) {
      status = 'blocked'
      reasons.push('RECOVERY_ACTIVE_EXISTS')
    }
    if (activeExecution) {
      status = 'blocked'
      reasons.push('RECOVERY_EXECUTION_ACTIVE')
    }
    if (activeTeamRun) {
      status = 'blocked'
      reasons.push('RECOVERY_TEAM_RUN_ACTIVE')
    }
    if (attemptsUsed >= MAX_RECOVERY_ATTEMPTS) {
      status = 'blocked'
      reasons.push('RECOVERY_RETRY_LIMIT_REACHED')
    }
    const plan = planResult.plan
    return {
      workId,
      checkpointId: record.id,
      checkpointSeq: record.seq,
      checkpointKind: record.kind,
      isLatest: latest?.id === record.id,
      workStatus: work.status,
      workIssueStatus: work.issueStatus,
      eligibility: {
        status,
        planOnly: true,
        reasonCodes: [...new Set(reasons)],
        riskLevel: planResult.eligibility.riskLevel,
        evidenceStatus: planResult.eligibility.evidenceStatus,
        sideEffectCompleteness: planResult.eligibility.sideEffectCompleteness,
      },
      limits: {
        maxAttempts: MAX_RECOVERY_ATTEMPTS,
        attemptsUsed,
        remainingAttempts: Math.max(0, MAX_RECOVERY_ATTEMPTS - attemptsUsed),
        activeAttemptId: active?.id ?? null,
      },
      contextBudget: {
        totalChars: plan?.manifest.totalChars ?? 0,
        p0Chars: DEFAULT_CONTEXT_BUDGET.p0Chars,
        p0Bytes: plan?.manifest.sections.p0 ?? 0,
        p1Bytes: plan?.manifest.sections.p1 ?? 0,
        p2Bytes: plan?.manifest.sections.p2 ?? 0,
        p3Bytes: plan?.manifest.sections.p3 ?? 0,
        trimmed: plan?.manifest.trimmed ?? { p1: false, p2: false, p3: false },
      },
      reopen: {
        required: work.status === 'completed',
        originalWorkStatus: work.status === 'completed' ? 'completed' : null,
        reasonRequired: work.status === 'completed',
      },
      sections: plan?.sections ?? null,
    }
  }

  async start(input: RecoveryStartInput): Promise<RecoveryStartResult> {
    if (input.confirm !== true) {
      throw new RpcMethodError('RECOVERY_CONFIRMATION_REQUIRED', 'confirm=true is required')
    }
    const idempotencyKey = input.idempotencyKey.trim()
    if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
      throw new RpcMethodError('INVALID_PARAMS', 'idempotencyKey must be 1..200 chars')
    }
    const replay = this.deps.attempts.getByIdempotencyKey(input.workId, idempotencyKey)
    if (replay) {
      if (replay.checkpointId !== input.checkpointId) {
        throw new RpcMethodError(
          'RECOVERY_IDEMPOTENCY_CONFLICT',
          'idempotencyKey was already used for another checkpoint',
        )
      }
      return toStartResult(replay, true)
    }

    const work = this.deps.works.get(input.workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${input.workId}`)
    const record = this.deps.checkpoints.getCheckpoint(input.workId, input.checkpointId)
    if (!record) throw new RpcMethodError('RECOVERY_CHECKPOINT_NOT_FOUND', 'checkpoint not found')
    if (record.workId !== work.id) {
      throw new RpcMethodError('RECOVERY_WORK_MISMATCH', 'checkpoint belongs to another work')
    }
    try {
      this.deps.checkpoints.assertCanStart(work.id)
    } catch {
      throw new RpcMethodError('RECOVERY_PLAN_BLOCKED', 'unresolved high-risk checkpoint failure', {
        reasonCodes: ['RECOVERY_REQUIRED'],
      })
    }
    const active = this.deps.attempts.getActiveByWork(work.id)
    if (active) throw new RpcMethodError('RECOVERY_ACTIVE_EXISTS', 'a recovery is already active')
    const activeExecution = this.deps.executionRepository
      .listByWork(work.id)
      .find((execution) => execution.status === 'pending' || execution.status === 'running')
    if (activeExecution) {
      throw new RpcMethodError('RECOVERY_ACTIVE_EXISTS', 'an execution is already active')
    }
    if (this.deps.teamRuns.getActiveByWork(work.id)) {
      throw new RpcMethodError('RECOVERY_ACTIVE_EXISTS', 'a team run is already active')
    }
    if (this.deps.attempts.countByCheckpoint(work.id, record.id) >= MAX_RECOVERY_ATTEMPTS) {
      throw new RpcMethodError('RECOVERY_RETRY_LIMIT_REACHED', 'recovery attempt limit reached')
    }
    const plan = this.plan(work.id, record.id)
    if (plan.eligibility.status === 'blocked') {
      throw new RpcMethodError('RECOVERY_PLAN_BLOCKED', 'recovery plan is blocked', {
        reasonCodes: plan.eligibility.reasonCodes,
      })
    }
    if (
      plan.eligibility.riskLevel === 'high' &&
      plan.eligibility.sideEffectCompleteness !== 'complete'
    ) {
      throw new RpcMethodError(
        'RECOVERY_PLAN_BLOCKED',
        'high-risk recovery requires a complete side-effect ledger',
        { reasonCodes: ['SIDE_EFFECTS_NOT_TRACKED'] },
      )
    }
    if (plan.eligibility.riskLevel === 'high' && input.acknowledgeRisk !== true) {
      throw new RpcMethodError('RECOVERY_RISK_ACK_REQUIRED', 'acknowledgeRisk=true is required')
    }
    if (work.status === 'cancelled' || work.status === 'archived') {
      throw new RpcMethodError('RECOVERY_WORK_STATUS_INVALID', `work is ${work.status}`)
    }
    if (work.status === 'completed') {
      if (record.kind !== 'final_delivery') {
        throw new RpcMethodError('RECOVERY_WORK_STATUS_INVALID', 'only final_delivery can reopen')
      }
      if (!input.reopenReason?.trim()) {
        throw new RpcMethodError(
          'RECOVERY_REOPEN_REASON_REQUIRED',
          'reopenReason is required for completed work',
        )
      }
    }

    const target = this.resolveTarget(work, record)
    const agent = this.deps.agents.get(target.agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${target.agentId}`)
    const prepared = this.preparePrompt(work, record, target, agent)
    const planHash = sha256Hex(canonicalJson(plan))
    const now = this.now()
    const attemptId = newId('rec')
    let teamRun: TeamTaskRunRecord | null = null

    try {
      const t1 = transaction<{ teamRun: TeamTaskRunRecord | null }>(this.deps.db, () => {
        const latestReplay = this.deps.attempts.getByIdempotencyKey(work.id, idempotencyKey)
        if (latestReplay) throw new RpcMethodError('RECOVERY_ACTIVE_EXISTS', 'idempotent replay')
        if (this.deps.attempts.getActiveByWork(work.id)) {
          throw new RpcMethodError('RECOVERY_ACTIVE_EXISTS', 'a recovery is already active')
        }
        const attemptNo = this.deps.attempts.countByCheckpoint(work.id, record.id) + 1
        if (attemptNo > MAX_RECOVERY_ATTEMPTS) {
          throw new RpcMethodError('RECOVERY_RETRY_LIMIT_REACHED', 'attempt limit reached')
        }
        if (target.kind === 'team') {
          teamRun = {
            id: newId('trun'),
            workId: work.id,
            agentId: target.agentId,
            role: target.role,
            triggerMessageId: null,
            subtaskId: target.subtaskId,
            status: 'queued',
            executionId: null,
            errorCode: null,
            errorMessage: null,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            endedAt: null,
          }
          this.deps.teamRuns.insert(teamRun)
        }
        const attempt: RecoveryAttemptRecord = {
          id: attemptId,
          workId: work.id,
          checkpointId: record.id,
          kind: target.kind,
          baseDedupeKey: `recovery:${work.id}:${record.id}`,
          dedupeKey: `recovery:${work.id}:${record.id}#attempt-${attemptNo}`,
          idempotencyKey,
          attemptNo,
          status: 'starting',
          riskLevel: plan.eligibility.riskLevel ?? 'medium',
          eligibilityStatus: plan.eligibility.status,
          originalWorkStatus: work.status === 'completed' ? 'completed' : null,
          reopenReason: work.status === 'completed' ? (input.reopenReason?.trim() ?? null) : null,
          operatorConfirmationJson: canonicalJson({
            confirm: true,
            acknowledgeRisk: input.acknowledgeRisk === true,
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            at: now,
          }),
          planHash,
          contextManifestJson: canonicalJson(prepared.manifest),
          executionId: null,
          sessionId: null,
          teamRunId: teamRun?.id ?? null,
          nodeRunId: null,
          workflowRunId: null,
          branchRunId: null,
          recoveredNodeRunId: null,
          chainAttemptNo: null,
          errorJson: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          endedAt: null,
        }
        this.deps.attempts.insert(attempt)
        this.deps.audit.append({
          actorType: input.actorType ?? 'user',
          actorId: input.actorId ?? null,
          action: 'recovery.started',
          targetType: 'work',
          targetId: work.id,
          details: {
            recoveryAttemptId: attemptId,
            checkpointId: record.id,
            kind: target.kind,
            riskLevel: attempt.riskLevel,
            attemptNo,
          },
          now,
        })
        return { teamRun }
      })
      teamRun = t1.teamRun
    } catch (error) {
      const replayAfterError = this.deps.attempts.getByIdempotencyKey(work.id, idempotencyKey)
      if (replayAfterError) return toStartResult(replayAfterError, true)
      if (error instanceof RpcMethodError) throw error
      throw new RpcMethodError(
        'RECOVERY_START_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }

    try {
      const recovery = {
        attemptId,
        checkpointId: record.id,
        teamRunId: teamRun?.id ?? null,
        ...(target.kind === 'team' && target.role === 'member'
          ? {
              onStarted: () => {
                const subtask = target.subtaskId
                  ? this.deps.teamSubtasks.get(target.subtaskId)
                  : null
                if (!subtask || subtask.status === 'done') {
                  throw new RpcMethodError(
                    'INVALID_PARAMS',
                    'member subtask is already done or missing',
                  )
                }
                this.deps.assignments.ensureWithRoleInTransaction({
                  workId: work.id,
                  agentId: target.agentId,
                  workRole: `team-${target.agentId.slice(-8)}`,
                  teamId: work.ownerTeamId,
                  now,
                  allowInactiveWork: true,
                })
                if (
                  !this.deps.teamSubtasks.updateStatus(
                    subtask.id,
                    ['pending', 'blocked', 'review', 'running'],
                    'running',
                    now,
                  )
                ) {
                  throw new RpcMethodError(
                    'INVALID_PARAMS',
                    'member subtask could not be marked running',
                  )
                }
              },
            }
          : {}),
        ...(work.status === 'completed'
          ? {
              reopenWork: () => {
                this.deps.workService.reopenCompletedInTransaction(
                  work.id,
                  {
                    reason: input.reopenReason?.trim() ?? '',
                    recoveryAttemptId: attemptId,
                    checkpointId: record.id,
                    actorType: input.actorType ?? 'user',
                    actorId: input.actorId ?? null,
                  },
                  this.now(),
                )
              },
            }
          : {}),
      }
      const execution =
        target.kind === 'team' && target.role === 'leader'
          ? await this.deps.executions.startRecovery(
              { agentId: target.agentId, prompt: prepared.prompt },
              {
                recovery,
                allowInactiveWork: true,
                system: {
                  purpose: 'team_leader',
                  toolPermissions: TEAM_LEADER_TOOL_POLICY,
                  allowInactiveWork: true,
                },
              },
            )
          : await this.deps.executions.startRecovery(
              { agentId: target.agentId, workId: work.id, prompt: prepared.prompt },
              {
                recovery,
                allowInactiveWork: work.status !== 'active',
              },
            )
      if (teamRun) {
        if (!this.deps.teamRuns.markRunning(teamRun.id, execution.id, this.now())) {
          await this.deps.executions.cancel({ executionId: execution.id }).catch(() => undefined)
          throw new Error('team run could not be marked running')
        }
      }
      this.deps.audit.append({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'recovery.execution_linked',
        targetType: 'work',
        targetId: work.id,
        details: {
          recoveryAttemptId: attemptId,
          executionId: execution.id,
          sessionId: execution.sessionId,
          teamRunId: teamRun?.id ?? null,
        },
        now: this.now(),
      })
      const saved = this.deps.attempts.get(attemptId) ?? (await this.attemptAfterStart(attemptId))
      return toStartResult(saved, false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.attempts.finish(attemptId, 'failed', canonicalJson({ message }), this.now())
      if (teamRun) {
        this.deps.teamRuns.finish(
          teamRun.id,
          'failed',
          'RECOVERY_START_FAILED',
          message,
          this.now(),
        )
      }
      if (target.kind === 'team' && target.role === 'member' && target.subtaskId) {
        if (
          this.deps.teamSubtasks.updateStatus(target.subtaskId, ['running'], 'blocked', this.now())
        ) {
          this.deps.audit.append({
            actorType: 'system',
            actorId: 'agentra',
            action: 'recovery.subtask_reconciled',
            targetType: 'work',
            targetId: work.id,
            details: {
              recoveryAttemptId: attemptId,
              subtaskId: target.subtaskId,
              from: 'running',
              to: 'blocked',
              reason: 'RECOVERY_START_FAILED',
            },
            now: this.now(),
          })
        }
      }
      this.deps.audit.append({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'recovery.start_failed',
        targetType: 'work',
        targetId: work.id,
        details: {
          recoveryAttemptId: attemptId,
          errorCode: 'RECOVERY_START_FAILED',
          message,
        },
        now: this.now(),
      })
      throw new RpcMethodError('RECOVERY_START_FAILED', message, { recoveryAttemptId: attemptId })
    }
  }

  private finishAttempt(
    attempt: RecoveryAttemptRecord,
    status: Extract<RecoveryAttemptRecord['status'], 'succeeded' | 'failed' | 'cancelled'>,
    details: Record<string, unknown>,
  ): boolean {
    const now = this.now()
    const changed = this.deps.attempts.finish(
      attempt.id,
      status,
      status === 'succeeded' ? null : canonicalJson(details),
      now,
    )
    if (!changed) return false
    const checkpointFailed =
      details.reason === 'CHECKPOINT_CREATE_FAILED' || details.reason === 'CHECKPOINT_NOT_CREATED'
    const action =
      status === 'succeeded'
        ? 'recovery.completed'
        : status === 'cancelled'
          ? 'recovery.cancelled'
          : checkpointFailed
            ? 'recovery.checkpoint_failed'
            : 'recovery.failed'
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action,
      targetType: 'work',
      targetId: attempt.workId,
      details: {
        recoveryAttemptId: attempt.id,
        status,
        ...details,
      },
      now,
    })
    if (attempt.kind === 'workflow_node' && attempt.workflowRunId) {
      try {
        this.deps.onWorkflowAttemptSettled?.({
          workflowRunId: attempt.workflowRunId,
          recoveryAttemptId: attempt.id,
        })
      } catch (error) {
        this.deps.logger?.warn('workflow attempt settled observer failed', {
          recoveryAttemptId: attempt.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return true
  }

  /** Phase 1B-2B：带 Worktree 意图的 workflow_node starting R 必须交给 Reconciler 先处理。 */
  private hasPendingWorktreeIntent(attempt: RecoveryAttemptRecord): boolean {
    if (attempt.kind !== 'workflow_node' || attempt.status !== 'starting') return false
    if (attempt.nodeRunId || attempt.executionId) return false
    try {
      const manifest = JSON.parse(attempt.contextManifestJson) as Record<string, unknown>
      const worktree = manifest.worktree
      if (typeof worktree !== 'object' || worktree === null) return false
      const state = (worktree as Record<string, unknown>).state
      return state === 'creating' || state === 'ready' || state === 'needs_manual_review'
    } catch {
      return false
    }
  }

  /** Phase 1B-2B：NodeRun 终态观察器；Execution 成功不等于 NodeRun 成功。 */
  onWorkflowNodeTerminal(input: {
    nodeRunId: string
    status: 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_required'
    reasonCode?: string
    executionId?: string
  }): void {
    const attempt = this.deps.attempts.getByNodeRunId(input.nodeRunId)
    if (!attempt || (attempt.status !== 'starting' && attempt.status !== 'running')) return
    if (input.status === 'succeeded') return
    if (input.status === 'reconciliation_required') return
    this.finishAttempt(attempt, input.status === 'cancelled' ? 'cancelled' : 'failed', {
      reason: input.reasonCode ?? `node_${input.status}`,
      nodeRunId: input.nodeRunId,
      executionId: input.executionId ?? attempt.executionId,
    })
  }

  onExecutionTerminal(executionId: string, status: 'succeeded' | 'failed' | 'cancelled'): void {
    const attempt = this.deps.attempts.getByExecutionId(executionId)
    if (!attempt || (attempt.status !== 'starting' && attempt.status !== 'running')) return
    // 成功终态必须等 Checkpoint 创建结果；失败/取消可立即收敛。
    if (status === 'succeeded') return
    this.finishAttempt(attempt, status === 'cancelled' ? 'cancelled' : 'failed', {
      reason: `execution_${status}`,
      executionId,
    })
  }

  onCheckpointResult(event: CheckpointCreationEvent): void {
    const attempt = this.deps.attempts.getByExecutionId(event.executionId)
    if (!attempt || (attempt.status !== 'starting' && attempt.status !== 'running')) return
    const execution = this.deps.executionRepository.get(event.executionId)
    if (!execution) {
      this.finishAttempt(attempt, 'failed', {
        reason: 'EXECUTION_MISSING',
        checkpointId: event.checkpointId,
      })
      return
    }
    if (execution.status === 'failed' || execution.status === 'crashed') {
      this.finishAttempt(attempt, 'failed', {
        reason: `execution_${execution.status}`,
        checkpointId: event.checkpointId,
      })
      return
    }
    if (execution.status === 'cancelled') {
      this.finishAttempt(attempt, 'cancelled', {
        reason: 'execution_cancelled',
        checkpointId: event.checkpointId,
      })
      return
    }
    if (execution.status !== 'succeeded') return
    if (event.outcome === 'skipped') return
    if (event.outcome === 'failed' || event.checkpointState === 'failed') {
      this.finishAttempt(attempt, 'failed', {
        reason: 'CHECKPOINT_CREATE_FAILED',
        stage: 'checkpoint_create',
        checkpointId: event.checkpointId,
        executionId: event.executionId,
        riskLevel: event.riskLevel,
        reasonCodes: event.reasons,
      })
      return
    }
    if (attempt.kind === 'workflow_node') {
      const checkpoint = event.checkpointId
        ? this.deps.checkpoints.getCheckpoint(attempt.workId, event.checkpointId)
        : null
      if (
        !checkpoint ||
        checkpoint.executionId !== event.executionId ||
        checkpoint.nodeRunId !== attempt.nodeRunId ||
        checkpoint.state !== 'valid' ||
        checkpoint.workId !== attempt.workId
      ) {
        this.finishAttempt(attempt, 'failed', {
          reason: 'CHECKPOINT_RECOVERY_MISMATCH',
          checkpointId: event.checkpointId,
          executionId: event.executionId,
        })
        return
      }
    }
    this.finishAttempt(attempt, 'succeeded', {
      checkpointId: event.checkpointId,
      executionId: event.executionId,
    })
  }

  subscribe(hub: CoreEventHub): () => void {
    return hub.subscribe((event: RuntimeEvent) => {
      if (event.eventType === 'execution.exited') {
        const parsed = ExecutionExitedPayload.safeParse(event.payload)
        if (!parsed.success) return
        const status =
          parsed.data.reason === 'cancelled'
            ? 'cancelled'
            : parsed.data.exitCode === 0
              ? 'succeeded'
              : 'failed'
        this.onExecutionTerminal(event.aggregateId, status)
        return
      }
      if (event.eventType !== 'execution.state') return
      const parsed = ExecutionStatePayload.safeParse(event.payload)
      if (!parsed.success) return
      if (
        parsed.data.status === 'succeeded' ||
        parsed.data.status === 'failed' ||
        parsed.data.status === 'cancelled' ||
        parsed.data.status === 'crashed'
      ) {
        this.onExecutionTerminal(
          event.aggregateId,
          parsed.data.status === 'crashed' ? 'failed' : parsed.data.status,
        )
      }
    })
  }

  recoverOnStartup(): void {
    for (const attempt of this.deps.attempts.listUnfinished()) {
      if (this.hasPendingWorktreeIntent(attempt)) continue
      if (!attempt.executionId) {
        this.finishStartupAttempt(attempt, 'START_INTERRUPTED')
        continue
      }
      const execution = this.deps.executionRepository.get(attempt.executionId)
      if (!execution) {
        this.finishStartupAttempt(attempt, 'EXECUTION_MISSING')
        continue
      }
      if (
        execution.status === 'succeeded' ||
        execution.status === 'failed' ||
        execution.status === 'cancelled' ||
        execution.status === 'crashed'
      ) {
        this.finalizeFromTerminal(attempt, execution)
        continue
      }
      if (attempt.status === 'starting') {
        this.deps.attempts.markRunning(
          attempt.id,
          {
            executionId: execution.id,
            sessionId: execution.sessionId,
            teamRunId: attempt.teamRunId,
          },
          this.now(),
        )
      }
    }
  }

  /**
   * T3 提交后、spawn 前崩溃的对账。必须在 Daemon 连接和 ExecutionService.reconcile 之后调用。
   * 只有确认未启动时才收敛为 failed；无法确认时保留 running 并写明确审计，绝不自动重发。
   */
  async reconcileInterruptedStarts(daemonAvailable: boolean): Promise<void> {
    for (const attempt of this.deps.attempts.listUnfinished()) {
      if (this.hasPendingWorktreeIntent(attempt)) continue
      if (!attempt.executionId) continue
      const execution = this.deps.executionRepository.get(attempt.executionId)
      if (!execution) {
        this.finishStartupAttempt(attempt, 'EXECUTION_MISSING')
        continue
      }
      if (
        execution.status === 'succeeded' ||
        execution.status === 'failed' ||
        execution.status === 'cancelled' ||
        execution.status === 'crashed'
      ) {
        this.finalizeFromTerminal(attempt, execution)
        continue
      }
      if (execution.status !== 'pending') continue
      if (!daemonAvailable) {
        this.auditStartUnconfirmed(attempt, execution.id, 'DAEMON_UNAVAILABLE')
        continue
      }
      const classification = await this.deps.executions.classifyPendingStart(execution.id)
      if (classification === 'spawned') continue
      if (classification === 'unconfirmed') {
        this.auditStartUnconfirmed(attempt, execution.id, 'NO_START_EVIDENCE')
        continue
      }
      if (!this.deps.executions.failUnstartedExecution(execution.id, 'START_INTERRUPTED')) {
        this.auditStartUnconfirmed(attempt, execution.id, 'CONCURRENT_CHANGE')
        continue
      }
      this.finishStartupAttempt(attempt, 'START_INTERRUPTED', execution.id)
    }
  }

  private finalizeFromTerminal(
    attempt: RecoveryAttemptRecord,
    execution: NonNullable<ReturnType<ExecutionRepository['get']>>,
  ): void {
    if (execution.status === 'succeeded') {
      const checkpoint = this.deps.checkpoints.getCheckpointForExecution(execution.id)
      if (
        checkpoint?.state === 'valid' &&
        (attempt.kind !== 'workflow_node' ||
          (checkpoint.nodeRunId === attempt.nodeRunId && checkpoint.executionId === execution.id))
      ) {
        this.finishAttempt(attempt, 'succeeded', {
          checkpointId: checkpoint.id,
          executionId: execution.id,
        })
        return
      }
      if (checkpoint?.state === 'failed') {
        this.finishAttempt(attempt, 'failed', {
          reason: 'CHECKPOINT_CREATE_FAILED',
          stage: 'checkpoint_create',
          checkpointId: checkpoint.id,
          executionId: execution.id,
          riskLevel: checkpoint.riskLevel,
        })
        return
      }
      this.finishAttempt(attempt, 'failed', {
        reason: 'CHECKPOINT_NOT_CREATED',
        stage: 'checkpoint_create',
        executionId: execution.id,
      })
      return
    }
    if (execution.status === 'cancelled') {
      this.finishAttempt(attempt, 'cancelled', {
        reason: 'execution_cancelled',
        executionId: execution.id,
      })
      return
    }
    this.finishAttempt(attempt, 'failed', {
      reason: `execution_${execution.status}`,
      executionId: execution.id,
    })
  }

  private finishStartupAttempt(
    attempt: RecoveryAttemptRecord,
    reason: string,
    executionId: string | null = null,
  ): void {
    const changed = this.finishAttempt(attempt, 'failed', {
      reason,
      ...(executionId ? { executionId } : {}),
      stage: 'recovery_start',
    })
    if (!changed) return
    if (attempt.teamRunId) {
      this.deps.teamRuns.finish(attempt.teamRunId, 'failed', reason, reason, this.now())
    }
    this.compensateMemberSubtask(attempt, reason)
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'recovery.crash_reconciled',
      targetType: 'work',
      targetId: attempt.workId,
      details: {
        recoveryAttemptId: attempt.id,
        reason,
        executionId,
        teamRunId: attempt.teamRunId,
      },
      now: this.now(),
    })
  }

  private compensateMemberSubtask(attempt: RecoveryAttemptRecord, reason: string): void {
    if (!attempt.teamRunId) return
    const run = this.deps.teamRuns.get(attempt.teamRunId)
    if (!run || run.role !== 'member' || !run.subtaskId) return
    if (this.deps.teamSubtasks.updateStatus(run.subtaskId, ['running'], 'blocked', this.now())) {
      this.deps.audit.append({
        actorType: 'system',
        actorId: 'agentra',
        action: 'recovery.subtask_reconciled',
        targetType: 'work',
        targetId: attempt.workId,
        details: {
          recoveryAttemptId: attempt.id,
          subtaskId: run.subtaskId,
          from: 'running',
          to: 'blocked',
          reason,
        },
        now: this.now(),
      })
    }
  }

  private auditStartUnconfirmed(
    attempt: RecoveryAttemptRecord,
    executionId: string,
    reason: string,
  ): void {
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'recovery.start_unconfirmed',
      targetType: 'work',
      targetId: attempt.workId,
      details: {
        recoveryAttemptId: attempt.id,
        executionId,
        reason,
      },
      now: this.now(),
    })
  }

  private resolveTarget(work: WorkRecord, record: CheckpointRecord): RecoveryTarget {
    if (record.teamRunId) {
      const run = this.deps.teamRuns.get(record.teamRunId)
      if (!run?.agentId) {
        throw new RpcMethodError('INVALID_PARAMS', 'checkpoint team run is not recoverable')
      }
      if (run.role === 'member') {
        const subtask = run.subtaskId ? this.deps.teamSubtasks.get(run.subtaskId) : null
        if (!subtask || subtask.status === 'done') {
          throw new RpcMethodError('INVALID_PARAMS', 'member subtask is already done or missing')
        }
      }
      return {
        kind: 'team',
        agentId: run.agentId,
        role: run.role,
        subtaskId: run.subtaskId,
        teamId: work.ownerTeamId,
      }
    }
    if (work.ownerTeamId) {
      const team = this.deps.teams.get(work.ownerTeamId)
      if (!team || team.status !== 'active' || !team.leaderAgentId) {
        throw new RpcMethodError('INVALID_PARAMS', 'work team has no active leader')
      }
      return {
        kind: 'team',
        agentId: team.leaderAgentId,
        role: 'leader',
        subtaskId: null,
        teamId: team.id,
      }
    }
    const assignment = work.assigneeAgentId
      ? null
      : this.deps.assignmentRepository
          .listByWork(work.id)
          .find((candidate) => candidate.status === 'active')
    const agentId = work.assigneeAgentId ?? assignment?.agentId
    if (!agentId) throw new RpcMethodError('INVALID_PARAMS', 'work has no recovery agent')
    return { kind: 'generic', agentId }
  }

  private preparePrompt(
    work: WorkRecord,
    record: CheckpointRecord,
    target: RecoveryTarget,
    agent: NonNullable<ReturnType<AgentRepository['get']>>,
  ): PreparedPrompt {
    const checkpointJson = CheckpointJsonSchema.parse(JSON.parse(record.checkpointJson))
    const evidence = CheckpointEvidenceSchema.parse(JSON.parse(record.evidenceJson))
    const taskMemory = this.deps.taskMemories.get(work.id) ?? checkpointJson.memory
    const messages = this.deps.teamMessages
      .listByWork(work.id, 200)
      .slice(-40)
      .map((message) => ({
        authorType: message.authorType,
        content: message.content,
        createdAt: message.createdAt,
      }))
    try {
      const built = buildRecoveryPrompt({
        work: {
          id: work.id,
          name: work.name,
          objective: work.objective,
          acceptanceCriteria: work.acceptanceCriteria,
          acceptanceCriteriaVersion: work.acceptanceCriteriaVersion,
        },
        taskMemory,
        checkpoint: {
          id: record.id,
          seq: record.seq,
          kind: record.kind,
          json: checkpointJson,
        },
        agent: {
          name: agent.name,
          accessMode: agent.accessMode,
          systemPrompt: agent.systemPrompt,
        },
        messages,
        artifacts: evidence.artifacts.map((artifact) => ({
          name: artifact.artifactId,
          version: artifact.version,
          checksum: artifact.checksum,
        })),
        files: checkpointJson.files.map((file) => ({
          relativePath: file.relativePath,
          status: file.status,
          verification: file.verification,
        })),
        sideEffects: checkpointJson.sideEffects.refs,
        checkpointId: record.id,
      })
      const roleInstructions = this.teamRoleInstructions(target)
      const prompt = roleInstructions ? `${built.prompt}\n\n${roleInstructions}` : built.prompt
      if (prompt.length > DEFAULT_CONTEXT_BUDGET.totalChars) {
        throw new ContextBudgetExceededError(
          prompt.length,
          DEFAULT_CONTEXT_BUDGET.totalChars,
          'total',
        )
      }
      return {
        prompt,
        manifest: {
          ...built.manifest,
          role: target.kind === 'team' ? target.role : 'generic',
          roleInstructionsChars: roleInstructions.length,
          ...(target.kind === 'team' && target.role === 'member'
            ? { subtaskId: target.subtaskId }
            : {}),
        },
      }
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) {
        throw new RpcMethodError(
          'RECOVERY_CONTEXT_BUDGET_EXCEEDED',
          'recovery context exceeds budget',
          {
            section: error.section,
            actualChars: error.actualChars,
            budgetChars: error.budgetChars,
          },
        )
      }
      throw error
    }
  }

  private teamRoleInstructions(target: RecoveryTarget): string {
    if (target.kind !== 'team') return ''
    if (target.role === 'member') {
      const subtask = target.subtaskId ? this.deps.teamSubtasks.get(target.subtaskId) : null
      return [
        '## Team member execution',
        'You are a team member. Do the assigned subtask and report back to the leader.',
        subtask
          ? `Subtask: ${subtask.title}\n${subtask.description}`
          : 'Subtask: (recover the current team work)',
        'Do not repeat work already marked done in the checkpoint.',
        'Return one JSON object only:',
        '{"reply":"what you did / what you need","blocked":false,"question":null}',
      ].join('\n')
    }
    const team = target.teamId ? this.deps.teams.get(target.teamId) : null
    const members = team
      ? this.deps.teams
          .listMembers(team.id)
          .map((member) => this.deps.agents.get(member.agentId))
          .filter(
            (agent): agent is NonNullable<typeof agent> =>
              agent !== null && agent.id !== target.agentId,
          )
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description.slice(0, 300),
            accessMode: agent.accessMode,
          }))
      : []
    return [
      '## Team leader execution',
      `You are the leader of team "${team?.name ?? 'this team'}". You do not execute tasks; you split, assign and review.`,
      `Members: ${JSON.stringify(members)}`,
      'Do not repeat already completed subtasks. Do not assign work to yourself.',
      'Return one JSON object only:',
      '{"reply":"...","subtasks":[{"title":"...","description":"...","assigneeAgentId":"agent-id"}],"completeSubtaskIds":[],"decision":null,"escalateToPlanner":false,"plannerQuestion":null}',
    ].join('\n')
  }

  private async attemptAfterStart(attemptId: string): Promise<RecoveryAttemptRecord> {
    const saved = this.deps.attempts.get(attemptId)
    if (!saved) throw new RpcMethodError('RECOVERY_START_FAILED', 'attempt disappeared')
    return saved
  }
}

function toStartResult(attempt: RecoveryAttemptRecord, replay: boolean): RecoveryStartResult {
  return {
    recoveryAttemptId: attempt.id,
    status: attempt.status,
    executionId: attempt.executionId,
    sessionId: attempt.sessionId,
    teamRunId: attempt.teamRunId,
    idempotentReplay: replay,
  }
}
