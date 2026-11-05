import { newId } from '@agentra/shared'
import type { Database } from '../database'

export const BACKUP_TYPES = ['manual', 'pre_restore'] as const
export type BackupType = (typeof BACKUP_TYPES)[number]

export const BACKUP_STATUSES = ['creating', 'completed', 'failed', 'verified', 'restored'] as const
export type BackupStatus = (typeof BACKUP_STATUSES)[number]

export type BackupArtifactFile = {
  path: string
  sha256: string
  bytes: number
}

export type BackupRecord = {
  id: string
  type: BackupType
  manifestVersion: number
  dbSha256: string | null
  artifactFiles: BackupArtifactFile[]
  fileCount: number
  status: BackupStatus
  storagePath: string
  error: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
  verifiedAt: string | null
}

type BackupRow = {
  id: string
  type: string
  manifest_version: number
  db_sha256: string | null
  artifact_files_json: string
  file_count: number
  status: string
  storage_path: string
  error_json: string | null
  created_at: string
  completed_at: string | null
  verified_at: string | null
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${context}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

function toRecord(row: BackupRow): BackupRecord {
  if (!(BACKUP_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected backups.status: ${row.status}`)
  }
  if (!(BACKUP_TYPES as readonly string[]).includes(row.type)) {
    throw new Error(`unexpected backups.type: ${row.type}`)
  }
  const files = parseJson(row.artifact_files_json, `backups.artifact_files_json(${row.id})`)
  if (!Array.isArray(files)) {
    throw new Error(`backups.artifact_files_json(${row.id}): expected an array`)
  }
  const error =
    row.error_json === null
      ? null
      : (parseJson(row.error_json, `backups.error_json(${row.id})`) as Record<string, unknown>)
  return {
    id: row.id,
    type: row.type as BackupType,
    manifestVersion: row.manifest_version,
    dbSha256: row.db_sha256,
    artifactFiles: files as BackupArtifactFile[],
    fileCount: row.file_count,
    status: row.status as BackupStatus,
    storagePath: row.storage_path,
    error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    verifiedAt: row.verified_at,
  }
}

/** backups 数据访问；不自己开事务。 */
export class BackupRepository {
  constructor(private readonly db: Database) {}

  create(input: { id?: string; type: BackupType; storagePath: string }, now: string): BackupRecord {
    const id = input.id ?? newId('bak')
    this.db
      .prepare(
        `INSERT INTO backups (
           id, type, manifest_version, db_sha256, artifact_files_json, file_count,
           status, storage_path, error_json, created_at, completed_at, verified_at
         ) VALUES (?, ?, 1, NULL, '[]', 0, 'creating', ?, NULL, ?, NULL, NULL)`,
      )
      .run(id, input.type, input.storagePath, now)
    const created = this.get(id)
    if (!created) throw new Error(`backups(${id}) missing after insert`)
    return created
  }

  get(id: string): BackupRecord | null {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as
      | BackupRow
      | undefined
    return row ? toRecord(row) : null
  }

  list(limit = 50): BackupRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM backups ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as BackupRow[]
    return rows.map(toRecord)
  }

  /** 成功完成：写 db_sha256 / 文件清单 / 计数 / 时间戳；只有 creating 能迁移。 */
  markCompleted(
    id: string,
    input: { dbSha256: string; files: BackupArtifactFile[]; status?: 'completed' | 'verified' },
    now: string,
  ): boolean {
    // S55-2C：status 与 verified_at 必须同源——默认 verified 时不得留下 null 验证时间，
    // 否则 pre_restore 记录无法通过 RestorePreBackupRecordSchema。
    const status = input.status ?? 'verified'
    const result = this.db
      .prepare(
        `UPDATE backups SET
           status = ?, db_sha256 = ?, artifact_files_json = ?, file_count = ?,
           completed_at = ?, verified_at = ?
         WHERE id = ? AND status = 'creating'`,
      )
      .run(
        status,
        input.dbSha256,
        JSON.stringify(input.files),
        input.files.length,
        now,
        status === 'verified' ? now : null,
        id,
      )
    return Number(result.changes) > 0
  }

  /** 失败：status=failed + error_json；失败永远不能呈现为 completed。 */
  markFailed(id: string, error: Record<string, unknown>, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE backups SET status = 'failed', error_json = ?, completed_at = ?
         WHERE id = ? AND status = 'creating'`,
      )
      .run(JSON.stringify(error), now, id)
    return Number(result.changes) > 0
  }

  markRestored(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE backups SET status = 'restored', verified_at = ? WHERE id = ? AND status IN ('completed', 'verified')",
      )
      .run(now, id)
    return Number(result.changes) > 0
  }

  /**
   * S55-2C：恢复后的目标备份 self-row 在 VACUUM INTO 时仍可能是 creating。
   * 受控修复同时补齐快照时尚未知的 hash/文件清单；已 restored 时必须全字段一致。
   */
  repairRestoredSelfRow(
    input: {
      id: string
      manifestVersion: number
      dbSha256: string
      files: BackupArtifactFile[]
      storagePath: string
    },
    now: string,
  ): boolean {
    const current = this.get(input.id)
    if (!current) return false
    if (current.status === 'restored') {
      return (
        current.manifestVersion === input.manifestVersion &&
        current.dbSha256 === input.dbSha256 &&
        current.fileCount === input.files.length &&
        current.storagePath === input.storagePath &&
        JSON.stringify(current.artifactFiles) === JSON.stringify(input.files)
      )
    }
    const result = this.db
      .prepare(
        `UPDATE backups SET
           status = 'restored', manifest_version = ?, db_sha256 = ?,
           artifact_files_json = ?, file_count = ?, storage_path = ?,
           verified_at = ?, completed_at = COALESCE(completed_at, ?)
         WHERE id = ? AND status IN ('creating', 'completed', 'verified')`,
      )
      .run(
        input.manifestVersion,
        input.dbSha256,
        JSON.stringify(input.files),
        input.files.length,
        input.storagePath,
        now,
        now,
        input.id,
      )
    return Number(result.changes) > 0
  }

  /**
   * S55-2C：在恢复后的新 DB 中幂等重新登记 pre_restore。
   * 已存在时必须所有安全字段逐项一致；禁止无条件 upsert 覆盖。
   */
  registerVerified(input: {
    id: string
    type: BackupType
    manifestVersion: number
    dbSha256: string
    files: BackupArtifactFile[]
    storagePath: string
    createdAt: string
    completedAt: string
    verifiedAt: string
  }): BackupRecord {
    const existing = this.get(input.id)
    if (existing) {
      const same =
        existing.type === input.type &&
        existing.manifestVersion === input.manifestVersion &&
        existing.dbSha256 === input.dbSha256 &&
        existing.fileCount === input.files.length &&
        existing.storagePath === input.storagePath &&
        existing.createdAt === input.createdAt &&
        existing.completedAt === input.completedAt &&
        existing.verifiedAt === input.verifiedAt &&
        JSON.stringify(existing.artifactFiles) === JSON.stringify(input.files) &&
        existing.status === 'verified'
      if (!same) throw new Error(`pre_restore backup row conflicts with existing row: ${input.id}`)
      return existing
    }
    this.db
      .prepare(
        `INSERT INTO backups (
           id, type, manifest_version, db_sha256, artifact_files_json, file_count,
           status, storage_path, error_json, created_at, completed_at, verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, NULL, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.type,
        input.manifestVersion,
        input.dbSha256,
        JSON.stringify(input.files),
        input.files.length,
        input.storagePath,
        input.createdAt,
        input.completedAt,
        input.verifiedAt,
      )
    const registered = this.get(input.id)
    if (!registered) throw new Error(`pre_restore row missing after registration: ${input.id}`)
    return registered
  }
}
