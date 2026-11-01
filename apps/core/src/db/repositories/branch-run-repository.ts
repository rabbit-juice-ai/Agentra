import {
  assertBranchTransition,
  BRANCH_RUN_STATUSES,
  type BranchRunStatus,
} from '../../workflow/state-machine'
import type { Database } from '../database'

export type BranchRunRecord = {
  id: string
  workflowRunId: string
  /**
   * root / `<split>/<branchKey>`；返工产生的分支带 `#rwk-<round>-<requestId 后 8 位>` 后缀。
   * 与定义层 KeySchema 不同：运行期 branch_key 不是节点 key，不得用 KeySchema 校验。
   */
  branchKey: string
  status: BranchRunStatus
  pauseReason: string | null
  pausedAt: string | null
  resumedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CreateBranchRunInput = {
  id: string
  workflowRunId: string
  branchKey: string
  status?: BranchRunStatus
}

type BranchRunRow = {
  id: string
  workflow_run_id: string
  branch_key: string
  status: string
  pause_reason: string | null
  paused_at: string | null
  resumed_at: string | null
  created_at: string
  updated_at: string
}

function toRecord(row: BranchRunRow): BranchRunRecord {
  if (!(BRANCH_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected branch_runs.status: ${row.status}`)
  }
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    branchKey: row.branch_key,
    status: row.status as BranchRunStatus,
    pauseReason: row.pause_reason,
    pausedAt: row.paused_at,
    resumedAt: row.resumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** branch_runs 数据访问；与 Run/Node 一样不自己开事务。 */
export class BranchRunRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateBranchRunInput, now: string): BranchRunRecord {
    const status = input.status ?? 'active'
    if (!(BRANCH_RUN_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid branch run status: ${status}`)
    }
    this.db
      .prepare(
        `INSERT INTO branch_runs (
           id, workflow_run_id, branch_key, status, pause_reason, paused_at, resumed_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.id, input.workflowRunId, input.branchKey, status, now, now)
    const created = this.get(input.id)
    if (!created) throw new Error(`branch_runs(${input.id}) missing after insert`)
    return created
  }

  get(id: string): BranchRunRecord | null {
    const row = this.db.prepare('SELECT * FROM branch_runs WHERE id = ?').get(id) as
      | BranchRunRow
      | undefined
    return row ? toRecord(row) : null
  }

  getByKey(workflowRunId: string, branchKey: string): BranchRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM branch_runs WHERE workflow_run_id = ? AND branch_key = ?')
      .get(workflowRunId, branchKey) as BranchRunRow | undefined
    return row ? toRecord(row) : null
  }

  listByRun(workflowRunId: string): BranchRunRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM branch_runs WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(workflowRunId) as BranchRunRow[]
    return rows.map(toRecord)
  }

  transition(
    id: string,
    from: readonly BranchRunStatus[],
    to: BranchRunStatus,
    now: string,
  ): boolean {
    if (from.length === 0) throw new Error('transition requires at least one expected status')
    for (const status of from) assertBranchTransition(status, to)

    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE branch_runs SET status = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now, id, ...from)
    return Number(result.changes) > 0
  }

  /** 暂停：CAS active → paused，并记录原因与时刻。 */
  pause(id: string, reason: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE branch_runs
         SET status = 'paused', pause_reason = ?, paused_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(reason, now, now, id)
    return Number(result.changes) > 0
  }

  /** 恢复：CAS paused → active，并记录恢复时刻。 */
  resume(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE branch_runs
         SET status = 'active', resumed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'paused'`,
      )
      .run(now, now, id)
    return Number(result.changes) > 0
  }
}
