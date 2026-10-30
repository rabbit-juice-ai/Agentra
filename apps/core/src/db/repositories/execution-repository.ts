import {
  type Execution,
  Execution as ExecutionSchema,
  type ExecutionState,
} from '@agentra/protocol'
import { ProviderCapabilities } from '@agentra/runtime-sdk'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'crashed'] as const

export const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set(TERMINAL_STATES)

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.has(state)
}

type ExecutionRow = {
  id: string
  session_id: string
  node_run_id: string | null
  provider_id: string
  external_execution_id: string | null
  process_id: number | null
  status: string
  working_directory: string
  started_at: string | null
  ended_at: string | null
  exit_code: number | null
  capabilities_snapshot_json: string
  recovery_state_json: string | null
  created_at: string
  updated_at: string
  agent_context_ref: string | null
}

const SELECT_EXECUTION = `
  SELECT e.*, s.context_ref AS agent_context_ref
  FROM executions e
  JOIN agent_sessions s ON s.id = e.session_id
`

function toExecution(row: ExecutionRow): Execution {
  return ExecutionSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    agentId: row.agent_context_ref,
    externalExecutionId: row.external_execution_id,
    processId: row.process_id,
    status: row.status,
    workingDirectory: row.working_directory,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    capabilities: parseJsonColumn(
      ProviderCapabilities,
      row.capabilities_snapshot_json,
      `executions.capabilities_snapshot_json(${row.id})`,
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export type FinishExecutionPatch = {
  status: ExecutionState
  exitCode?: number | null
  endedAt: string
  recoveryState?: Record<string, unknown> | null
}

/** executions 表数据访问。状态迁移只允许从非终态进入终态，或 pending→running。 */
export class ExecutionRepository {
  constructor(private readonly db: Database) {}

  create(execution: Execution): void {
    const capabilities = serializeJsonColumn(
      ProviderCapabilities,
      execution.capabilities,
      'execution.capabilities',
    )
    this.db
      .prepare(
        `INSERT INTO executions (
          id, session_id, node_run_id, provider_id, external_execution_id, process_id, status,
          working_directory, started_at, ended_at, exit_code, capabilities_snapshot_json,
          recovery_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        execution.id,
        execution.sessionId,
        null,
        execution.providerId,
        execution.externalExecutionId,
        execution.processId,
        execution.status,
        execution.workingDirectory,
        execution.startedAt,
        execution.endedAt,
        execution.exitCode,
        capabilities,
        execution.createdAt,
        execution.updatedAt,
      )
  }

  get(id: string): Execution | null {
    const row = this.db.prepare(`${SELECT_EXECUTION} WHERE e.id = ?`).get(id) as
      | ExecutionRow
      | undefined
    return row ? toExecution(row) : null
  }

  list(limit = 50): Execution[] {
    const rows = this.db
      .prepare(`${SELECT_EXECUTION} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`)
      .all(limit) as ExecutionRow[]
    return rows.map(toExecution)
  }

  listActive(): Execution[] {
    const rows = this.db
      .prepare(
        `${SELECT_EXECUTION} WHERE e.status IN ('pending', 'running') ORDER BY e.created_at ASC`,
      )
      .all() as ExecutionRow[]
    return rows.map(toExecution)
  }

  /** pending/running → running；返回是否真的发生了迁移。 */
  markRunning(
    id: string,
    patch: { processId: number | null; startedAt: string; updatedAt: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE executions SET
          status = 'running', process_id = COALESCE(?, process_id),
          started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(patch.processId, patch.startedAt, patch.updatedAt, id)
    return result.changes > 0
  }

  /**
   * 进入终态。已有终态时只补全 exit_code/ended_at（不覆盖历史状态），
   * 返回状态是否发生变化。
   */
  finish(id: string, patch: FinishExecutionPatch): boolean {
    const recovery = patch.recoveryState ? JSON.stringify(patch.recoveryState) : null
    const result = this.db
      .prepare(
        `UPDATE executions SET
          status = ?, exit_code = COALESCE(exit_code, ?), ended_at = COALESCE(ended_at, ?),
          recovery_state_json = COALESCE(?, recovery_state_json), updated_at = ?
        WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'crashed')`,
      )
      .run(patch.status, patch.exitCode ?? null, patch.endedAt, recovery, patch.endedAt, id)
    if (result.changes > 0) return true
    // 已是终态：只补全元数据。
    this.db
      .prepare(
        `UPDATE executions SET
          exit_code = COALESCE(exit_code, ?), ended_at = COALESCE(ended_at, ?),
          recovery_state_json = COALESCE(?, recovery_state_json), updated_at = ?
        WHERE id = ?`,
      )
      .run(patch.exitCode ?? null, patch.endedAt, recovery, patch.endedAt, id)
    return false
  }

  setRecoveryState(id: string, state: Record<string, unknown>, updatedAt: string): void {
    this.db
      .prepare('UPDATE executions SET recovery_state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), updatedAt, id)
  }
}
