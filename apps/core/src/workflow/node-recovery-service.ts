import { randomUUID } from 'node:crypto'
import { type Execution, RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { BranchRunRecord, BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { CheckpointRecord } from '../db/repositories/checkpoint-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  RecoveryAttemptRecord,
  RecoveryAttemptRepository,
} from '../db/repositories/recovery-attempt-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import { canonicalJson } from '../services/checkpoint-hash'
import type { CheckpointService } from '../services/checkpoint-service'
import type { RecoveryTxContext } from '../services/execution-service'
import { describeOutputContract } from './artifact-exchange'
import type { WorkflowAssignmentResolver } from './assignment-resolver'
import type { PublishedDefinitionProvider } from './published-definition-provider'
import type {
  WorkflowRecoveryWorktreeFacts,
  WorkflowRecoveryWorktreeService,
} from './recovery-worktree'

export const MAX_WORKFLOW_RECOVERY_ATTEMPTS = 3

export type WorkflowNodeRecoveryExecutionPort = {
  prepareRecoveryForNode(
    tx: RecoveryTxContext,
    nodeRunId: string,
    params: {
      agentId: string
      workId: string
      prompt: string
      worktreeId: string
    },
    options: { recoveryAttemptId: string; checkpointId: string },
  ): { executionId: string; sessionId: string }
  spawnPreparedRecovery(executionId: string): Promise<Execution>
  discardPreparedRecovery(executionId: string): void
  classifyPendingStart(executionId: string): Promise<'spawned' | 'not_started' | 'unconfirmed'>
}

export type WorkflowNodeRecoveryPlanView = {
  target: {
    workflowRunId: string
    branchRunId: string | null
    branchKey: string | null
    nodeKey: string
    nodeRunId: string
    attempt: number
    status: string
    recoveryChainId: string
  }
  eligibility: {
    status: 'eligible' | 'conditional' | 'blocked'
    planOnly: true
    reasonCodes: string[]
    riskLevel: 'low' | 'medium' | 'high' | null
    evidenceStatus: string | null
    sideEffectCompleteness: string | null
    executionEvidence: 'not_started' | 'terminal' | 'active' | 'unconfirmed'
    requiresRiskAcknowledgement: boolean
  }
  checkpoint: {
    id: string
    seq: number
    kind: string
    isLatest: boolean
    nodeRunId: string | null
  } | null
  limits: {
    maxAttempts: number
    attemptsUsed: number
    remainingAttempts: number
    activeRecoveryAttemptId: string | null
  }
  nextAttempt: { attempt: number; branchRunId: string | null }
  worktree: {
    required: true
    policy: 'worktree' | 'work_root' | 'shared'
    branchNamePreview: string | null
    blockers: string[]
  }
  chain: { key: string; attemptNo: number; attemptsUsed: number }
  runReentry: { required: boolean; allowed: boolean; blockers: string[] }
  contextBudget: {
    totalChars: number
    trimmed: { p1: boolean; p2: boolean; p3: boolean }
  }
  sections: { p0: string; p1: string; p2: string; p3: string } | null
}

export type WorkflowNodeRecoveryStartView = {
  recoveryAttemptId: string
  status: RecoveryAttemptRecord['status']
  newNodeRunId: string
  executionId: string | null
  sessionId: string | null
  idempotentReplay: boolean
}

export type WorkflowNodeRecoveryDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  works: WorkRepository
  attempts: RecoveryAttemptRepository
  executions: ExecutionRepository
  definitions: PublishedDefinitionProvider
  assignments: WorkflowAssignmentResolver
  checkpoints: Pick<CheckpointService, 'getCheckpoint' | 'getRecoveryPlan' | 'assertCanStart'>
  executionRunner: WorkflowNodeRecoveryExecutionPort
  worktrees: WorkflowRecoveryWorktreeService
  /**
   * T2 构建恢复 Prompt：与普通执行一样解析输入 Artifact 并生成输出契约。
   * 必须在 T3 之前调用；T3 只接收字符串，不做文件系统读取。
   */
  buildRecoveryPrompt?: (context: {
    run: WorkflowRunRecord
    node: WorkflowNode
    definition: WorkflowDefinition
  }) => string
  audit?: Pick<AuditRepository, 'append'>
  logger?: { warn(message: string, meta?: Record<string, unknown>): void }
  /** Run 重入成功后触发 scheduler kick。 */
  onRunReentered?: (workflowRunId: string) => void
  now?: () => string
}

type LoadedTarget = {
  run: WorkflowRunRecord
  branch: BranchRunRecord | null
  nodeRun: NodeRunRecord
  nodeKey: string
  chainId: string
  definition: ReturnType<PublishedDefinitionProvider['get']>['definition']
  node: ReturnType<PublishedDefinitionProvider['get']>['definition']['nodes'][number]
}

function latestAttempt(nodes: NodeRunRepository, runId: string, key: string): NodeRunRecord | null {
  const attempts = nodes.listByRunAndKey(runId, key)
  return attempts.length === 0 ? null : (attempts[attempts.length - 1] as NodeRunRecord)
}

function parseManifest(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export class WorkflowNodeRecoveryService {
  private readonly now: () => string

  constructor(private readonly deps: WorkflowNodeRecoveryDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async plan(input: {
    workflowRunId: string
    nodeRunId: string
    checkpointId?: string
  }): Promise<WorkflowNodeRecoveryPlanView> {
    const target = this.loadTarget(input.workflowRunId, input.nodeRunId)
    const reasons: string[] = []
    let status: 'eligible' | 'conditional' | 'blocked' = 'eligible'
    const block = (reason: string): void => {
      reasons.push(reason)
      status = 'blocked'
    }
    const evidence = await this.classifyEvidence(target.nodeRun)
    if (evidence === 'active') block('NODE_RECOVERY_EXECUTION_ACTIVE')
    if (evidence === 'unconfirmed') block('NODE_RECOVERY_EXECUTION_UNCONFIRMED')
    if (target.node.type !== 'agent_task') block('NODE_RECOVERY_NODE_TYPE_UNSUPPORTED')
    const policy =
      target.node.type === 'agent_task' ? target.node.config.workingDirectoryPolicy : 'shared'
    const worktreeBlockers: string[] = []
    if (policy !== 'worktree') {
      worktreeBlockers.push('NODE_RECOVERY_WORKTREE_REQUIRED')
      block('NODE_RECOVERY_WORKTREE_REQUIRED')
    }
    if (target.run.status !== 'running' && target.run.status !== 'reconciliation_required') {
      block('NODE_RECOVERY_RUN_STATE_INVALID')
    }
    const work = this.deps.works.get(target.run.workId)
    if (!work || work.status !== 'active') block('NODE_RECOVERY_WORK_STATE_INVALID')
    if (target.branch?.status !== 'active') block('NODE_RECOVERY_BRANCH_NOT_ACTIVE')
    const latest = latestAttempt(this.deps.nodes, target.run.id, target.nodeRun.workflowNodeKey)
    if (!latest || latest.id !== target.nodeRun.id) block('NODE_RECOVERY_TARGET_NOT_LATEST')
    const recoverable =
      target.nodeRun.status === 'reconciliation_required' ||
      this.isRecoveryFailedAttempt(target.nodeRun)
    if (!recoverable) block('NODE_RECOVERY_TARGET_NOT_RECOVERABLE')

    const checkpoint = this.deps.checkpoints.getCheckpoint(work?.id ?? '', input.checkpointId)
    if (!checkpoint) block('NODE_RECOVERY_CHECKPOINT_NOT_FOUND')
    let planResult: ReturnType<CheckpointService['getRecoveryPlan']> | null = null
    if (checkpoint) {
      planResult = this.deps.checkpoints.getRecoveryPlan(checkpoint.workId, checkpoint.id)
      if (planResult.eligibility.status === 'blocked') {
        for (const reason of planResult.eligibility.reasonCodes) reasons.push(reason)
        status = 'blocked'
      }
      try {
        this.deps.checkpoints.assertCanStart(checkpoint.workId)
      } catch {
        block('RECOVERY_REQUIRED')
      }
    }

    const attemptsUsed = this.deps.attempts.countByRecoveredNodeRun(target.chainId)
    const active = this.deps.attempts.getActiveByWork(target.run.workId)
    const activeChain = this.deps.attempts.getActiveByRecoveredNodeRun(target.chainId)
    if (active) block('NODE_RECOVERY_ACTIVE_EXISTS')
    if (attemptsUsed >= MAX_WORKFLOW_RECOVERY_ATTEMPTS) block('NODE_RECOVERY_LIMIT_REACHED')
    try {
      const assignment = this.deps.assignments.resolveForNode(target.run.workId, target.node)
      if (assignment.agentId.length === 0) block('NODE_RECOVERY_ASSIGNMENT_UNRESOLVED')
    } catch {
      block('NODE_RECOVERY_ASSIGNMENT_UNRESOLVED')
    }

    const nextAttempt = (latest?.attempt ?? target.nodeRun.attempt) + 1
    const chainAttemptNo = this.deps.attempts.nextChainAttemptNo(target.chainId)
    const branchNamePreview =
      policy === 'worktree'
        ? this.deps.worktrees.branchName({
            workflowRunId: target.run.id,
            nodeKey: target.nodeRun.workflowNodeKey,
            newNodeRunId: 'preview-preview',
            chainAttemptNo,
          })
        : null
    const runReentry = this.runReentryBlockers(target.run, activeChain)
    return {
      target: {
        workflowRunId: target.run.id,
        branchRunId: target.branch?.id ?? null,
        branchKey: target.branch?.branchKey ?? null,
        nodeKey: target.nodeRun.workflowNodeKey,
        nodeRunId: target.nodeRun.id,
        attempt: target.nodeRun.attempt,
        status: target.nodeRun.status,
        recoveryChainId: target.chainId,
      },
      eligibility: {
        status,
        planOnly: true,
        reasonCodes: [...new Set(reasons)],
        riskLevel: planResult?.eligibility.riskLevel ?? checkpoint?.riskLevel ?? null,
        evidenceStatus:
          planResult?.eligibility.evidenceStatus ?? checkpoint?.evidenceStatus ?? null,
        sideEffectCompleteness:
          planResult?.eligibility.sideEffectCompleteness ??
          checkpoint?.sideEffectCompleteness ??
          null,
        executionEvidence: evidence,
        requiresRiskAcknowledgement:
          (planResult?.eligibility.riskLevel ?? checkpoint?.riskLevel) === 'high',
      },
      checkpoint: checkpoint
        ? {
            id: checkpoint.id,
            seq: checkpoint.seq,
            kind: checkpoint.kind,
            isLatest: checkpoint.id === this.deps.checkpoints.getCheckpoint(work?.id ?? '')?.id,
            nodeRunId: checkpoint.nodeRunId,
          }
        : null,
      limits: {
        maxAttempts: MAX_WORKFLOW_RECOVERY_ATTEMPTS,
        attemptsUsed,
        remainingAttempts: Math.max(0, MAX_WORKFLOW_RECOVERY_ATTEMPTS - attemptsUsed),
        activeRecoveryAttemptId: active?.id ?? null,
      },
      nextAttempt: { attempt: nextAttempt, branchRunId: target.branch?.id ?? null },
      worktree: {
        required: true,
        policy,
        branchNamePreview,
        blockers: worktreeBlockers,
      },
      chain: { key: target.chainId, attemptNo: chainAttemptNo, attemptsUsed },
      runReentry,
      contextBudget: {
        totalChars: planResult?.plan?.manifest.totalChars ?? 0,
        trimmed: planResult?.plan?.manifest.trimmed ?? { p1: false, p2: false, p3: false },
      },
      sections: planResult?.plan?.sections ?? null,
    }
  }

  async start(input: {
    workflowRunId: string
    nodeRunId: string
    checkpointId?: string
    confirm: boolean
    acknowledgeRisk?: boolean
    idempotencyKey: string
  }): Promise<WorkflowNodeRecoveryStartView> {
    if (input.confirm !== true) {
      throw new RpcMethodError('NODE_RECOVERY_CONFIRMATION_REQUIRED', 'confirm=true is required')
    }
    const target = this.loadTarget(input.workflowRunId, input.nodeRunId)
    const replay = this.deps.attempts.getByIdempotencyKey(target.run.workId, input.idempotencyKey)
    if (replay) {
      if (
        replay.kind !== 'workflow_node' ||
        replay.workflowRunId !== target.run.id ||
        replay.recoveredNodeRunId !== target.chainId
      ) {
        throw new RpcMethodError(
          'NODE_RECOVERY_IDEMPOTENCY_CONFLICT',
          'idempotencyKey belongs to another target',
        )
      }
      return this.toStartView(replay, true)
    }
    const plan = await this.plan(input)
    if (plan.eligibility.status === 'blocked') {
      throw new RpcMethodError(
        'NODE_RECOVERY_TARGET_NOT_RECOVERABLE',
        `node recovery is blocked: ${plan.eligibility.reasonCodes.join(', ')}`,
        { reasonCodes: plan.eligibility.reasonCodes },
      )
    }
    if (plan.eligibility.requiresRiskAcknowledgement && input.acknowledgeRisk !== true) {
      throw new RpcMethodError(
        'NODE_RECOVERY_RISK_ACKNOWLEDGEMENT_REQUIRED',
        'acknowledgeRisk=true is required',
      )
    }
    const checkpoint = this.deps.checkpoints.getCheckpoint(target.run.workId, input.checkpointId)
    if (!checkpoint)
      throw new RpcMethodError('NODE_RECOVERY_CHECKPOINT_NOT_FOUND', 'no valid checkpoint')
    // T2：在任何 T3 事务之前解析输入 Artifact 并构建完整恢复 Prompt。
    const recoveryPrompt = this.composeRecoveryPrompt(target, plan)
    const worktreeIntent = await this.prepareIntent(target, checkpoint, plan, input.idempotencyKey)
    try {
      const prepared = this.startTransaction(
        target,
        checkpoint,
        plan,
        worktreeIntent,
        input.idempotencyKey,
        recoveryPrompt,
      )
      const execution = await this.deps.executionRunner
        .spawnPreparedRecovery(prepared.executionId)
        .catch(async (error) => {
          await this.convergeSpawnFailure(
            prepared.recoveryAttemptId,
            'RECOVERY_SPAWN_FAILED',
            error,
          )
          throw error
        })
      const attempt = this.deps.attempts.get(prepared.recoveryAttemptId)
      if (!attempt)
        throw new RpcMethodError('NODE_RECOVERY_NOT_FOUND', 'recovery attempt not found')
      return { ...this.toStartView(attempt, false), executionId: execution.id }
    } catch (error) {
      try {
        await this.convergeAfterT3Failure(worktreeIntent.attempt.id, 'T3_ROLLED_BACK', true)
      } catch (convergeError) {
        this.deps.logger?.warn('T3 failure convergence failed; leaving R starting', {
          recoveryAttemptId: worktreeIntent.attempt.id,
          error: convergeError instanceof Error ? convergeError.message : String(convergeError),
        })
      }
      try {
        this.audit('workflow.node.recovery.start_failed', {
          workflowRunId: target.run.id,
          nodeRunId: target.nodeRun.id,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (auditError) {
        // 数据库不可写时审计也会失败；不得用它覆盖原始启动错误。
        this.deps.logger?.warn('workflow node recovery failure audit failed', {
          error: auditError instanceof Error ? auditError.message : String(auditError),
        })
      }
      throw error
    }
  }

  async convergeAfterT3Failure(
    recoveryAttemptId: string,
    reason: string,
    worktreeCreated = false,
  ): Promise<void> {
    const attempt = this.deps.attempts.get(recoveryAttemptId)
    if (!attempt || attempt.status !== 'starting') return
    const manifest = parseManifest(attempt.contextManifestJson)
    const worktree = (manifest.worktree ?? {}) as Record<string, unknown>
    const state = typeof worktree.state === 'string' ? worktree.state : 'creating'
    if (state === 'needs_manual_review') return
    const disposition = worktreeCreated || state === 'ready' ? 'orphaned' : 'abandoned'
    const nextManifest = {
      ...manifest,
      worktree: { ...worktree, state: disposition, reason, updatedAt: this.now() },
    }
    try {
      transaction(this.deps.db, () => {
        const updated = this.deps.attempts.updateWorktreeDisposition(
          attempt.id,
          state,
          canonicalJson(nextManifest),
          this.now(),
        )
        if (!updated) return
        this.deps.attempts.finish(
          attempt.id,
          'failed',
          canonicalJson({ reason, stage: 't3_rollback' }),
          this.now(),
        )
        this.audit('workflow.node.recovery.t3_failure_converged', {
          recoveryAttemptId: attempt.id,
          reason,
          disposition,
        })
      })
    } catch (error) {
      this.deps.logger?.warn('T3 failure convergence transaction failed; leaving R starting', {
        recoveryAttemptId: attempt.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 启动时 Worktree 对账：只处理 starting 且没有 NodeRun/Execution 的 workflow_node R。 */
  async reconcileStartup(attempt: RecoveryAttemptRecord): Promise<void> {
    if (attempt.kind !== 'workflow_node' || attempt.status !== 'starting') return
    if (attempt.nodeRunId || attempt.executionId) return
    const manifest = parseManifest(attempt.contextManifestJson)
    const worktree = (manifest.worktree ?? {}) as Record<string, unknown>
    if (Object.keys(worktree).length === 0) return
    const state = typeof worktree.state === 'string' ? worktree.state : 'creating'
    if (state === 'needs_manual_review') return
    const facts = worktree as unknown as WorkflowRecoveryWorktreeFacts
    let disposition: 'orphaned' | 'abandoned' | 'needs_manual_review' = 'abandoned'
    let reason = 'WORKTREE_CREATION_INTERRUPTED'
    try {
      if (state === 'ready') {
        if (facts.worktreePath && facts.branchName && facts.worktreeId) {
          this.deps.worktrees.validate(attempt.workId, facts, {
            branchName: facts.branchName,
            newNodeRunId: String(worktree.newNodeRunId ?? ''),
          })
          disposition = 'orphaned'
          reason = 'START_INTERRUPTED'
        } else {
          disposition = 'needs_manual_review'
          reason = 'WORKTREE_FACTS_INCOMPLETE'
        }
      } else if (facts.worktreePath) {
        const creation = this.deps.worktrees.inspectCreation(attempt.workId, facts)
        if (creation === 'registered') {
          disposition = 'orphaned'
          reason = 'WORKTREE_CREATED_UNCONFIRMED'
        } else if (creation === 'absent') {
          disposition = 'abandoned'
          reason = 'WORKTREE_CREATION_INTERRUPTED'
        } else {
          disposition = 'needs_manual_review'
          reason = 'WORKTREE_STATE_UNCONFIRMED'
        }
      }
    } catch {
      disposition = 'needs_manual_review'
      reason = 'WORKTREE_STATE_UNCONFIRMED'
    }
    const nextManifest = {
      ...manifest,
      worktree: { ...worktree, state: disposition, reason, updatedAt: this.now() },
    }
    transaction(this.deps.db, () => {
      if (
        !this.deps.attempts.updateWorktreeDisposition(
          attempt.id,
          state,
          canonicalJson(nextManifest),
          this.now(),
        )
      ) {
        return
      }
      if (disposition === 'orphaned' || disposition === 'abandoned') {
        this.deps.attempts.finish(
          attempt.id,
          'failed',
          canonicalJson({ reason, stage: 'startup_worktree_reconciliation' }),
          this.now(),
        )
      }
      this.audit('workflow.node.recovery.worktree_reconciled', {
        recoveryAttemptId: attempt.id,
        disposition,
        reason,
      })
    })
  }

  private loadTarget(workflowRunId: string, nodeRunId: string): LoadedTarget {
    const run = this.deps.runs.get(workflowRunId)
    if (!run)
      throw new RpcMethodError('NODE_RECOVERY_NOT_FOUND', 'workflow run or node run not found')
    const nodeRun = this.deps.nodes.get(nodeRunId)
    if (!nodeRun || nodeRun.workflowRunId !== run.id) {
      throw new RpcMethodError('NODE_RECOVERY_NOT_FOUND', 'workflow run or node run not found')
    }
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const node = definition.nodes.find((candidate) => candidate.key === nodeRun.workflowNodeKey)
    if (!node)
      throw new RpcMethodError('NODE_RECOVERY_NOT_FOUND', 'workflow run or node run not found')
    const branch = nodeRun.branchRunId ? this.deps.branches.get(nodeRun.branchRunId) : null
    const recoveryOrigin = this.deps.attempts.getByNodeRunId(nodeRun.id)
    return {
      run,
      branch,
      nodeRun,
      nodeKey: nodeRun.workflowNodeKey,
      chainId: recoveryOrigin?.recoveredNodeRunId ?? nodeRun.id,
      definition,
      node,
    }
  }

  private isRecoveryFailedAttempt(nodeRun: NodeRunRecord): boolean {
    if (nodeRun.status !== 'failed') return false
    const attempt = this.deps.attempts.getByNodeRunId(nodeRun.id)
    return attempt !== null && attempt.status === 'failed'
  }

  private async classifyEvidence(
    nodeRun: NodeRunRecord,
  ): Promise<'not_started' | 'terminal' | 'active' | 'unconfirmed'> {
    const active = this.deps.executions.findActiveByNodeRun(nodeRun.id)
    if (active) {
      if (active.status !== 'pending') return 'active'
      const classification = await this.deps.executionRunner.classifyPendingStart(active.id)
      if (classification === 'not_started') return 'not_started'
      if (classification === 'spawned') return 'active'
      return 'unconfirmed'
    }
    const latest = this.deps.executions.findLatestByNodeRun(nodeRun.id)
    if (
      latest &&
      (latest.status === 'succeeded' ||
        latest.status === 'failed' ||
        latest.status === 'cancelled' ||
        latest.status === 'crashed')
    ) {
      return 'terminal'
    }
    return 'not_started'
  }

  private runReentryBlockers(
    run: WorkflowRunRecord,
    activeChain: RecoveryAttemptRecord | null,
  ): { required: boolean; allowed: boolean; blockers: string[] } {
    if (run.status !== 'reconciliation_required') {
      return { required: false, allowed: false, blockers: [] }
    }
    const blockers = this.collectRunReentryBlockers(run, activeChain)
    return { required: true, allowed: blockers.length === 0, blockers }
  }

  private collectRunReentryBlockers(
    run: WorkflowRunRecord,
    activeChain: RecoveryAttemptRecord | null = null,
  ): string[] {
    const blockers: string[] = []
    if (activeChain ?? this.deps.attempts.getActiveByWork(run.workId)) {
      blockers.push('RECOVERY_ACTIVE')
    }
    const latest = new Map<string, NodeRunRecord>()
    for (const node of this.deps.nodes.listByRun(run.id)) {
      const current = latest.get(node.workflowNodeKey)
      if (!current || node.attempt > current.attempt) latest.set(node.workflowNodeKey, node)
    }
    if ([...latest.values()].some((node) => node.status === 'reconciliation_required')) {
      blockers.push('NODE_RECONCILIATION_PENDING')
    }
    if ([...latest.values()].some((node) => node.status === 'waiting_approval')) {
      blockers.push('WAITING_HUMAN')
    }
    for (const node of latest.values()) {
      const active = this.deps.executions.findActiveByNodeRun(node.id)
      if (node.status !== 'running' && active) blockers.push('EXECUTION_UNCONFIRMED')
      if (node.status === 'running' && !active) blockers.push('NODE_RUNNING_WITHOUT_EXECUTION')
    }
    const pending = this.deps.db
      .prepare(
        `SELECT e.id AS id FROM executions e
         JOIN node_runs n ON n.id = e.node_run_id
         WHERE n.workflow_run_id = ? AND e.status = 'pending'`,
      )
      .all(run.id) as { id: string }[]
    for (const row of pending) {
      const attempt = this.deps.attempts.getByExecutionId(row.id)
      if (!attempt || (attempt.status !== 'starting' && attempt.status !== 'running')) {
        blockers.push('PHANTOM_PENDING_EXECUTION')
        break
      }
    }
    const branches = this.deps.branches.listByRun(run.id)
    if (
      branches.length > 0 &&
      branches.every(
        (branch) =>
          branch.status === 'completed' ||
          branch.status === 'failed' ||
          branch.status === 'cancelled',
      )
    ) {
      blockers.push('ALL_BRANCHES_TERMINAL')
    }
    return [...new Set(blockers)]
  }

  private async prepareIntent(
    target: LoadedTarget,
    checkpoint: CheckpointRecord,
    plan: WorkflowNodeRecoveryPlanView,
    idempotencyKey: string,
  ): Promise<{
    attempt: RecoveryAttemptRecord
    facts: WorkflowRecoveryWorktreeFacts
    newNodeRunId: string
  }> {
    const worktreeOwnerToken = cryptoRandomToken()
    const newNodeRunId = newId('nrn')
    const predictedAttempt = plan.nextAttempt.attempt
    const branchName = this.deps.worktrees.branchName({
      workflowRunId: target.run.id,
      nodeKey: target.nodeKey,
      newNodeRunId,
      chainAttemptNo: plan.chain.attemptNo,
    })
    const recoveryAttemptId = newId('rec')
    const worktreeId = newId('wtr')
    const baseManifest = {
      recovery: { checkpointId: checkpoint.id, planHash: canonicalJson(plan) },
      worktree: {
        state: 'creating',
        worktreeId,
        worktreeOwnerToken,
        worktreePath: '',
        branchName,
        workflowRunId: target.run.id,
        workId: target.run.workId,
        nodeKey: target.nodeKey,
        newNodeRunId,
        predictedAttempt,
        chainAttemptNo: plan.chain.attemptNo,
        recoveryAttemptId,
        createdAt: this.now(),
      },
    }
    const attempt = (() => {
      try {
        return transaction(this.deps.db, () => {
          const record: RecoveryAttemptRecord = {
            id: recoveryAttemptId,
            workId: target.run.workId,
            checkpointId: checkpoint.id,
            kind: 'workflow_node',
            baseDedupeKey: `workflow_node:${target.chainId}`,
            dedupeKey: `workflow_node:${target.chainId}:${plan.chain.attemptNo}`,
            idempotencyKey,
            attemptNo: this.deps.attempts.nextAttemptNo(target.run.workId, checkpoint.id),
            status: 'starting',
            riskLevel: plan.eligibility.riskLevel ?? 'medium',
            eligibilityStatus: plan.eligibility.status,
            originalWorkStatus: null,
            reopenReason: null,
            operatorConfirmationJson: canonicalJson({ confirm: true, acknowledgedAt: this.now() }),
            planHash: canonicalJson(plan),
            contextManifestJson: canonicalJson(baseManifest),
            executionId: null,
            sessionId: null,
            teamRunId: null,
            nodeRunId: null,
            workflowRunId: target.run.id,
            branchRunId: target.branch?.id ?? null,
            recoveredNodeRunId: target.chainId,
            chainAttemptNo: plan.chain.attemptNo,
            errorJson: null,
            createdAt: this.now(),
            updatedAt: this.now(),
            startedAt: null,
            endedAt: null,
          }
          this.deps.attempts.insert(record)
          return record
        })
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new RpcMethodError(
            'NODE_RECOVERY_ACTIVE_EXISTS',
            'another recovery became active for this target',
          )
        }
        throw error
      }
    })()
    // T2a：意图已随 T1 落库；T2b 创建并验证 Worktree。
    let facts: WorkflowRecoveryWorktreeFacts
    try {
      facts = this.deps.worktrees.prepare({
        workId: target.run.workId,
        worktreeId,
        workflowRunId: target.run.id,
        nodeKey: target.nodeKey,
        newNodeRunId,
        chainAttemptNo: plan.chain.attemptNo,
        recoveryAttemptId: attempt.id,
        ownerToken: worktreeOwnerToken,
      })
    } catch (error) {
      await this.convergeAfterT3Failure(attempt.id, 'WORKTREE_PREPARE_FAILED')
      throw error
    }
    const readyManifest = {
      ...baseManifest,
      worktree: { ...baseManifest.worktree, ...facts, state: 'ready', verifiedAt: this.now() },
    }
    const updated = this.deps.attempts.updateWorktreeReady(
      attempt.id,
      canonicalJson(readyManifest),
      worktreeOwnerToken,
      this.now(),
    )
    if (!updated) {
      await this.convergeAfterT3Failure(attempt.id, 'WORKTREE_READY_FAILED', true)
      throw new RpcMethodError('NODE_RECOVERY_WORKTREE_OWNER_MISMATCH', 'worktree owner mismatch')
    }
    return { attempt, facts, newNodeRunId }
  }

  /**
   * T2 Prompt 组装：优先使用与普通执行一致的 Artifact/输出契约构建器；
   * 未注入时退回“上下文 + taskPrompt + 输出契约”的保守组合。
   */
  private composeRecoveryPrompt(target: LoadedTarget, plan: WorkflowNodeRecoveryPlanView): string {
    const contextPart = [
      plan.sections?.p0 ?? '',
      plan.sections?.p1 ?? '',
      plan.sections?.p2 ?? '',
      plan.sections?.p3 ?? '',
    ]
      .filter((part) => part.length > 0)
      .join('\n\n')
    let nodePart = ''
    if (target.node.type === 'agent_task') {
      if (this.deps.buildRecoveryPrompt) {
        try {
          nodePart = this.deps.buildRecoveryPrompt({
            run: target.run,
            node: target.node,
            definition: target.definition,
          })
        } catch (error) {
          throw new RpcMethodError(
            'INVALID_PARAMS',
            `recovery input is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            { code: 'RECOVERY_INPUT_UNAVAILABLE' },
          )
        }
      } else {
        nodePart = [target.node.config.taskPrompt, this.outputInstruction(target.node.config)].join(
          '\n\n',
        )
      }
    }
    const prompt = [contextPart, nodePart].filter((part) => part.length > 0).join('\n\n')
    if (prompt.trim().length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'recovery prompt must not be blank')
    }
    return prompt
  }

  private outputInstruction(
    config: Extract<WorkflowNode, { type: 'agent_task' }>['config'],
  ): string {
    return [
      'Return a single JSON document (no commentary):',
      JSON.stringify({
        agentraOutputVersion: 1,
        output: {},
        artifacts: config.artifacts.map((artifact) => ({
          name: artifact.name,
          content: '<artifact content>',
          encoding: artifact.type === 'image' ? 'base64' : 'utf8',
        })),
      }),
      describeOutputContract(config.outputContract),
      'Artifact names must match the declared names; optional artifacts may be omitted. Do not include credentials.',
    ].join('\n')
  }

  private startTransaction(
    target: LoadedTarget,
    checkpoint: CheckpointRecord,
    plan: WorkflowNodeRecoveryPlanView,
    prepared: {
      attempt: RecoveryAttemptRecord
      facts: WorkflowRecoveryWorktreeFacts
      newNodeRunId: string
    },
    idempotencyKey: string,
    recoveryPrompt: string,
  ): { recoveryAttemptId: string; newNodeRunId: string; executionId: string; sessionId: string } {
    return transaction<{
      recoveryAttemptId: string
      newNodeRunId: string
      executionId: string
      sessionId: string
    }>(this.deps.db, () => {
      // T3 重新读取目标事实：T2 的 Worktree 创建是 await 窗口，期间 Run/Branch/Work
      // 或旧执行状态可能变化；不得沿用 plan 时的快照。
      const freshRun = this.deps.runs.get(target.run.id)
      if (!freshRun) {
        throw new RpcMethodError('NODE_RECOVERY_TARGET_CHANGED', 'workflow run changed')
      }
      if (freshRun.status !== 'running' && freshRun.status !== 'reconciliation_required') {
        throw new RpcMethodError(
          'NODE_RECOVERY_RUN_STATE_INVALID',
          'workflow run is not recoverable',
        )
      }
      const freshWork = this.deps.works.get(freshRun.workId)
      if (!freshWork || freshWork.status !== 'active') {
        throw new RpcMethodError('NODE_RECOVERY_WORK_STATE_INVALID', 'work is not active')
      }
      const freshBranch = target.branch ? this.deps.branches.get(target.branch.id) : null
      if (!freshBranch || freshBranch.status !== 'active') {
        throw new RpcMethodError('NODE_RECOVERY_BRANCH_NOT_ACTIVE', 'branch is not active')
      }
      const freshTarget = this.deps.nodes.get(target.nodeRun.id)
      if (!freshTarget || freshTarget.workflowRunId !== freshRun.id) {
        throw new RpcMethodError('NODE_RECOVERY_TARGET_CHANGED', 'recovery target changed')
      }
      const freshLatest = latestAttempt(this.deps.nodes, freshRun.id, freshTarget.workflowNodeKey)
      if (!freshLatest || freshLatest.id !== freshTarget.id) {
        throw new RpcMethodError(
          'NODE_RECOVERY_TARGET_NOT_LATEST',
          'target is not the latest attempt',
        )
      }
      if (
        freshTarget.status !== 'reconciliation_required' &&
        !this.isRecoveryFailedAttempt(freshTarget)
      ) {
        throw new RpcMethodError(
          'NODE_RECOVERY_TARGET_NOT_RECOVERABLE',
          'target is no longer recoverable',
        )
      }
      const freshActive = this.deps.executions.findActiveByNodeRun(freshTarget.id)
      if (freshActive && freshActive.status !== 'pending') {
        throw new RpcMethodError(
          'NODE_RECOVERY_EXECUTION_ACTIVE',
          'old execution became active during preparation',
        )
      }
      const fresh = this.deps.attempts.get(prepared.attempt.id)
      if (!fresh || fresh.status !== 'starting') {
        throw new RpcMethodError('NODE_RECOVERY_TARGET_CHANGED', 'recovery target changed')
      }
      const manifest = parseManifest(fresh.contextManifestJson)
      const worktree = (manifest.worktree ?? {}) as Record<string, unknown>
      if (worktree.state !== 'ready') {
        throw new RpcMethodError('NODE_RECOVERY_WORKTREE_INVALID', 'worktree intent is not ready')
      }
      if (worktree.newNodeRunId !== prepared.newNodeRunId) {
        throw new RpcMethodError('NODE_RECOVERY_WORKTREE_OWNER_MISMATCH', 'newNodeRunId mismatch')
      }
      const facts = worktree as unknown as WorkflowRecoveryWorktreeFacts
      this.deps.worktrees.validate(target.run.workId, facts, {
        branchName: prepared.facts.branchName,
        newNodeRunId: prepared.newNodeRunId,
      })
      if (this.deps.nodes.get(prepared.newNodeRunId)) {
        throw new RpcMethodError('NODE_RECOVERY_ATTEMPT_CONFLICT', 'newNodeRunId already exists')
      }
      const expectedAttempt =
        (latestAttempt(this.deps.nodes, target.run.id, target.nodeKey)?.attempt ?? 0) + 1
      if (Number(worktree.predictedAttempt) !== expectedAttempt) {
        throw new RpcMethodError('NODE_RECOVERY_ATTEMPT_CONFLICT', 'predicted attempt changed')
      }
      if (freshTarget.status === 'reconciliation_required') {
        const marked = this.deps.nodes.fail(
          freshTarget.id,
          ['reconciliation_required'],
          {
            category: 'recovery_superseded',
            nodeKey: target.nodeKey,
            message: 'superseded by workflow node recovery',
            details: { recoveryAttemptId: fresh.id, newNodeRunId: prepared.newNodeRunId },
          },
          this.now(),
        )
        if (!marked)
          throw new RpcMethodError('NODE_RECOVERY_TARGET_CHANGED', 'recovery target changed')
      }
      const attemptNo = Number(
        manifest.worktree && (manifest.worktree as Record<string, unknown>).predictedAttempt,
      )
      const nodeRun = this.deps.nodes.create(
        {
          id: prepared.newNodeRunId,
          workflowRunId: target.run.id,
          workflowNodeKey: target.nodeKey,
          branchRunId: target.branch?.id ?? null,
          status: 'ready',
          attempt: Number.isInteger(attemptNo) ? attemptNo : freshTarget.attempt + 1,
          inputSnapshot: freshTarget.inputSnapshot,
        },
        this.now(),
      )
      if (!this.deps.nodes.transition(nodeRun.id, ['ready'], 'running', this.now())) {
        throw new RpcMethodError('NODE_RECOVERY_ATTEMPT_CONFLICT', 'node attempt conflict')
      }
      const assignment = this.deps.assignments.resolveForNode(target.run.workId, target.node)
      const tx: RecoveryTxContext = { db: this.deps.db, inTransaction: true }
      const execution = this.deps.executionRunner.prepareRecoveryForNode(
        tx,
        nodeRun.id,
        {
          agentId: assignment.agentId,
          workId: target.run.workId,
          prompt: recoveryPrompt,
          worktreeId: facts.worktreeId,
        },
        { recoveryAttemptId: fresh.id, checkpointId: checkpoint.id },
      )
      let marked = false
      try {
        marked = this.deps.attempts.markWorkflowRunning(
          fresh.id,
          {
            executionId: execution.executionId,
            sessionId: execution.sessionId,
            nodeRunId: nodeRun.id,
            workflowRunId: target.run.id,
            branchRunId: target.branch?.id ?? null,
          },
          this.now(),
        )
      } catch (error) {
        this.deps.executionRunner.discardPreparedRecovery(execution.executionId)
        throw error
      }
      if (!marked) {
        this.deps.executionRunner.discardPreparedRecovery(execution.executionId)
        throw new RpcMethodError('NODE_RECOVERY_ACTIVE_EXISTS', 'active recovery exists')
      }
      if (freshRun.status === 'reconciliation_required' && plan.runReentry.allowed) {
        this.deps.runs.transition(freshRun.id, ['reconciliation_required'], 'running', this.now())
      }
      this.audit('workflow.node.recovery.started', {
        workflowRunId: freshRun.id,
        nodeKey: target.nodeKey,
        recoveredNodeRunId: freshTarget.id,
        newNodeRunId: nodeRun.id,
        recoveryAttemptId: fresh.id,
        worktreeId: facts.worktreeId,
        idempotencyKey,
      })
      return {
        recoveryAttemptId: fresh.id,
        newNodeRunId: nodeRun.id,
        executionId: execution.executionId,
        sessionId: execution.sessionId,
      }
    })
  }

  async convergeSpawnFailure(
    recoveryAttemptId: string,
    reason: string,
    error?: unknown,
  ): Promise<void> {
    const attempt = this.deps.attempts.get(recoveryAttemptId)
    if (!attempt || attempt.status !== 'running') return
    const execution = attempt.executionId ? this.deps.executions.get(attempt.executionId) : null
    if (execution && (execution.status === 'pending' || execution.status === 'running')) {
      this.audit('workflow.node.recovery.spawn_failure_pending_reconcile', {
        recoveryAttemptId: attempt.id,
        executionId: execution.id,
        reason,
        error: error instanceof Error ? error.message : null,
      })
      return
    }
    const manifest = parseManifest(attempt.contextManifestJson)
    const worktree = (manifest.worktree ?? {}) as Record<string, unknown>
    const nextManifest = {
      ...manifest,
      worktree: {
        ...worktree,
        state: 'orphaned',
        reason,
        updatedAt: this.now(),
      },
    }
    transaction(this.deps.db, () => {
      if (attempt.nodeRunId) {
        this.deps.nodes.transition(
          attempt.nodeRunId,
          ['running'],
          'reconciliation_required',
          this.now(),
        )
      }
      if (
        typeof worktree.state === 'string' &&
        this.deps.attempts.updateWorktreeDisposition(
          attempt.id,
          worktree.state,
          canonicalJson(nextManifest),
          this.now(),
        )
      ) {
        // 已持久化孤儿状态
      }
      this.deps.attempts.finish(
        attempt.id,
        'failed',
        canonicalJson({ reason, stage: 'spawn' }),
        this.now(),
      )
      this.audit('workflow.node.recovery.failed', {
        recoveryAttemptId: attempt.id,
        reason,
        stage: 'spawn',
      })
    })
  }

  /** Run 终态收敛：仅在满足重入条件时把 reconciliation_required 拉回 running。 */
  reconcileRun(workflowRunId: string): boolean {
    const run = this.deps.runs.get(workflowRunId)
    if (!run || run.status !== 'reconciliation_required') return false
    const blockers = this.collectRunReentryBlockers(run)
    if (blockers.length > 0) {
      this.audit('workflow.node.recovery.run_reentry_blocked', {
        workflowRunId: run.id,
        blockers,
      })
      return false
    }
    if (!this.deps.runs.transition(run.id, ['reconciliation_required'], 'running', this.now())) {
      return false
    }
    this.audit('workflow.node.recovery.run_reentered', { workflowRunId: run.id })
    try {
      this.deps.onRunReentered?.(run.id)
    } catch (error) {
      this.deps.logger?.warn('run reentry kick failed', {
        workflowRunId: run.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return true
  }

  reconcileAll(): void {
    for (const run of this.deps.runs.listUnfinished()) {
      if (run.status === 'reconciliation_required') this.reconcileRun(run.id)
    }
  }

  private toStartView(
    attempt: RecoveryAttemptRecord,
    idempotentReplay: boolean,
  ): WorkflowNodeRecoveryStartView {
    const manifest = parseManifest(attempt.contextManifestJson)
    const worktree = (manifest.worktree ?? {}) as Record<string, unknown>
    return {
      recoveryAttemptId: attempt.id,
      status: attempt.status,
      newNodeRunId:
        attempt.nodeRunId ??
        (typeof worktree.newNodeRunId === 'string' ? worktree.newNodeRunId : ''),
      executionId: attempt.executionId,
      sessionId: attempt.sessionId,
      idempotentReplay,
    }
  }

  private audit(action: string, details: Record<string, unknown>): void {
    this.deps.audit?.append({
      actorType: 'user',
      actorId: 'local-user',
      action,
      targetType: 'workflow_run',
      targetId: String(details.workflowRunId ?? ''),
      details,
      now: this.now(),
    })
  }
}

function cryptoRandomToken(): string {
  return randomUUID()
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    /UNIQUE constraint failed/i.test(error.message)
  )
}
