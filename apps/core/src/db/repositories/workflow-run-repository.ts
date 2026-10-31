import {
  assertRunTransition,
  isTerminalRunStatus,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunStatus,
} from '../../workflow/state-machine'
import type { Database } from '../database'

export type WorkflowRunRecord = {
  id: string
  workId: string
  workflowVersionId: string
  status: WorkflowRunStatus
  startedAt: string | null
  endedAt: string | null
  runtimeState: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CreateWorkflowRunInput = {
  id: string
  workId: string
  workflowVersionId: string
  status?: WorkflowRunStatus
  runtimeState?: Record<string, unknown>
}

type WorkflowRunRow = {
  id: string
  work_id: string
  workflow_version_id: string
  status: string
  started_at: string | null
  ended_at: string | null
  runtime_state_json: string
  created_at: string
  updated_at: string
}

function parseJsonObject(raw: string, context: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${context}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context}: expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function toRecord(row: WorkflowRunRow): WorkflowRunRecord {
  if (!(WORKFLOW_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected workflow_runs.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    runtimeState: parseJsonObject(
      row.runtime_state_json,
      `workflow_runs.runtime_state_json(${row.id})`,
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const TERMINAL = WORKFLOW_RUN_STATUSES.filter((status) => isTerminalRunStatus(status))

/**
 * workflow_runs 数据访问。
 * **不自己开事务**：迁移 API 直接在当前连接上执行，由调用方组合事务边界
 * （S4-7 的事件幂等要求"状态推进 + 事件写入"同事务）。
 */
export class WorkflowRunRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateWorkflowRunInput, now: string): WorkflowRunRecord {
    const status = input.status ?? 'pending'
    if (!(WORKFLOW_RUN_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid workflow run status: ${status}`)
    }
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
           id, work_id, workflow_version_id, status, started_at, ended_at,
           runtime_state_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workId,
        input.workflowVersionId,
        status,
        status === 'running' ? now : null,
        JSON.stringify(input.runtimeState ?? {}),
        now,
        now,
      )
    const created = this.get(input.id)
    if (!created) throw new Error(`workflow_runs(${input.id}) missing after insert`)
    return created
  }

  get(id: string): WorkflowRunRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
      | WorkflowRunRow
      | undefined
    return row ? toRecord(row) : null
  }

  /** 未终结的 Run（Core 启动恢复用）。 */
  listUnfinished(): WorkflowRunRecord[] {
    const placeholders = TERMINAL.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE status NOT IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...TERMINAL) as WorkflowRunRow[]
    return rows.map(toRecord)
  }

  listByWork(workId: string): WorkflowRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_runs WHERE work_id = ? ORDER BY created_at DESC, id DESC')
      .all(workId) as WorkflowRunRow[]
    return rows.map(toRecord)
  }

  /**
   * CAS 迁移：`from` 里的每个状态都必须能合法到达 `to`（先对照状态机），
   * 实际写入使用 `WHERE status IN (…)`；返回 false 表示当前状态已被并发改走。
   */
  transition(
    id: string,
    from: readonly WorkflowRunStatus[],
    to: WorkflowRunStatus,
    now: string,
    patch?: { runtimeState?: Record<string, unknown> },
  ): boolean {
    if (from.length === 0) throw new Error('transition requires at least one expected status')
    for (const status of from) assertRunTransition(status, to)

    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE workflow_runs
         SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ?,
             runtime_state_json = COALESCE(?, runtime_state_json), updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        to,
        to === 'running' ? now : null,
        isTerminalRunStatus(to) ? now : null,
        patch?.runtimeState === undefined ? null : JSON.stringify(patch.runtimeState),
        now,
        id,
        ...from,
      )
    return Number(result.changes) > 0
  }
}
