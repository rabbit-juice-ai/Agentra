import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  BackupArtifactFile,
  BackupRecord,
  BackupRepository,
  BackupType,
} from '../db/repositories/backup-repository'

export type BackupServiceErrorCode =
  | 'BACKUP_NOT_FOUND'
  | 'BACKUP_DIR_UNREADABLE'
  | 'EXPORT_PATH_INVALID'
  | 'INTEGRITY_CHECK_FAILED'
  | 'ARTIFACT_MISSING'

export class BackupError extends Error {
  constructor(
    readonly code: BackupServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export type BackupManifest = {
  manifestVersion: number
  createdAt: string
  type: BackupType
  database: { file: 'database.db'; sha256: string; bytes: number }
  artifacts: BackupArtifactFile[]
  counts: { artifacts: number; files: number }
}

export type BackupLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

const MANIFEST_VERSION = 1
const ARTIFACTS_DIR = 'artifacts'
const DATABASE_FILE = 'database.db'
const MANIFEST_FILE = 'manifest.json'

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/** 解析真实路径；目标或其祖先不存在时，保留缺失部分并解析最近的已存在祖先。 */
function realpathAllowMissing(input: string): string {
  let current = path.resolve(input)
  const missing: string[] = []
  while (true) {
    try {
      const real = fs.realpathSync(current)
      return path.join(real, ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        throw new BackupError(
          'EXPORT_PATH_INVALID',
          `cannot resolve export path ${input}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw new BackupError('EXPORT_PATH_INVALID', `cannot resolve export path ${input}`)
      }
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * 备份链（S55-1，DATABASE §2.10 / D-013）。
 *
 * **一致性方式：`VACUUM INTO`**（不用 backup API）。理由：
 * - 单条 SQL 产生完整快照，SQLite 在 WAL 下保证快照对应某个已提交状态；
 * - 不需要在应用层手动持有读事务/分页拷贝，失败面小；
 * - 备份期间主库仍可写（WAL 读写并发），B2 的并发写入场景天然成立。
 *
 * 失败语义：任何环节失败 → `status=failed` + `error_json` + 审计 `backup.failed`，
 * **绝不返回成功**（B3 的反面要求）。
 */
export class BackupService {
  constructor(
    private readonly db: Database,
    private readonly backups: BackupRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly audit: AuditRepository,
    private readonly backupsRoot: string,
    private readonly artifactsRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly logger?: BackupLogger,
  ) {}

  create(input: { type?: BackupType } = {}): BackupRecord {
    const type = input.type ?? 'manual'
    const id = newId('bak')
    const storagePath = path.join(path.resolve(this.backupsRoot), id)
    const now = this.now()
    this.backups.create({ id, type, storagePath }, now)

    try {
      fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 })
      const databaseFile = path.join(storagePath, DATABASE_FILE)
      // WAL 一致性快照：单条 VACUUM INTO，备份期间主库写入不受阻。
      this.db.prepare('VACUUM INTO ?').run(databaseFile)

      const dbSha256 = sha256File(databaseFile)
      this.assertIntegrity(databaseFile)

      const files = this.copyArtifacts(storagePath)
      const manifest: BackupManifest = {
        manifestVersion: MANIFEST_VERSION,
        createdAt: now,
        type,
        database: { file: DATABASE_FILE, sha256: dbSha256, bytes: fs.statSync(databaseFile).size },
        artifacts: files,
        counts: { artifacts: files.length, files: files.length },
      }
      fs.writeFileSync(path.join(storagePath, MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      })

      const completed = this.backups.markCompleted(id, { dbSha256, files }, this.now())
      if (!completed) throw new Error(`backup ${id} could not transition to completed`)
      this.audit.append({
        actorType: 'system',
        actorId: null,
        action: 'backup.created',
        targetType: 'backup',
        targetId: id,
        details: {
          type,
          dbSha256,
          fileCount: files.length,
          storagePath,
        },
        now: this.now(),
      })
      const saved = this.backups.get(id)
      if (!saved) throw new Error(`backup ${id} missing after completion`)
      return saved
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.backups.markFailed(id, { message, at: this.now() }, this.now())
      this.audit.append({
        actorType: 'system',
        actorId: null,
        action: 'backup.failed',
        targetType: 'backup',
        targetId: id,
        details: { type, error: message, storagePath },
        now: this.now(),
      })
      this.logger?.warn('backup failed', { backupId: id, error: message })
      throw error instanceof BackupError
        ? error
        : new BackupError('BACKUP_DIR_UNREADABLE', `backup ${id} failed: ${message}`)
    }
  }

  list(limit = 50): BackupRecord[] {
    return this.backups.list(limit)
  }

  get(id: string): BackupRecord {
    const record = this.backups.get(id)
    if (!record) throw new BackupError('BACKUP_NOT_FOUND', `backup ${id} not found`)
    return record
  }

  /** 读取备份包 manifest（预检展示用）。 */
  readManifest(id: string): BackupManifest {
    const record = this.get(id)
    const manifestPath = path.join(record.storagePath, MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) {
      throw new BackupError('BACKUP_DIR_UNREADABLE', `manifest missing for backup ${id}`)
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest
  }

  /** 导出到指定目录：`<targetDir>/<backupId>/`，目标必须在 backupsRoot 之外且可写。 */
  exportTo(id: string, targetDir: string): string {
    const record = this.get(id)
    const source = path.resolve(record.storagePath)
    if (!fs.existsSync(source)) {
      throw new BackupError('BACKUP_DIR_UNREADABLE', `backup ${id} directory missing`)
    }
    let backupsRootReal: string
    let sourceReal: string
    try {
      backupsRootReal = fs.realpathSync(path.resolve(this.backupsRoot))
      sourceReal = fs.realpathSync(source)
    } catch (error) {
      throw new BackupError(
        'BACKUP_DIR_UNREADABLE',
        `backup ${id} directory unreadable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const target = path.resolve(targetDir, id)
    const targetReal = realpathAllowMissing(target)
    if (isInsideOrEqual(targetReal, backupsRootReal)) {
      throw new BackupError(
        'EXPORT_PATH_INVALID',
        `export target must be outside backupsRoot: ${target}`,
      )
    }
    if (isInsideOrEqual(targetReal, sourceReal) || isInsideOrEqual(sourceReal, targetReal)) {
      throw new BackupError(
        'EXPORT_PATH_INVALID',
        `export target overlaps the backup package: ${target}`,
      )
    }

    let existing: fs.Stats | undefined
    try {
      existing = fs.lstatSync(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new BackupError(
          'EXPORT_PATH_INVALID',
          `cannot inspect export target ${target}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (existing && !existing.isDirectory()) {
      throw new BackupError('EXPORT_PATH_INVALID', `export target is not a directory: ${target}`)
    }

    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new BackupError(
        'EXPORT_PATH_INVALID',
        `cannot create export target ${target}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    fs.cpSync(source, target, { recursive: true })
    this.audit.append({
      actorType: 'system',
      actorId: null,
      action: 'backup.exported',
      targetType: 'backup',
      targetId: id,
      details: { target },
      now: this.now(),
    })
    return target
  }

  private assertIntegrity(databaseFile: string): void {
    const probe = new DatabaseSync(databaseFile, { readOnly: true })
    try {
      const rows = probe.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      const first = rows[0]?.integrity_check
      if (first !== 'ok') {
        throw new BackupError(
          'INTEGRITY_CHECK_FAILED',
          `backup database integrity_check failed: ${JSON.stringify(rows.slice(0, 3))}`,
        )
      }
    } finally {
      probe.close()
    }
  }

  private copyArtifacts(storagePath: string): BackupArtifactFile[] {
    const root = path.resolve(this.artifactsRoot)
    const targetRoot = path.join(storagePath, ARTIFACTS_DIR)
    const files: BackupArtifactFile[] = []
    for (const version of this.artifacts.listAllVersions()) {
      const source = path.resolve(version.storagePath)
      if (!source.startsWith(`${root}${path.sep}`)) {
        throw new BackupError(
          'ARTIFACT_MISSING',
          `artifact version ${version.id} path escapes artifacts root: ${version.storagePath}`,
        )
      }
      if (!fs.existsSync(source)) {
        throw new BackupError(
          'ARTIFACT_MISSING',
          `artifact version ${version.id} file missing: ${version.storagePath}`,
        )
      }
      const relative = path.relative(root, source)
      const target = path.join(targetRoot, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.copyFileSync(source, target)
      files.push({
        path: relative.split(path.sep).join('/'),
        sha256: sha256File(target),
        bytes: fs.statSync(target).size,
      })
    }
    return files
  }
}
