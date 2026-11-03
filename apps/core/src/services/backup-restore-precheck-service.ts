import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  BackupRestorePrecheckFailureCode,
  BackupRestorePrecheckResult,
} from '@agentra/protocol'
import { z } from 'zod'
import type { BackupRepository } from '../db/repositories/backup-repository'

const MANIFEST_FILE = 'manifest.json'
const DATABASE_FILE = 'database.db'
const ARTIFACTS_DIR = 'artifacts'
const SUPPORTED_MANIFEST_VERSION = 1
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0
const SAFE_READ_FLAGS = fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

const ManifestArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
  })
  .strict()

const BackupManifestSchema = z
  .object({
    manifestVersion: z.number().int().min(1),
    createdAt: z.string().min(1),
    type: z.enum(['manual', 'pre_restore']),
    database: z
      .object({
        file: z.literal(DATABASE_FILE),
        sha256: Sha256Schema,
        bytes: z.number().int().min(0),
      })
      .strict(),
    artifacts: z.array(ManifestArtifactSchema),
    counts: z
      .object({
        artifacts: z.number().int().min(0),
        files: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()

class PrecheckFailure extends Error {
  constructor(
    readonly code: BackupRestorePrecheckFailureCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'PrecheckFailure'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function resolveExistingDir(
  root: string,
  code: BackupRestorePrecheckFailureCode,
  label: string,
): string {
  let stat: fs.Stats
  try {
    stat = fs.statSync(root)
  } catch (error) {
    throw new PrecheckFailure(code, `${label} unavailable`, {
      path: root,
      error: errorMessage(error),
    })
  }
  if (!stat.isDirectory()) {
    throw new PrecheckFailure(code, `${label} is not a directory`, { path: root })
  }
  try {
    return fs.realpathSync(root)
  } catch (error) {
    throw new PrecheckFailure(code, `${label} cannot be resolved`, {
      path: root,
      error: errorMessage(error),
    })
  }
}

function realpathAllowMissing(
  input: string,
  code: BackupRestorePrecheckFailureCode,
  label: string,
): string {
  let current = path.resolve(input)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing)
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code
      if (errno !== 'ENOENT') {
        throw new PrecheckFailure(code, `${label} cannot be resolved`, {
          path: input,
          error: errorMessage(error),
        })
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw new PrecheckFailure(code, `${label} cannot be resolved`, { path: input })
      }
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

function assertNoSymlinkComponents(
  rootReal: string,
  relativePath: string,
  code: BackupRestorePrecheckFailureCode,
  label: string,
): void {
  const parts = relativePath.split(path.sep).filter((part) => part.length > 0)
  let current = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] as string)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new PrecheckFailure(code, `${label} cannot be inspected`, {
        path: current,
        error: errorMessage(error),
      })
    }
    if (stat.isSymbolicLink()) {
      throw new PrecheckFailure(code, `${label} contains a symlink`, { path: current })
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new PrecheckFailure(code, `${label} parent is not a directory`, { path: current })
    }
  }
}

function safeArtifactRelativePath(relativePath: string): string[] | null {
  if (!relativePath || relativePath.includes('\\') || path.isAbsolute(relativePath)) return null
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts
}

function hashFd(fd: number): { size: number; sha256: string } {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1 << 20)
  let position = 0
  let size = 0
  while (true) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position)
    if (read === 0) break
    hash.update(buffer.subarray(0, read))
    position += read
    size += read
  }
  return { size, sha256: hash.digest('hex') }
}

function copyAndHashFd(fd: number, destination: string): { size: number; sha256: string } {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1 << 20)
  const output = fs.openSync(destination, 'w', 0o600)
  let position = 0
  let size = 0
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      fs.writeSync(output, buffer, 0, read)
      position += read
      size += read
    }
  } finally {
    fs.closeSync(output)
  }
  return { size, sha256: hash.digest('hex') }
}

function fail(
  base: BackupRestorePrecheckResult,
  code: BackupRestorePrecheckFailureCode,
  message: string,
  detail?: unknown,
): BackupRestorePrecheckResult {
  return {
    ...base,
    allowedToRestore: false,
    failure: detail === undefined ? { code, message } : { code, message, detail },
  }
}

/**
 * S55-2A：备份恢复预检（只读）。
 *
 * 只读取备份记录、manifest、数据库副本与 Artifact 文件；不创建 pre_restore、
 * 不修改备份状态/manifest/数据库/Artifact、不写 journal、不进入维护模式。
 *
 * 路径安全：根目录 realpath 后作为可信根；目录层级逐级 lstat 拒绝符号链接；
 * 最终文件使用 O_NOFOLLOW 打开并从同一 fd 读取/哈希（Node 无 openat，
 * 父目录在检查与打开之间被并发替换的窗口无法完全消除）。
 */
export class BackupRestorePrecheckService {
  constructor(
    private readonly backups: BackupRepository,
    private readonly backupsRoot: string,
    private readonly artifactsRoot: string,
    private readonly currentUserVersion: number,
  ) {}

  precheck(backupId: string): BackupRestorePrecheckResult {
    let partial: BackupRestorePrecheckResult = {
      backupId,
      type: null,
      createdAt: null,
      manifestVersion: null,
      database: null,
      artifactCount: null,
      schemaCompatibility: null,
      allowedToRestore: false,
      failure: null,
    }

    try {
      const record = this.backups.get(backupId)
      if (!record) {
        throw new PrecheckFailure('BACKUP_NOT_FOUND', `backup ${backupId} not found`)
      }
      partial = {
        ...partial,
        type: record.type,
        createdAt: record.createdAt,
        manifestVersion: record.manifestVersion,
      }

      const configuredBackupsRoot = path.resolve(this.backupsRoot)
      const backupsRootReal = resolveExistingDir(
        configuredBackupsRoot,
        'BACKUPS_ROOT_UNAVAILABLE',
        'backupsRoot',
      )
      const packageDir = path.resolve(record.storagePath)
      const packageRelative = path.relative(configuredBackupsRoot, packageDir)
      if (
        packageRelative === '' ||
        packageRelative === '..' ||
        packageRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(packageRelative)
      ) {
        throw new PrecheckFailure(
          'BACKUP_PATH_UNSAFE',
          `backup ${backupId} storage path escapes backupsRoot`,
          { storagePath: record.storagePath },
        )
      }
      let packageStat: fs.Stats
      try {
        packageStat = fs.lstatSync(packageDir)
      } catch (error) {
        throw new PrecheckFailure('BACKUP_PATH_UNSAFE', 'backup package directory unavailable', {
          storagePath: record.storagePath,
          error: errorMessage(error),
        })
      }
      if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
        throw new PrecheckFailure('BACKUP_PATH_UNSAFE', 'backup package is not a real directory', {
          storagePath: record.storagePath,
        })
      }
      let packageReal: string
      try {
        packageReal = fs.realpathSync(packageDir)
      } catch (error) {
        throw new PrecheckFailure('BACKUP_PATH_UNSAFE', 'backup package cannot be resolved', {
          storagePath: record.storagePath,
          error: errorMessage(error),
        })
      }
      if (packageReal === backupsRootReal || !isInsideOrEqual(packageReal, backupsRootReal)) {
        throw new PrecheckFailure(
          'BACKUP_PATH_UNSAFE',
          'backup package realpath escapes backupsRoot',
          {
            storagePath: record.storagePath,
            packageReal,
            backupsRootReal,
          },
        )
      }
      assertNoSymlinkComponents(
        backupsRootReal,
        packageRelative,
        'BACKUP_PATH_UNSAFE',
        'backup package',
      )

      const manifestPath = path.join(packageReal, MANIFEST_FILE)
      try {
        const stat = fs.lstatSync(manifestPath)
        if (!stat.isFile()) {
          throw new PrecheckFailure('MANIFEST_INVALID', 'manifest is not a regular file')
        }
      } catch (error) {
        if (error instanceof PrecheckFailure) throw error
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest is missing or unreadable', {
          error: errorMessage(error),
        })
      }
      let manifestFd: number
      try {
        manifestFd = fs.openSync(manifestPath, SAFE_READ_FLAGS)
      } catch (error) {
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest is missing or unreadable', {
          error: errorMessage(error),
        })
      }
      let manifestRaw: unknown
      try {
        manifestRaw = JSON.parse(fs.readFileSync(manifestFd).toString('utf8'))
      } catch (error) {
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest is not valid JSON', {
          error: errorMessage(error),
        })
      } finally {
        try {
          fs.closeSync(manifestFd)
        } catch {
          // 关闭失败不掩盖 manifest 解析错误。
        }
      }

      const parsedManifest = BackupManifestSchema.safeParse(manifestRaw)
      if (!parsedManifest.success) {
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest failed schema validation', {
          issues: parsedManifest.error.issues,
        })
      }
      const manifest = parsedManifest.data
      partial = {
        ...partial,
        manifestVersion: manifest.manifestVersion,
        artifactCount: manifest.artifacts.length,
      }
      if (manifest.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
        throw new PrecheckFailure(
          'MANIFEST_INVALID',
          `unsupported manifestVersion ${manifest.manifestVersion}`,
          { supported: SUPPORTED_MANIFEST_VERSION },
        )
      }
      if (manifest.type !== record.type) {
        throw new PrecheckFailure(
          'MANIFEST_INVALID',
          `manifest type ${manifest.type} does not match backup record ${record.type}`,
        )
      }
      if (
        manifest.counts.artifacts !== manifest.artifacts.length ||
        manifest.counts.files !== manifest.artifacts.length
      ) {
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest counts do not match artifacts', {
          counts: manifest.counts,
          artifacts: manifest.artifacts.length,
        })
      }
      const manifestPaths = manifest.artifacts.map((artifact) => artifact.path)
      if (new Set(manifestPaths).size !== manifestPaths.length) {
        throw new PrecheckFailure('MANIFEST_INVALID', 'manifest contains duplicate artifact paths')
      }
      // 先做纯语法校验，确保路径穿越在进入 manifest↔DB 映射前就以
      // ARTIFACT_PATH_UNSAFE 拒绝，而不是被误分类为映射不一致。
      for (const manifestPath of manifestPaths) {
        if (!safeArtifactRelativePath(manifestPath)) {
          throw new PrecheckFailure('ARTIFACT_PATH_UNSAFE', 'artifact path is unsafe', {
            path: manifestPath,
          })
        }
      }

      const databasePath = path.join(packageReal, DATABASE_FILE)
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-restore-precheck-'))
      let probe: DatabaseSync | null = null
      let databaseFd: number | null = null
      try {
        const tempDatabase = path.join(tempDir, DATABASE_FILE)
        try {
          const stat = fs.lstatSync(databasePath)
          if (!stat.isFile()) {
            throw new PrecheckFailure('DATABASE_MISSING', 'backup database is not a regular file')
          }
        } catch (error) {
          if (error instanceof PrecheckFailure) throw error
          throw new PrecheckFailure(
            'DATABASE_MISSING',
            'backup database is missing or unreadable',
            {
              error: errorMessage(error),
            },
          )
        }
        try {
          databaseFd = fs.openSync(databasePath, SAFE_READ_FLAGS)
        } catch (error) {
          throw new PrecheckFailure(
            'DATABASE_MISSING',
            'backup database is missing or unreadable',
            {
              error: errorMessage(error),
            },
          )
        }

        let databaseCopy: { size: number; sha256: string }
        try {
          databaseCopy = copyAndHashFd(databaseFd, tempDatabase)
        } catch (error) {
          throw new PrecheckFailure('PRECHECK_INTERNAL', 'failed to copy backup database', {
            error: errorMessage(error),
          })
        } finally {
          try {
            fs.closeSync(databaseFd)
          } catch {
            // 关闭失败不掩盖复制/哈希错误。
          }
          databaseFd = null
        }
        if (databaseCopy.size !== manifest.database.bytes) {
          throw new PrecheckFailure('DATABASE_SIZE_MISMATCH', 'backup database size mismatch', {
            expected: manifest.database.bytes,
            actual: databaseCopy.size,
          })
        }
        if (databaseCopy.sha256 !== manifest.database.sha256) {
          throw new PrecheckFailure('DATABASE_SHA256_MISMATCH', 'backup database sha256 mismatch', {
            expected: manifest.database.sha256,
            actual: databaseCopy.sha256,
          })
        }

        try {
          probe = new DatabaseSync(tempDatabase, { readOnly: true })
        } catch (error) {
          throw new PrecheckFailure(
            'DATABASE_INTEGRITY_FAILED',
            'backup database cannot be opened',
            {
              error: errorMessage(error),
            },
          )
        }

        let integrityRows: { integrity_check?: string }[]
        try {
          integrityRows = probe.prepare('PRAGMA integrity_check').all() as {
            integrity_check?: string
          }[]
        } catch (error) {
          throw new PrecheckFailure(
            'DATABASE_INTEGRITY_FAILED',
            'backup database integrity_check could not be executed',
            { error: errorMessage(error) },
          )
        }
        if (integrityRows[0]?.integrity_check !== 'ok') {
          partial = {
            ...partial,
            database: {
              file: DATABASE_FILE,
              bytes: manifest.database.bytes,
              sha256: manifest.database.sha256,
              integrityCheck: 'failed',
              userVersion: 0,
            },
          }
          throw new PrecheckFailure(
            'DATABASE_INTEGRITY_FAILED',
            'backup database integrity_check failed',
            {
              rows: integrityRows.slice(0, 5),
            },
          )
        }

        let userVersion: number
        try {
          const row = probe.prepare('PRAGMA user_version').get() as {
            user_version?: unknown
          }
          const value = row?.user_version
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
            throw new PrecheckFailure('SCHEMA_VERSION_INVALID', 'invalid backup user_version', {
              value,
            })
          }
          userVersion = value
        } catch (error) {
          if (error instanceof PrecheckFailure) throw error
          throw new PrecheckFailure('SCHEMA_VERSION_INVALID', 'cannot read backup user_version', {
            error: errorMessage(error),
          })
        }

        const database: NonNullable<BackupRestorePrecheckResult['database']> = {
          file: DATABASE_FILE,
          bytes: manifest.database.bytes,
          sha256: manifest.database.sha256,
          integrityCheck: 'ok' as const,
          userVersion,
        }
        const schemaCompatibility = {
          backupUserVersion: userVersion,
          currentUserVersion: this.currentUserVersion,
          compatible: userVersion <= this.currentUserVersion,
        }
        partial = { ...partial, database, schemaCompatibility }
        if (!schemaCompatibility.compatible) {
          throw new PrecheckFailure(
            'SCHEMA_VERSION_UNSUPPORTED',
            `backup schema version ${userVersion} is newer than supported ${this.currentUserVersion}`,
            { backupUserVersion: userVersion, currentUserVersion: this.currentUserVersion },
          )
        }

        let storageRows: { storage_path?: unknown }[]
        try {
          storageRows = probe.prepare('SELECT storage_path FROM artifact_versions').all() as {
            storage_path?: unknown
          }[]
        } catch (error) {
          throw new PrecheckFailure(
            'DATABASE_SCHEMA_INVALID',
            'artifact_versions table is missing or unreadable',
            { error: errorMessage(error) },
          )
        }
        const storagePaths: string[] = []
        for (const row of storageRows) {
          if (
            typeof row !== 'object' ||
            row === null ||
            typeof (row as { storage_path?: unknown }).storage_path !== 'string'
          ) {
            throw new PrecheckFailure(
              'DATABASE_SCHEMA_INVALID',
              'artifact_versions.storage_path is invalid',
              { row },
            )
          }
          storagePaths.push((row as { storage_path: string }).storage_path)
        }

        const configuredArtifactsRoot = path.resolve(this.artifactsRoot)
        const artifactsRootReal = resolveExistingDir(
          configuredArtifactsRoot,
          'ARTIFACTS_ROOT_UNAVAILABLE',
          'artifactsRoot',
        )
        const mappedStoragePaths: string[] = []
        for (const storagePath of storagePaths) {
          if (!path.isAbsolute(storagePath)) {
            throw new PrecheckFailure(
              'STORAGE_PATH_INCOMPATIBLE',
              'artifact storage_path is not an absolute path',
              { storagePath },
            )
          }
          const lexical = path.resolve(storagePath)
          const relative = path.relative(configuredArtifactsRoot, lexical)
          if (
            relative === '' ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new PrecheckFailure(
              'STORAGE_PATH_INCOMPATIBLE',
              'artifact storage_path is outside current artifactsRoot',
              { storagePath, artifactsRoot: configuredArtifactsRoot },
            )
          }
          assertNoSymlinkComponents(
            artifactsRootReal,
            relative,
            'STORAGE_PATH_INCOMPATIBLE',
            'artifact storage path',
          )
          const real = realpathAllowMissing(
            lexical,
            'STORAGE_PATH_INCOMPATIBLE',
            'artifact storage path',
          )
          if (real === artifactsRootReal || !isInsideOrEqual(real, artifactsRootReal)) {
            throw new PrecheckFailure(
              'STORAGE_PATH_INCOMPATIBLE',
              'artifact storage_path realpath escapes artifactsRoot',
              { storagePath, artifactsRootReal },
            )
          }
          const mapped = path.relative(artifactsRootReal, real).split(path.sep).join('/')
          if (mapped === '') {
            throw new PrecheckFailure(
              'STORAGE_PATH_INCOMPATIBLE',
              'artifact storage_path maps to artifactsRoot itself',
              { storagePath },
            )
          }
          mappedStoragePaths.push(mapped)
        }
        if (new Set(mappedStoragePaths).size !== mappedStoragePaths.length) {
          throw new PrecheckFailure(
            'DATABASE_SCHEMA_INVALID',
            'database contains duplicate artifact storage paths',
          )
        }
        const manifestPathSet = new Set(manifestPaths)
        const databasePathSet = new Set(mappedStoragePaths)
        const missing = manifestPaths.filter((item) => !databasePathSet.has(item))
        const extra = mappedStoragePaths.filter((item) => !manifestPathSet.has(item))
        if (missing.length > 0 || extra.length > 0) {
          throw new PrecheckFailure(
            'ARTIFACT_MAPPING_MISMATCH',
            'manifest artifacts do not match database artifact records',
            { missing, extra },
          )
        }

        if (manifest.artifacts.length > 0) {
          const artifactsDir = path.join(packageReal, ARTIFACTS_DIR)
          let artifactsDirStat: fs.Stats
          try {
            artifactsDirStat = fs.lstatSync(artifactsDir)
          } catch (error) {
            throw new PrecheckFailure('ARTIFACT_PATH_UNSAFE', 'artifacts directory unavailable', {
              error: errorMessage(error),
            })
          }
          if (artifactsDirStat.isSymbolicLink() || !artifactsDirStat.isDirectory()) {
            throw new PrecheckFailure(
              'ARTIFACT_PATH_UNSAFE',
              'artifacts root is not a real directory',
            )
          }
          let artifactsDirReal: string
          try {
            artifactsDirReal = fs.realpathSync(artifactsDir)
          } catch (error) {
            throw new PrecheckFailure('ARTIFACT_PATH_UNSAFE', 'artifacts root cannot be resolved', {
              error: errorMessage(error),
            })
          }
          if (!isInsideOrEqual(artifactsDirReal, packageReal) || artifactsDirReal === packageReal) {
            throw new PrecheckFailure(
              'ARTIFACT_PATH_UNSAFE',
              'artifacts root escapes backup package',
            )
          }

          for (const artifact of manifest.artifacts) {
            const parts = safeArtifactRelativePath(artifact.path)
            if (!parts) {
              throw new PrecheckFailure('ARTIFACT_PATH_UNSAFE', 'artifact path is unsafe', {
                path: artifact.path,
              })
            }
            const relative = parts.join(path.sep)
            assertNoSymlinkComponents(
              artifactsDirReal,
              relative,
              'ARTIFACT_PATH_UNSAFE',
              'artifact',
            )
            const full = path.join(artifactsDirReal, relative)
            const real = realpathAllowMissing(full, 'ARTIFACT_PATH_UNSAFE', 'artifact')
            if (real === artifactsDirReal || !isInsideOrEqual(real, artifactsDirReal)) {
              throw new PrecheckFailure(
                'ARTIFACT_PATH_UNSAFE',
                'artifact realpath escapes artifacts root',
                {
                  path: artifact.path,
                },
              )
            }

            try {
              const stat = fs.lstatSync(real)
              if (!stat.isFile()) {
                throw new PrecheckFailure('ARTIFACT_MISSING', 'artifact is not a regular file', {
                  path: artifact.path,
                })
              }
            } catch (error) {
              if (error instanceof PrecheckFailure) throw error
              throw new PrecheckFailure('ARTIFACT_MISSING', 'artifact file missing', {
                path: artifact.path,
                error: errorMessage(error),
              })
            }

            let fd: number
            try {
              fd = fs.openSync(real, SAFE_READ_FLAGS)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
                throw new PrecheckFailure('ARTIFACT_PATH_UNSAFE', 'artifact is a symlink', {
                  path: artifact.path,
                })
              }
              throw new PrecheckFailure('ARTIFACT_MISSING', 'artifact file missing', {
                path: artifact.path,
                error: errorMessage(error),
              })
            }
            try {
              const stat = fs.fstatSync(fd)
              if (!stat.isFile()) {
                throw new PrecheckFailure('ARTIFACT_MISSING', 'artifact is not a regular file', {
                  path: artifact.path,
                })
              }
              const digest = hashFd(fd)
              if (digest.size !== artifact.bytes) {
                throw new PrecheckFailure('ARTIFACT_SIZE_MISMATCH', 'artifact size mismatch', {
                  path: artifact.path,
                  expected: artifact.bytes,
                  actual: digest.size,
                })
              }
              if (digest.sha256 !== artifact.sha256) {
                throw new PrecheckFailure('ARTIFACT_SHA256_MISMATCH', 'artifact sha256 mismatch', {
                  path: artifact.path,
                  expected: artifact.sha256,
                  actual: digest.sha256,
                })
              }
            } finally {
              try {
                fs.closeSync(fd)
              } catch {
                // 关闭失败不掩盖哈希/大小错误。
              }
            }
          }
        }

        return { ...partial, allowedToRestore: true, failure: null }
      } finally {
        if (databaseFd !== null) {
          try {
            fs.closeSync(databaseFd)
          } catch {
            // 关闭失败不掩盖原始错误。
          }
        }
        try {
          probe?.close()
        } catch {
          // 关闭失败不掩盖预检结果；临时目录仍会清理。
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (error instanceof PrecheckFailure) {
        return fail(partial, error.code, error.message, error.detail)
      }
      return fail(partial, 'PRECHECK_INTERNAL', `backup ${backupId} precheck failed`, {
        error: errorMessage(error),
      })
    }
  }
}
