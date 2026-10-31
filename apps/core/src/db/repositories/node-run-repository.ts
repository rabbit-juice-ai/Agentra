import {
  assertNodeTransition,
  isTerminalNodeStatus,
  NODE_RUN_STATUSES,
  type NodeRunStatus,
} from '../../workflow/state-machine'
import type { NodeFailure } from '../../workflow/types'
import type { Database } from '../database'

export type NodeRunRecord = {
  id: string
  workflowRunId: string
  workflowNodeKey: string
  branchRunId: string | null
  status: NodeRunStatus
  attempt: number
  inputSnapshot: Record<string, unknown>
  outputSnapshot: Record<string, unknown> | null
  error: NodeFailure | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CreateNodeRunInput = {
  id: string
  workflowRunId: string
  workflowNodeKey: string
  branchRunId?: string | null
  status?: NodeRunStatus
  attempt?: number
  inputSnapshot?: Record<string, unknown>
}

type NodeRunRow = {
  id: string
  workflow_run_id: string
  workflow_node_key: string
  branch_run_id: string | null
  status: string
  attempt: number
  input_snapshot_json: string
  output_snapshot_json: string | null
  error_json: string | null
  started_at: string | null
  ended_at: string | null
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

function toRecord(row: NodeRunRow): NodeRunRecord {
  if (!(NODE_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected node_runs.status: ${row.status}`)
  }
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    workflowNodeKey: row.workflow_node_key,
    branchRunId: row.branch_run_id,
    status: row.status as NodeRunStatus,
    attempt: row.attempt,
    inputSnapshot: parseJsonObject(
      row.input_snapshot_json,
      `node_runs.input_snapshot_json(${row.id})`,
    ),
    outputSnapshot:
      row.output_snapshot_json === null
        ? null
        : parseJsonObject(row.output_snapshot_json, `node_runs.output_snapshot_json(${row.id})`),
    error:
      row.error_json === null
        ? null
        : (parseJsonObject(row.error_json, `node_runs.error_json(${row.id})`) as NodeFailure),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** node_runs 数据访问；不自己开事务。 */
export class NodeRunRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateNodeRunInput, now: string): NodeRunRecord {
    const status = input.status ?? 'blocked'
    if (!(NODE_RUN_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid node run status: ${status}`)
    }
    const attempt = input.attempt ?? 1
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error(`invalid node run attempt: ${attempt}`)
    }
    this.db
      .prepare(
        `INSERT INTO node_runs (
           id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt,
           input_snapshot_json, output_snapshot_json, error_json, started_at, ended_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowRunId,
        input.workflowNodeKey,
        input.branchRunId ?? null,
        status,
        attempt,
        JSON.stringify(input.inputSnapshot ?? {}),
        status === 'running' ? now : null,
        now,
        now,
      )
    const created = this.get(input.id)
    if (!created) throw new Error(`node_runs(${input.id}) missing after insert`)
    return created
  }

  get(id: string): NodeRunRecord | null {
    const row = this.db.prepare('SELECT * FROM node_runs WHERE id = ?').get(id) as
      | NodeRunRow
      | undefined
    return row ? toRecord(row) : null
  }

  listByRun(workflowRunId: string): NodeRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM node_runs WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(workflowRunId) as NodeRunRow[]
    return rows.map(toRecord)
  }

  listByRunAndKey(workflowRunId: string, workflowNodeKey: string): NodeRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_runs WHERE workflow_run_id = ? AND workflow_node_key = ?
         ORDER BY attempt ASC, id ASC`,
      )
      .all(workflowRunId, workflowNodeKey) as NodeRunRow[]
    return rows.map(toRecord)
  }

  transition(
    id: string,
    from: readonly NodeRunStatus[],
    to: NodeRunStatus,
    now: string,
    patch?: {
      inputSnapshot?: Record<string, unknown>
      outputSnapshot?: Record<string, unknown>
    },
  ): boolean {
    if (from.length === 0) throw new Error('transition requires at least one expected status')
    for (const status of from) assertNodeTransition(status, to)

    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE node_runs
         SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ?,
             input_snapshot_json = COALESCE(?, input_snapshot_json),
             output_snapshot_json = COALESCE(?, output_snapshot_json),
             updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        to,
        to === 'running' ? now : null,
        isTerminalNodeStatus(to) ? now : null,
        patch?.inputSnapshot === undefined ? null : JSON.stringify(patch.inputSnapshot),
        patch?.outputSnapshot === undefined ? null : JSON.stringify(patch.outputSnapshot),
        now,
        id,
        ...from,
      )
    return Number(result.changes) > 0
  }

  /**
   * 失败入口：failed 必须携带结构化错误（category + nodeKey），
   * 不允许只写一句话——S4-4 的 Assignment 失败要靠 category 区分。
   */
  fail(id: string, from: readonly NodeRunStatus[], failure: NodeFailure, now: string): boolean {
    if (from.length === 0) throw new Error('transition requires at least one expected status')
    for (const status of from) assertNodeTransition(status, 'failed')
    if (failure.nodeKey.length === 0 || failure.message.length === 0) {
      throw new Error('node failure requires nodeKey and message')
    }

    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE node_runs
         SET status = 'failed', error_json = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(JSON.stringify(failure), now, now, id, ...from)
    return Number(result.changes) > 0
  }
}
