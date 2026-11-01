import { type Approval, RpcMethodError } from '@agentra/protocol'
import type { ApprovalRecord, ApprovalRepository } from '../db/repositories/approval-repository'
import {
  type ApprovalDecision,
  ApprovalError,
  type ApprovalService,
} from '../workflow/approval-service'

/** ApprovalRecord → 协议 DTO。 */
function toDto(record: ApprovalRecord): Approval {
  return {
    id: record.id,
    workflowRunId: record.workflowRunId,
    nodeRunId: record.nodeRunId,
    targetNodeRunId: record.targetNodeRunId,
    approvalType: record.approvalType,
    status: record.status,
    requestedBy: record.requestedBy,
    decidedBy: record.decidedBy,
    decisionComment: record.decisionComment,
    round: record.round,
    reworkRequestId: record.reworkRequestId,
    requestedAt: record.requestedAt,
    decidedAt: record.decidedAt,
  }
}

function mapApprovalError(error: unknown): Error {
  if (error instanceof ApprovalError) {
    // A2/A3/A11/A13 的错误语义统一 INVALID_PARAMS（含 detail 里的 code 供 UI 区分）。
    throw new RpcMethodError('INVALID_PARAMS', error.message, { code: error.code })
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 审批决策 API（A2/A3/A6/A11/A13）；只包 ApprovalService，不重复业务逻辑。 */
export class ApprovalRpcService {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly approvals: ApprovalRepository,
  ) {}

  decide(params: {
    nodeRunId: string
    decision: ApprovalDecision
    decidedBy: string
    comment?: string
  }): Approval {
    try {
      return toDto(
        this.approvalService.decide(params.nodeRunId, params.decision, {
          decidedBy: params.decidedBy,
          comment: params.comment,
        }),
      )
    } catch (error) {
      throw mapApprovalError(error)
    }
  }

  get(nodeRunId: string): { approval: Approval | null; history: Approval[] } {
    const pending = this.approvals.findPendingByNodeRun(nodeRunId)
    const history = this.approvals.listByNodeRun(nodeRunId)
    return {
      approval: pending ? toDto(pending) : null,
      history: history.map(toDto),
    }
  }

  listPending(runId: string): Approval[] {
    return this.approvals.listPendingByRun(runId).map(toDto)
  }
}
