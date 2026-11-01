import type { Database } from '../database'

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'cancelled',
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export type ApprovalType = 'before_execute' | 'after_execute'

export type ApprovalRecord = {
  id: string
  workflowRunId: string
  nodeRunId: string
  targetNodeRunId: string | null
  approvalType: ApprovalType
  status: ApprovalStatus
  requestedBy: string
  decidedBy: string | null
  decisionComment: string | null
  round: number
  requestedAt: string
  decidedAt: string | null
}

type ApprovalRow = {
  id: string
  workflow_run_id: string
  node_run_id: string
  target_node_run_id: string | null
  approval_type: string
  status: string
  requested_by: string
  decided_by: string | null
  decision_comment: string | null
  round: number
  requested_at: string
  decided_at: string | null
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    nodeRunId: row.node_run_id,
    targetNodeRunId: row.target_node_run_id,
    approvalType: row.approval_type as ApprovalType,
    status: row.status as ApprovalStatus,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decisionComment: row.decision_comment,
    round: row.round,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  }
}

export type CreateApprovalInput = {
  id: string
  workflowRunId: string
  nodeRunId: string
  targetNodeRunId: string | null
  approvalType: ApprovalType
  round: number
  requestedBy: string
}

/** approvals 数据访问（不自己开事务）。 */
export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateApprovalInput, now: string): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (
           id, workflow_run_id, node_run_id, target_node_run_id, approval_type, status,
           requested_by, decided_by, decision_comment, decision_payload_json, round,
           rework_request_id, requested_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, NULL, ?, NULL)`,
      )
      .run(
        input.id,
        input.workflowRunId,
        input.nodeRunId,
        input.targetNodeRunId,
        input.approvalType,
        input.requestedBy,
        input.round,
        now,
      )
    const created = this.get(input.id)
    if (!created) throw new Error(`approvals(${input.id}) missing after insert`)
    return created
  }

  get(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined
    return row ? toRecord(row) : null
  }

  findPendingByNodeRun(nodeRunId: string): ApprovalRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM approvals WHERE node_run_id = ? AND status = 'pending' ORDER BY round DESC LIMIT 1",
      )
      .get(nodeRunId) as ApprovalRow | undefined
    return row ? toRecord(row) : null
  }

  latestByNodeRun(nodeRunId: string): ApprovalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE node_run_id = ? ORDER BY round DESC LIMIT 1')
      .get(nodeRunId) as ApprovalRow | undefined
    return row ? toRecord(row) : null
  }

  nextRound(nodeRunId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(round), 0) + 1 AS next FROM approvals WHERE node_run_id = ?')
      .get(nodeRunId) as { next: number }
    return row.next
  }

  listByRun(workflowRunId: string): ApprovalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE workflow_run_id = ? ORDER BY requested_at ASC')
      .all(workflowRunId) as ApprovalRow[]
    return rows.map(toRecord)
  }

  /** CAS：只有 pending 能进入终态；返回 false 表示已被并发决策。 */
  decide(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    input: { decidedBy: string; comment: string | null },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, input.decidedBy, input.comment, now, id)
    return Number(result.changes) > 0
  }
}
