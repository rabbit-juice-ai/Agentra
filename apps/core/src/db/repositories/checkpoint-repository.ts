import type {
  CheckpointKind,
  CheckpointState,
  EvidenceStatus,
  RiskLevel,
  SideEffectCompleteness,
} from '../../services/checkpoint-schemas'
import type { Database } from '../database'

export type CheckpointRecord = {
  id: string
  workId: string
  seq: number
  baseDedupeKey: string
  dedupeKey: string
  attemptNo: number
  state: CheckpointState
  kind: CheckpointKind
  stage: string
  executionId: string | null
  sessionId: string | null
  nodeRunId: string | null
  teamRunId: string | null
  parentCheckpointId: string | null
  acceptanceCriteriaWorkVersion: number
  taskMemoryVersion: number | null
  riskLevel: RiskLevel
  evidenceStatus: EvidenceStatus
  sideEffectCompleteness: SideEffectCompleteness
  checkpointJson: string
  evidenceJson: string
  verificationJson: string
  errorJson: string | null
  contentHash: string
  createdAt: string
}

type CheckpointRow = {
  id: string
  work_id: string
  seq: number
  base_dedupe_key: string
  dedupe_key: string
  attempt_no: number
  state: string
  kind: string
  stage: string
  execution_id: string | null
  session_id: string | null
  node_run_id: string | null
  team_run_id: string | null
  parent_checkpoint_id: string | null
  acceptance_criteria_work_version: number
  task_memory_version: number | null
  risk_level: string
  evidence_status: string
  side_effect_completeness: string
  checkpoint_json: string
  evidence_json: string
  verification_json: string
  error_json: string | null
  content_hash: string
  created_at: string
}

function toRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    workId: row.work_id,
    seq: row.seq,
    baseDedupeKey: row.base_dedupe_key,
    dedupeKey: row.dedupe_key,
    attemptNo: row.attempt_no,
    state: row.state as CheckpointState,
    kind: row.kind as CheckpointKind,
    stage: row.stage,
    executionId: row.execution_id,
    sessionId: row.session_id,
    nodeRunId: row.node_run_id,
    teamRunId: row.team_run_id,
    parentCheckpointId: row.parent_checkpoint_id,
    acceptanceCriteriaWorkVersion: row.acceptance_criteria_work_version,
    taskMemoryVersion: row.task_memory_version,
    riskLevel: row.risk_level as RiskLevel,
    evidenceStatus: row.evidence_status as EvidenceStatus,
    sideEffectCompleteness: row.side_effect_completeness as SideEffectCompleteness,
    checkpointJson: row.checkpoint_json,
    evidenceJson: row.evidence_json,
    verificationJson: row.verification_json,
    errorJson: row.error_json,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** task_checkpoints 只允许 INSERT / SELECT；UPDATE / DELETE 由迁移触发器拒绝。 */
export class CheckpointRepository {
  constructor(private readonly db: Database) {}

  get(id: string): CheckpointRecord | null {
    const row = this.db.prepare('SELECT * FROM task_checkpoints WHERE id = ?').get(id) as
      | CheckpointRow
      | undefined
    return row ? toRecord(row) : null
  }

  getByDedupeKey(workId: string, dedupeKey: string): CheckpointRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_checkpoints WHERE work_id = ? AND dedupe_key = ?')
      .get(workId, dedupeKey) as CheckpointRow | undefined
    return row ? toRecord(row) : null
  }

  getLatestValid(workId: string): CheckpointRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE work_id = ? AND state = 'valid'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(workId) as CheckpointRow | undefined
    return row ? toRecord(row) : null
  }

  getLatestByExecution(executionId: string): CheckpointRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE execution_id = ?
         ORDER BY created_at DESC, seq DESC LIMIT 1`,
      )
      .get(executionId) as CheckpointRow | undefined
    return row ? toRecord(row) : null
  }

  getLatestAttempt(workId: string, baseDedupeKey: string): CheckpointRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE work_id = ? AND base_dedupe_key = ?
         ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(workId, baseDedupeKey) as CheckpointRow | undefined
    return row ? toRecord(row) : null
  }

  listByWork(workId: string, limit = 100): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_checkpoints
         WHERE work_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(workId, limit) as CheckpointRow[]
    return rows.map(toRecord)
  }

  nextSeq(workId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM task_checkpoints WHERE work_id = ?')
      .get(workId) as { next: number }
    return row.next
  }

  insert(record: CheckpointRecord): void {
    this.db
      .prepare(
        `INSERT INTO task_checkpoints (
          id, work_id, seq, base_dedupe_key, dedupe_key, attempt_no, state, kind, stage,
          execution_id, session_id, node_run_id, team_run_id, parent_checkpoint_id,
          acceptance_criteria_work_version, task_memory_version, risk_level, evidence_status,
          side_effect_completeness, checkpoint_json, evidence_json, verification_json,
          error_json, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.seq,
        record.baseDedupeKey,
        record.dedupeKey,
        record.attemptNo,
        record.state,
        record.kind,
        record.stage,
        record.executionId,
        record.sessionId,
        record.nodeRunId,
        record.teamRunId,
        record.parentCheckpointId,
        record.acceptanceCriteriaWorkVersion,
        record.taskMemoryVersion,
        record.riskLevel,
        record.evidenceStatus,
        record.sideEffectCompleteness,
        record.checkpointJson,
        record.evidenceJson,
        record.verificationJson,
        record.errorJson,
        record.contentHash,
        record.createdAt,
      )
  }

  /** 只返回每个业务键最新的失败尝试，且未被 valid 覆盖、未超过上限。 */
  listRetryableFailures(maxAttempts: number, limit = 20): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM task_checkpoints f
         WHERE f.state = 'failed'
           AND f.attempt_no < ?
           AND NOT EXISTS (
             SELECT 1 FROM task_checkpoints v
             WHERE v.work_id = f.work_id
               AND v.base_dedupe_key = f.base_dedupe_key
               AND v.state = 'valid'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_checkpoints n
             WHERE n.work_id = f.work_id
               AND n.base_dedupe_key = f.base_dedupe_key
               AND n.attempt_no > f.attempt_no
           )
         ORDER BY f.created_at ASC LIMIT ?`,
      )
      .all(maxAttempts, limit) as CheckpointRow[]
    return rows.map(toRecord)
  }

  /** 最近一次未被 valid 覆盖的失败尝试（用于高风险启动阻断）。 */
  listLatestFailures(workId: string, limit = 20): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM task_checkpoints f
         WHERE f.work_id = ? AND f.state = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM task_checkpoints v
             WHERE v.work_id = f.work_id
               AND v.base_dedupe_key = f.base_dedupe_key
               AND v.state = 'valid'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_checkpoints n
             WHERE n.work_id = f.work_id
               AND n.base_dedupe_key = f.base_dedupe_key
               AND n.attempt_no > f.attempt_no
           )
         ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(workId, limit) as CheckpointRow[]
    return rows.map(toRecord)
  }
}
