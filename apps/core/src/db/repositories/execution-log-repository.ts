import {
  type ExecutionLog,
  ExecutionLog as ExecutionLogSchema,
  type ExecutionLogStream,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../database'

type LogRow = {
  id: string
  execution_id: string
  sequence_no: number
  stream: string
  content: string
  timestamp: string
}

function toLog(row: LogRow): ExecutionLog {
  return ExecutionLogSchema.parse({
    id: row.id,
    executionId: row.execution_id,
    sequenceNo: row.sequence_no,
    stream: row.stream,
    content: row.content,
    timestamp: row.timestamp,
  })
}

/**
 * execution_logs 数据访问。
 * sequence_no 由 Core 单点分配（单进程同步执行，SELECT MAX+1 与 INSERT 在同一条语句内完成），
 * 保证与 Daemon 事件序号解耦、永不冲突；重复事件由上层 eventId 去重后再写入。
 */
export class ExecutionLogRepository {
  constructor(private readonly db: Database) {}

  append(
    executionId: string,
    stream: ExecutionLogStream,
    content: string,
    timestamp: string,
  ): ExecutionLog {
    const id = newId('log')
    this.db
      .prepare(
        `INSERT INTO execution_logs (id, execution_id, sequence_no, stream, content, timestamp)
         SELECT ?, ?, COALESCE(MAX(sequence_no), 0) + 1, ?, ?, ?
         FROM execution_logs WHERE execution_id = ?`,
      )
      .run(id, executionId, stream, content, timestamp, executionId)
    const row = this.db.prepare('SELECT * FROM execution_logs WHERE id = ?').get(id) as
      | LogRow
      | undefined
    if (!row) throw new Error(`execution log insert failed: ${executionId}`)
    return toLog(row)
  }

  list(executionId: string, afterSequence = 0, limit = 1000): ExecutionLog[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_logs
         WHERE execution_id = ? AND sequence_no > ?
         ORDER BY sequence_no ASC LIMIT ?`,
      )
      .all(executionId, afterSequence, limit) as LogRow[]
    return rows.map(toLog)
  }
}
