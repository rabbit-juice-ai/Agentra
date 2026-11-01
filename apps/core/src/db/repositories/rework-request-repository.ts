import {
  assertReworkTransition,
  REWORK_REQUEST_STATUSES,
  type ReworkRequestStatus,
} from '../../workflow/state-machine'
import type { Database } from '../database'

export type ReworkTriggerType = 'request_changes' | 'test_failure'
export type ReworkCreatedBy = 'system' | 'approval' | 'user'

export type ReworkRequestRecord = {
  id: string
  workflowRunId: string
  branchRunId: string | null
  targetNodeRunId: string
  triggerType: ReworkTriggerType
  triggerApprovalId: string | null
  testReport: Record<string, unknown> | null
  round: number
  maxRounds: number
  status: ReworkRequestStatus
  reworkNodeRunId: string | null
  createdBy: ReworkCreatedBy
  createdAt: string
  updatedAt: string
}

export type CreateReworkRequestInput = {
  id: string
  workflowRunId: string
  branchRunId: string | null
  targetNodeRunId: string
  triggerType: ReworkTriggerType
  triggerApprovalId?: string | null
  testReport?: Record<string, unknown> | null
  round: number
  maxRounds: number
  status?: Extract<ReworkRequestStatus, 'requested' | 'exhausted'>
  createdBy: ReworkCreatedBy
}

type ReworkRequestRow = {
  id: string
  workflow_run_id: string
  branch_run_id: string | null
  target_node_run_id: string
  trigger_type: string
  trigger_approval_id: string | null
  test_report_json: string | null
  round: number
  max_rounds: number
  status: string
  rework_node_run_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

function parseReport(raw: string | null, id: string): Record<string, unknown> | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `rework_requests.test_report_json(${id}): invalid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`rework_requests.test_report_json(${id}): expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function toRecord(row: ReworkRequestRow): ReworkRequestRecord {
  if (!(REWORK_REQUEST_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected rework_requests.status: ${row.status}`)
  }
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    branchRunId: row.branch_run_id,
    targetNodeRunId: row.target_node_run_id,
    triggerType: row.trigger_type as ReworkTriggerType,
    triggerApprovalId: row.trigger_approval_id,
    testReport: parseReport(row.test_report_json, row.id),
    round: row.round,
    maxRounds: row.max_rounds,
    status: row.status as ReworkRequestStatus,
    reworkNodeRunId: row.rework_node_run_id,
    createdBy: row.created_by as ReworkCreatedBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** rework_requests 数据访问；不自己开事务。 */
export class ReworkRequestRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateReworkRequestInput, now: string): ReworkRequestRecord {
    const status = input.status ?? 'requested'
    if (status !== 'requested' && status !== 'exhausted') {
      throw new Error(`rework request must start as requested or exhausted, got ${status}`)
    }
    this.db
      .prepare(
        `INSERT INTO rework_requests (
           id, workflow_run_id, branch_run_id, target_node_run_id, trigger_type,
           trigger_approval_id, test_report_json, round, max_rounds, status,
           rework_node_run_id, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowRunId,
        input.branchRunId,
        input.targetNodeRunId,
        input.triggerType,
        input.triggerApprovalId ?? null,
        input.testReport === undefined || input.testReport === null
          ? null
          : JSON.stringify(input.testReport),
        input.round,
        input.maxRounds,
        status,
        input.createdBy,
        now,
        now,
      )
    const created = this.get(input.id)
    if (!created) throw new Error(`rework_requests(${input.id}) missing after insert`)
    return created
  }

  get(id: string): ReworkRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM rework_requests WHERE id = ?').get(id) as
      | ReworkRequestRow
      | undefined
    return row ? toRecord(row) : null
  }

  findByTargetAndRound(targetNodeRunId: string, round: number): ReworkRequestRecord | null {
    const row = this.db
      .prepare('SELECT * FROM rework_requests WHERE target_node_run_id = ? AND round = ?')
      .get(targetNodeRunId, round) as ReworkRequestRow | undefined
    return row ? toRecord(row) : null
  }

  latestByTarget(targetNodeRunId: string): ReworkRequestRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM rework_requests WHERE target_node_run_id = ? ORDER BY round DESC LIMIT 1',
      )
      .get(targetNodeRunId) as ReworkRequestRow | undefined
    return row ? toRecord(row) : null
  }

  countByTarget(targetNodeRunId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM rework_requests WHERE target_node_run_id = ?')
      .get(targetNodeRunId) as { count: number }
    return row.count
  }

  listByRun(workflowRunId: string): ReworkRequestRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM rework_requests WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(workflowRunId) as ReworkRequestRow[]
    return rows.map(toRecord)
  }

  /** 同一事务内标记本轮返工对应的新 NodeRun attempt。 */
  linkReworkNodeRun(id: string, nodeRunId: string, now: string): boolean {
    const result = this.db
      .prepare('UPDATE rework_requests SET rework_node_run_id = ?, updated_at = ? WHERE id = ?')
      .run(nodeRunId, now, id)
    return Number(result.changes) > 0
  }

  /** CAS：状态机对照 + WHERE status IN；返回 false 表示已被并发改走。 */
  transition(
    id: string,
    from: readonly ReworkRequestStatus[],
    to: ReworkRequestStatus,
    now: string,
  ): boolean {
    if (from.length === 0) throw new Error('transition requires at least one expected status')
    for (const status of from) assertReworkTransition(status, to)

    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE rework_requests SET status = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now, id, ...from)
    return Number(result.changes) > 0
  }
}
