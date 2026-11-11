import type { Database } from '../database'

export type TaskMemoryRecord = {
  workId: string
  version: number
  memoryJson: string
  acceptanceCriteriaSnapshotJson: string
  acceptanceCriteriaWorkVersion: number
  acceptanceCriteriaWorkUpdatedAt: string | null
  summary: string
  createdAt: string
  updatedAt: string
}

type TaskMemoryRow = {
  work_id: string
  version: number
  memory_json: string
  acceptance_criteria_snapshot_json: string
  acceptance_criteria_work_version: number
  acceptance_criteria_work_updated_at: string | null
  summary: string
  created_at: string
  updated_at: string
}

function toRecord(row: TaskMemoryRow): TaskMemoryRecord {
  return {
    workId: row.work_id,
    version: row.version,
    memoryJson: row.memory_json,
    acceptanceCriteriaSnapshotJson: row.acceptance_criteria_snapshot_json,
    acceptanceCriteriaWorkVersion: row.acceptance_criteria_work_version,
    acceptanceCriteriaWorkUpdatedAt: row.acceptance_criteria_work_updated_at,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** task_memories 的唯一数据访问入口；一个 Work 只有一份当前快照。 */
export class TaskMemoryRepository {
  constructor(private readonly db: Database) {}

  get(workId: string): TaskMemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM task_memories WHERE work_id = ?').get(workId) as
      | TaskMemoryRow
      | undefined
    return row ? toRecord(row) : null
  }

  /** 并发初始化时只有一个插入成功；调用方随后重新读取。 */
  insertIfMissing(record: TaskMemoryRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_memories (
          work_id, version, memory_json, acceptance_criteria_snapshot_json,
          acceptance_criteria_work_version, acceptance_criteria_work_updated_at,
          summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workId,
        record.version,
        record.memoryJson,
        record.acceptanceCriteriaSnapshotJson,
        record.acceptanceCriteriaWorkVersion,
        record.acceptanceCriteriaWorkUpdatedAt,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
  }

  /**
   * 只允许把快照推进到更新的 Work 验收标准版本。
   * 如果并发请求已经写入相同或更新版本，返回 false，调用方必须重新读取。
   */
  updateAcceptanceSnapshot(record: TaskMemoryRecord): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_memories SET
          version = ?, memory_json = ?, acceptance_criteria_snapshot_json = ?,
          acceptance_criteria_work_version = ?, acceptance_criteria_work_updated_at = ?,
          summary = ?, updated_at = ?
         WHERE work_id = ? AND acceptance_criteria_work_version < ?`,
      )
      .run(
        record.version,
        record.memoryJson,
        record.acceptanceCriteriaSnapshotJson,
        record.acceptanceCriteriaWorkVersion,
        record.acceptanceCriteriaWorkUpdatedAt,
        record.summary,
        record.updatedAt,
        record.workId,
        record.acceptanceCriteriaWorkVersion,
      )
    return result.changes > 0
  }
}
