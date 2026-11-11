import type { Database } from '../database'

export const RECOVERY_ATTEMPT_KINDS = ['team', 'work', 'generic', 'workflow_node'] as const
export type RecoveryAttemptKind = (typeof RECOVERY_ATTEMPT_KINDS)[number]

export const RECOVERY_ATTEMPT_STATUSES = [
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
] as const
export type RecoveryAttemptStatus = (typeof RECOVERY_ATTEMPT_STATUSES)[number]

export type RecoveryAttemptRecord = {
  id: string
  workId: string
  checkpointId: string
  kind: RecoveryAttemptKind
  baseDedupeKey: string
  dedupeKey: string
  idempotencyKey: string
  attemptNo: number
  status: RecoveryAttemptStatus
  riskLevel: 'low' | 'medium' | 'high'
  eligibilityStatus: 'eligible' | 'conditional' | 'blocked'
  originalWorkStatus: string | null
  reopenReason: string | null
  operatorConfirmationJson: string
  planHash: string
  contextManifestJson: string
  executionId: string | null
  sessionId: string | null
  teamRunId: string | null
  nodeRunId: string | null
  workflowRunId: string | null
  branchRunId: string | null
  recoveredNodeRunId: string | null
  chainAttemptNo: number | null
  errorJson: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
}

type RecoveryAttemptRow = {
  id: string
  work_id: string
  checkpoint_id: string
  kind: string
  base_dedupe_key: string
  dedupe_key: string
  idempotency_key: string
  attempt_no: number
  status: string
  risk_level: string
  eligibility_status: string
  original_work_status: string | null
  reopen_reason: string | null
  operator_confirmation_json: string
  plan_hash: string
  context_manifest_json: string
  execution_id: string | null
  session_id: string | null
  team_run_id: string | null
  node_run_id: string | null
  workflow_run_id: string | null
  branch_run_id: string | null
  recovered_node_run_id: string | null
  chain_attempt_no: number | null
  error_json: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  ended_at: string | null
}

function toRecord(row: RecoveryAttemptRow): RecoveryAttemptRecord {
  if (!(RECOVERY_ATTEMPT_KINDS as readonly string[]).includes(row.kind)) {
    throw new Error(`unexpected task_recovery_attempts.kind: ${row.kind}`)
  }
  if (!(RECOVERY_ATTEMPT_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected task_recovery_attempts.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    checkpointId: row.checkpoint_id,
    kind: row.kind as RecoveryAttemptKind,
    baseDedupeKey: row.base_dedupe_key,
    dedupeKey: row.dedupe_key,
    idempotencyKey: row.idempotency_key,
    attemptNo: row.attempt_no,
    status: row.status as RecoveryAttemptStatus,
    riskLevel: row.risk_level as RecoveryAttemptRecord['riskLevel'],
    eligibilityStatus: row.eligibility_status as RecoveryAttemptRecord['eligibilityStatus'],
    originalWorkStatus: row.original_work_status,
    reopenReason: row.reopen_reason,
    operatorConfirmationJson: row.operator_confirmation_json,
    planHash: row.plan_hash,
    contextManifestJson: row.context_manifest_json,
    executionId: row.execution_id,
    sessionId: row.session_id,
    teamRunId: row.team_run_id,
    nodeRunId: row.node_run_id,
    workflowRunId: row.workflow_run_id,
    branchRunId: row.branch_run_id,
    recoveredNodeRunId: row.recovered_node_run_id,
    chainAttemptNo: row.chain_attempt_no,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

/** task_recovery_attempts 的唯一数据入口；状态更新使用 CAS。 */
export class RecoveryAttemptRepository {
  constructor(private readonly db: Database) {}

  get(id: string): RecoveryAttemptRecord | null {
    const row = this.db.prepare('SELECT * FROM task_recovery_attempts WHERE id = ?').get(id) as
      | RecoveryAttemptRow
      | undefined
    return row ? toRecord(row) : null
  }

  getByIdempotencyKey(workId: string, idempotencyKey: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_recovery_attempts WHERE work_id = ? AND idempotency_key = ?')
      .get(workId, idempotencyKey) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  getActiveByWork(workId: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE work_id = ? AND status IN ('starting', 'running')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(workId) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  getByExecutionId(executionId: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_recovery_attempts WHERE execution_id = ?')
      .get(executionId) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  getByTeamRunId(teamRunId: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_recovery_attempts WHERE team_run_id = ?')
      .get(teamRunId) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  getByNodeRunId(nodeRunId: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE kind = 'workflow_node' AND node_run_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(nodeRunId) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  getByRecoveredNodeRunId(recoveredNodeRunId: string): RecoveryAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE kind = 'workflow_node' AND recovered_node_run_id = ?
         ORDER BY chain_attempt_no ASC, created_at ASC`,
      )
      .all(recoveredNodeRunId) as RecoveryAttemptRow[]
    return rows.map(toRecord)
  }

  countByRecoveredNodeRun(recoveredNodeRunId: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS c FROM task_recovery_attempts
         WHERE kind = 'workflow_node' AND recovered_node_run_id = ?`,
      )
      .get(recoveredNodeRunId) as { c: number }
    return row.c
  }

  getActiveByRecoveredNodeRun(recoveredNodeRunId: string): RecoveryAttemptRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE kind = 'workflow_node'
           AND recovered_node_run_id = ?
           AND status IN ('starting', 'running')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(recoveredNodeRunId) as RecoveryAttemptRow | undefined
    return row ? toRecord(row) : null
  }

  nextChainAttemptNo(recoveredNodeRunId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(chain_attempt_no), 0) + 1 AS next
         FROM task_recovery_attempts
         WHERE kind = 'workflow_node' AND recovered_node_run_id = ?`,
      )
      .get(recoveredNodeRunId) as { next: number }
    return row.next
  }

  /** T2a：在文件系统创建前写入 Worktree 归属意图（CAS：仅 starting 且尚无 worktree）。 */
  updateWorktreeIntent(id: string, manifestJson: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET context_manifest_json = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'
           AND json_extract(context_manifest_json, '$.worktree') IS NULL`,
      )
      .run(manifestJson, now, id)
    return Number(result.changes) > 0
  }

  /** T2b：creating → ready，必须匹配 owner token。 */
  updateWorktreeReady(id: string, manifestJson: string, ownerToken: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET context_manifest_json = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'
           AND json_extract(context_manifest_json, '$.worktree.state') = 'creating'
           AND json_extract(context_manifest_json, '$.worktree.worktreeOwnerToken') = ?`,
      )
      .run(manifestJson, now, id, ownerToken)
    return Number(result.changes) > 0
  }

  /** Worktree 对账：按 expected state 做 CAS 更新 context manifest。 */
  updateWorktreeDisposition(
    id: string,
    expectedState: string,
    manifestJson: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET context_manifest_json = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'
           AND json_extract(context_manifest_json, '$.worktree.state') = ?`,
      )
      .run(manifestJson, now, id, expectedState)
    return Number(result.changes) > 0
  }

  /** starting → running（workflow_node）：同时写新 NodeRun / Run / Branch 关联。 */
  markWorkflowRunning(
    id: string,
    link: {
      executionId: string
      sessionId: string
      nodeRunId: string
      workflowRunId: string
      branchRunId: string | null
    },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET status = 'running', execution_id = ?, session_id = ?, node_run_id = ?,
             workflow_run_id = ?, branch_run_id = ?, started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      )
      .run(
        link.executionId,
        link.sessionId,
        link.nodeRunId,
        link.workflowRunId,
        link.branchRunId,
        now,
        now,
        id,
      )
    return Number(result.changes) > 0
  }

  listByWork(workId: string, limit = 50): RecoveryAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE work_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(workId, limit) as RecoveryAttemptRow[]
    return rows.map(toRecord)
  }

  listByCheckpoint(workId: string, checkpointId: string): RecoveryAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE work_id = ? AND checkpoint_id = ? ORDER BY attempt_no ASC`,
      )
      .all(workId, checkpointId) as RecoveryAttemptRow[]
    return rows.map(toRecord)
  }

  countByCheckpoint(workId: string, checkpointId: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS c FROM task_recovery_attempts
         WHERE work_id = ? AND checkpoint_id = ?`,
      )
      .get(workId, checkpointId) as { c: number }
    return row.c
  }

  nextAttemptNo(workId: string, checkpointId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM task_recovery_attempts
         WHERE work_id = ? AND checkpoint_id = ?`,
      )
      .get(workId, checkpointId) as { next: number }
    return row.next
  }

  insert(record: RecoveryAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO task_recovery_attempts (
          id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
          attempt_no, status, risk_level, eligibility_status, original_work_status,
          reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
          execution_id, session_id, team_run_id, node_run_id, workflow_run_id,
          branch_run_id, recovered_node_run_id, chain_attempt_no,
          error_json, created_at, updated_at, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.checkpointId,
        record.kind,
        record.baseDedupeKey,
        record.dedupeKey,
        record.idempotencyKey,
        record.attemptNo,
        record.status,
        record.riskLevel,
        record.eligibilityStatus,
        record.originalWorkStatus,
        record.reopenReason,
        record.operatorConfirmationJson,
        record.planHash,
        record.contextManifestJson,
        record.executionId,
        record.sessionId,
        record.teamRunId,
        record.nodeRunId,
        record.workflowRunId,
        record.branchRunId,
        record.recoveredNodeRunId,
        record.chainAttemptNo,
        record.errorJson,
        record.createdAt,
        record.updatedAt,
        record.startedAt,
        record.endedAt,
      )
  }

  updateContextManifest(id: string, manifestJson: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET context_manifest_json = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      )
      .run(manifestJson, now, id)
    return result.changes > 0
  }

  /** starting → running，同时写入新 Session/Execution/TeamRun 关联。 */
  markRunning(
    id: string,
    link: { executionId: string; sessionId: string; teamRunId: string | null },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET status = 'running', execution_id = ?, session_id = ?, team_run_id = ?,
             started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      )
      .run(link.executionId, link.sessionId, link.teamRunId, now, now, id)
    return result.changes > 0
  }

  updateTeamRun(id: string, teamRunId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET team_run_id = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting', 'running')`,
      )
      .run(teamRunId, now, id)
    return result.changes > 0
  }

  /** 终态更新；只允许从非终态进入。 */
  finish(
    id: string,
    status: Extract<RecoveryAttemptStatus, 'succeeded' | 'failed' | 'cancelled' | 'blocked'>,
    errorJson: string | null,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET status = ?, error_json = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting', 'running')`,
      )
      .run(status, errorJson, now, now, id)
    return result.changes > 0
  }

  finishByExecution(
    executionId: string,
    status: Extract<RecoveryAttemptStatus, 'succeeded' | 'failed' | 'cancelled'>,
    errorJson: string | null,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_recovery_attempts
         SET status = ?, error_json = ?, ended_at = ?, updated_at = ?
         WHERE execution_id = ? AND status IN ('starting', 'running')`,
      )
      .run(status, errorJson, now, now, executionId)
    return result.changes > 0
  }

  failStarting(id: string, errorJson: string, now: string): boolean {
    return this.finish(id, 'failed', errorJson, now)
  }

  listUnfinished(): RecoveryAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_recovery_attempts
         WHERE status IN ('starting', 'running')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as RecoveryAttemptRow[]
    return rows.map(toRecord)
  }
}
