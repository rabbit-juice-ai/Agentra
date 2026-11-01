import { newId } from '@agentra/shared'
import type { Database } from '../database'

export type WorkflowEventRecord = {
  id: string
  eventId: string
  workflowRunId: string
  branchRunId: string | null
  nodeRunId: string | null
  eventType: string
  payload: Record<string, unknown>
  occurredAt: string
  correlationId: string | null
  causationId: string | null
}

export type AppendWorkflowEventInput = {
  eventId: string
  workflowRunId: string
  branchRunId?: string | null
  nodeRunId?: string | null
  eventType: string
  payload?: Record<string, unknown>
  occurredAt: string
  correlationId?: string | null
  causationId?: string | null
}

type WorkflowEventRow = {
  id: string
  event_id: string
  workflow_run_id: string
  branch_run_id: string | null
  node_run_id: string | null
  event_type: string
  payload_json: string
  occurred_at: string
  correlation_id: string | null
  causation_id: string | null
}

function parsePayload(raw: string, id: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `workflow_events.payload_json(${id}): invalid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workflow_events.payload_json(${id}): expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function toRecord(row: WorkflowEventRow): WorkflowEventRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    workflowRunId: row.workflow_run_id,
    branchRunId: row.branch_run_id,
    nodeRunId: row.node_run_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json, row.id),
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
  }
}

/** workflow_events 数据访问；event_id 唯一，重复投递由 INSERT OR IGNORE 吃掉。 */
export class WorkflowEventRepository {
  constructor(private readonly db: Database) {}

  /** 返回 false 表示 event_id 已存在（重复投递，不重复推进）。 */
  append(input: AppendWorkflowEventInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_events (
           id, event_id, workflow_run_id, branch_run_id, node_run_id, event_type,
           payload_json, occurred_at, correlation_id, causation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('wev'),
        input.eventId,
        input.workflowRunId,
        input.branchRunId ?? null,
        input.nodeRunId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        input.occurredAt,
        input.correlationId ?? null,
        input.causationId ?? null,
      )
    return Number(result.changes) > 0
  }

  getByEventId(eventId: string): WorkflowEventRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_events WHERE event_id = ?').get(eventId) as
      | WorkflowEventRow
      | undefined
    return row ? toRecord(row) : null
  }

  listByRun(workflowRunId: string, limit = 200): WorkflowEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_events WHERE workflow_run_id = ?
         ORDER BY occurred_at ASC, rowid ASC LIMIT ?`,
      )
      .all(workflowRunId, limit) as WorkflowEventRow[]
    return rows.map(toRecord)
  }
}
