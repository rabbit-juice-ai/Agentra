import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type {
  ApprovalRecord,
  ApprovalRepository,
  ApprovalType,
} from '../db/repositories/approval-repository'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'

export type ApprovalDecision = 'approve' | 'request_changes' | 'reject'

const DECISION_STATUS = {
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
} as const

export class ApprovalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_DECISION' | 'COMMENT_REQUIRED' | 'ALREADY_DECIDED',
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalError'
  }
}

/**
 * 最小审批决策内核（D2 裁定）：只做 Core 内部方法，不暴露 RPC。
 * 进入等待时创建 pending 行；决策时同一事务内更新 Approval + NodeRun + BranchRun。
 */
export class ApprovalService {
  constructor(
    private readonly db: Database,
    private readonly approvals: ApprovalRepository,
    private readonly nodes: NodeRunRepository,
    private readonly branches: BranchRunRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  requestForNode(
    nodeRunId: string,
    input: { approvalType: ApprovalType; targetNodeRunId: string | null; requestedBy: string },
  ): ApprovalRecord {
    const nodeRun = this.nodes.get(nodeRunId)
    if (!nodeRun) throw new ApprovalError('NOT_FOUND', `node run ${nodeRunId} not found`)
    const existing = this.approvals.findPendingByNodeRun(nodeRunId)
    if (existing) return existing
    return this.approvals.create(
      {
        id: newId('apv'),
        workflowRunId: nodeRun.workflowRunId,
        nodeRunId,
        targetNodeRunId: input.targetNodeRunId,
        approvalType: input.approvalType,
        round: this.approvals.nextRound(nodeRunId),
        requestedBy: input.requestedBy,
      },
      this.now(),
    )
  }

  decide(
    nodeRunId: string,
    decision: ApprovalDecision,
    input: { decidedBy: string; comment?: string },
  ): ApprovalRecord {
    if (!(decision in DECISION_STATUS)) {
      throw new ApprovalError('INVALID_DECISION', `unsupported decision: ${decision}`)
    }
    const comment = input.comment?.trim() ?? ''
    if (decision === 'request_changes' && comment.length === 0) {
      throw new ApprovalError('COMMENT_REQUIRED', 'request_changes requires a comment')
    }

    const pending = this.approvals.findPendingByNodeRun(nodeRunId)
    if (!pending) {
      const latest = this.approvals.latestByNodeRun(nodeRunId)
      if (
        latest &&
        latest.status === DECISION_STATUS[decision] &&
        latest.decidedBy === input.decidedBy
      ) {
        return latest
      }
      throw new ApprovalError('ALREADY_DECIDED', `no pending approval for node run ${nodeRunId}`)
    }

    const now = this.now()
    return transaction(this.db, () => {
      const decided = this.approvals.decide(
        pending.id,
        DECISION_STATUS[decision],
        { decidedBy: input.decidedBy, comment: comment.length > 0 ? comment : null },
        now,
      )
      if (!decided) {
        throw new ApprovalError(
          'ALREADY_DECIDED',
          `approval ${pending.id} was decided concurrently`,
        )
      }

      const nodeStatus =
        decision === 'approve'
          ? 'succeeded'
          : decision === 'request_changes'
            ? 'changes_requested'
            : 'rejected'
      const nodeRun = this.nodes.get(nodeRunId)
      if (nodeRun) {
        const moved = this.nodes.transition(nodeRunId, ['waiting_approval'], nodeStatus, now)
        if (!moved) {
          // 审批行与节点状态不一致：整笔回滚，不能只把审批标记为已决策。
          throw new ApprovalError(
            'ALREADY_DECIDED',
            `node run ${nodeRunId} is not waiting_approval`,
          )
        }
        if (decision === 'approve' && nodeRun.branchRunId) {
          this.branches.resume(nodeRun.branchRunId, now)
        }
      }

      const updated = this.approvals.get(pending.id)
      if (!updated)
        throw new ApprovalError('NOT_FOUND', `approval ${pending.id} missing after update`)
      return updated
    })
  }
}
