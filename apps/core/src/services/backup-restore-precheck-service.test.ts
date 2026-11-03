import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { MIGRATIONS, migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BackupRepository } from '../db/repositories/backup-repository'
import { ArtifactService } from './artifact-service'
import { BackupRestorePrecheckService } from './backup-restore-precheck-service'
import { BackupService } from './backup-service'

const NOW = '2026-11-02T00:00:00.000Z'
const CURRENT_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version))
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type RawManifest = {
  manifestVersion: number
  type: string
  database: { file: string; sha256: string; bytes: number }
  artifacts: { path: string; sha256: string; bytes: number }[]
  counts: { artifacts: number; files: number }
}

type Harness = {
  dir: string
  db: Database
  backups: BackupRepository
  service: BackupRestorePrecheckService
  backupId: string
  packageDir: string
  manifestPath: string
  databasePath: string
  artifactPath: string
  artifactsRoot: string
  backupsRoot: string
  close: () => void
}

function createHarness(withArtifact: boolean): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-precheck-test-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)

  const artifactsRoot = path.join(dir, 'artifacts')
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 })
  const backupsRoot = path.join(dir, 'backups')
  const artifactRepo = new ArtifactRepository(db)
  const audit = new AuditRepository(db)
  const backups = new BackupRepository(db)
  const artifactService = new ArtifactService(
    db,
    artifactRepo,
    artifactsRoot,
    { get: () => ({ id: 'work-1', status: 'active' }) },
    () => NOW,
  )
  if (withArtifact) {
    artifactService.createVersion({
      workId: 'work-1',
      artifactType: 'markdown',
      name: 'PRD',
      content: '# hello',
      createdByType: 'agent',
    })
  }

  const backup = new BackupService(
    db,
    backups,
    artifactRepo,
    audit,
    backupsRoot,
    artifactsRoot,
    () => NOW,
  ).create()
  const packageDir = path.join(backupsRoot, backup.id)
  const manifestPath = path.join(packageDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawManifest
  const databasePath = path.join(packageDir, 'database.db')
  const firstArtifact = manifest.artifacts[0]
  const artifactPath = firstArtifact ? path.join(packageDir, 'artifacts', firstArtifact.path) : ''
  const service = new BackupRestorePrecheckService(
    backups,
    backupsRoot,
    artifactsRoot,
    CURRENT_VERSION,
  )

  return {
    dir,
    db,
    backups,
    service,
    backupId: backup.id,
    packageDir,
    manifestPath,
    databasePath,
    artifactPath,
    artifactsRoot,
    backupsRoot,
    close: () => db.close(),
  }
}

function setup(): Harness {
  return createHarness(true)
}

function setupEmpty(): Harness {
  return createHarness(false)
}

function readManifest(h: Harness): RawManifest {
  return JSON.parse(fs.readFileSync(h.manifestPath, 'utf8')) as RawManifest
}

function writeManifest(h: Harness, manifest: RawManifest): void {
  fs.writeFileSync(h.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function refreshManifestDatabase(h: Harness): void {
  const bytes = fs.readFileSync(h.databasePath)
  const manifest = readManifest(h)
  manifest.database.sha256 = createHash('sha256').update(bytes).digest('hex')
  manifest.database.bytes = bytes.length
  writeManifest(h, manifest)
}

function finishDatabaseMutation(h: Harness): void {
  fs.rmSync(`${h.databasePath}-wal`, { force: true })
  fs.rmSync(`${h.databasePath}-shm`, { force: true })
  refreshManifestDatabase(h)
}

function withBackupDb<T>(h: Harness, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(h.databasePath)
  try {
    return action(db)
  } finally {
    db.close()
  }
}

function setUserVersion(h: Harness, version: number): void {
  withBackupDb(h, (db) => {
    db.exec(`PRAGMA user_version = ${version}`)
  })
  finishDatabaseMutation(h)
}

function rewriteStoragePaths(h: Harness, transform: (oldPath: string) => string): void {
  withBackupDb(h, (db) => {
    // 备份库中的 artifact_versions 带不可变触发器；这里模拟“被篡改/旧版本”的备份库，
    // 先移除触发器再改写 storage_path，以覆盖预检的防御性校验。
    db.exec('DROP TRIGGER IF EXISTS trg_artifact_versions_immutable')
    const rows = db.prepare('SELECT id, storage_path FROM artifact_versions').all() as {
      id: string
      storage_path: string
    }[]
    const update = db.prepare('UPDATE artifact_versions SET storage_path = ? WHERE id = ?')
    for (const row of rows) update.run(transform(row.storage_path), row.id)
  })
  finishDatabaseMutation(h)
}

function insertDuplicateArtifactVersion(h: Harness): void {
  withBackupDb(h, (db) => {
    const row = db.prepare('SELECT storage_path FROM artifact_versions LIMIT 1').get() as
      | { storage_path: string }
      | undefined
    if (!row) throw new Error('expected an artifact version')
    db.prepare(
      `INSERT INTO artifacts
         (id, work_id, node_run_id, assignment_id, artifact_type, name, description,
          storage_path, mime_type, created_by_type, created_by_id, created_at)
       VALUES ('art-dup', 'work-1', NULL, NULL, 'markdown', 'Duplicate', '', ?, NULL, 'agent', NULL, ?)`,
    ).run(row.storage_path, NOW)
    db.prepare(
      `INSERT INTO artifact_versions
         (id, artifact_id, version, storage_path, checksum, metadata_json, created_at)
       VALUES ('av-dup', 'art-dup', 1, ?, 'checksum', '{}', ?)`,
    ).run(row.storage_path, NOW)
  })
  finishDatabaseMutation(h)
}

function flipByte(file: string): void {
  const bytes = fs.readFileSync(file)
  const index = Math.floor(bytes.length / 2)
  const current = bytes[index]
  if (current === undefined) throw new Error(`cannot flip empty file: ${file}`)
  bytes[index] = current ^ 0xff
  fs.writeFileSync(file, bytes)
}

function moveAndSymlink(source: string, target: string): void {
  fs.renameSync(source, target)
  fs.symlinkSync(target, source)
}

function snapshotPackage(h: Harness): {
  manifest: string
  database: string
  artifact: string | null
  files: string[]
  status: string | null
} {
  return {
    manifest: hashFile(h.manifestPath),
    database: hashFile(h.databasePath),
    artifact: h.artifactPath ? hashFile(h.artifactPath) : null,
    files: fs.readdirSync(h.packageDir).sort(),
    status: h.backups.get(h.backupId)?.status ?? null,
  }
}

function precheckTempDirs(): Set<string> {
  return new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('agentra-restore-precheck-')),
  )
}

function expectNoNewTempDirs(before: Set<string>): void {
  const added = [...precheckTempDirs()].filter((name) => !before.has(name))
  expect(added).toEqual([])
}

describe('BackupRestorePrecheckService · S55-2A', () => {
  it('passes a valid backup with manifest, database, artifacts and schema checks', () => {
    const h = setup()
    try {
      const result = h.service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(true)
      expect(result.failure).toBeNull()
      expect(result.type).toBe('manual')
      expect(result.manifestVersion).toBe(1)
      expect(result.artifactCount).toBe(1)
      expect(result.database).toMatchObject({
        file: 'database.db',
        integrityCheck: 'ok',
        userVersion: CURRENT_VERSION,
      })
      expect(result.schemaCompatibility).toEqual({
        backupUserVersion: CURRENT_VERSION,
        currentUserVersion: CURRENT_VERSION,
        compatible: true,
      })
    } finally {
      h.close()
    }
  })

  it('passes a backup with no artifacts', () => {
    const h = setupEmpty()
    try {
      const result = h.service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(true)
      expect(result.artifactCount).toBe(0)
    } finally {
      h.close()
    }
  })

  it('rejects a manifest that is not valid JSON', () => {
    const h = setup()
    try {
      fs.writeFileSync(h.manifestPath, 'not-json', { mode: 0o600 })
      const result = h.service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(false)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects a manifest missing a required field', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      delete (manifest.database as unknown as Record<string, unknown>).sha256
      writeManifest(h, manifest)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects an unsupported manifestVersion', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      manifest.manifestVersion = 2
      writeManifest(h, manifest)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects manifest counts that do not match artifacts', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      manifest.counts.artifacts = 2
      writeManifest(h, manifest)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects duplicate artifact paths in the manifest', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      const first = manifest.artifacts[0]
      if (!first) throw new Error('expected one artifact in manifest')
      manifest.artifacts.push({ ...first })
      manifest.counts = { artifacts: 2, files: 2 }
      writeManifest(h, manifest)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked manifest file', () => {
    const h = setup()
    try {
      moveAndSymlink(h.manifestPath, path.join(h.dir, 'manifest-outside.json'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('MANIFEST_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects a missing database file', () => {
    const h = setup()
    try {
      fs.rmSync(h.databasePath)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_MISSING')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked database file', () => {
    const h = setup()
    try {
      moveAndSymlink(h.databasePath, path.join(h.dir, 'database-outside.db'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_MISSING')
    } finally {
      h.close()
    }
  })

  it('rejects a database size mismatch', () => {
    const h = setup()
    try {
      fs.appendFileSync(h.databasePath, Buffer.from([0x00]))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_SIZE_MISMATCH')
    } finally {
      h.close()
    }
  })

  it('rejects a database sha256 mismatch', () => {
    const h = setup()
    try {
      flipByte(h.databasePath)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_SHA256_MISMATCH')
    } finally {
      h.close()
    }
  })

  it('rejects a database that fails integrity_check', () => {
    const h = setup()
    try {
      const size = fs.statSync(h.databasePath).size
      fs.writeFileSync(h.databasePath, Buffer.alloc(size, 0x41))
      refreshManifestDatabase(h)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_INTEGRITY_FAILED')
    } finally {
      h.close()
    }
  })

  it('rejects a missing artifact file', () => {
    const h = setup()
    try {
      fs.rmSync(h.artifactPath)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_MISSING')
    } finally {
      h.close()
    }
  })

  it('rejects an artifact size mismatch', () => {
    const h = setup()
    try {
      fs.appendFileSync(h.artifactPath, Buffer.from('x'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_SIZE_MISMATCH')
    } finally {
      h.close()
    }
  })

  it('rejects an artifact sha256 mismatch', () => {
    const h = setup()
    try {
      flipByte(h.artifactPath)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_SHA256_MISMATCH')
    } finally {
      h.close()
    }
  })

  it('rejects artifact path traversal', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      const firstArtifact = manifest.artifacts[0]
      if (!firstArtifact) throw new Error('expected one artifact in manifest')
      firstArtifact.path = '../escape'
      writeManifest(h, manifest)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_PATH_UNSAFE')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked artifact file', () => {
    const h = setup()
    try {
      moveAndSymlink(h.artifactPath, path.join(h.dir, 'artifact-outside'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_PATH_UNSAFE')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked artifact parent directory', () => {
    const h = setup()
    try {
      const manifest = readManifest(h)
      const firstArtifact = manifest.artifacts[0]
      if (!firstArtifact) throw new Error('expected one artifact in manifest')
      const parts = firstArtifact.path.split('/')
      const parent = path.join(h.packageDir, 'artifacts', ...parts.slice(0, -1))
      moveAndSymlink(parent, path.join(h.dir, 'artifact-parent-outside'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_PATH_UNSAFE')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked backup package directory', () => {
    const h = setup()
    try {
      moveAndSymlink(h.packageDir, path.join(h.dir, 'package-outside'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('BACKUP_PATH_UNSAFE')
    } finally {
      h.close()
    }
  })

  it('rejects a symlinked artifacts directory inside the package', () => {
    const h = setup()
    try {
      moveAndSymlink(path.join(h.packageDir, 'artifacts'), path.join(h.dir, 'artifacts-outside'))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_PATH_UNSAFE')
    } finally {
      h.close()
    }
  })

  it('rejects a schema version newer than current code', () => {
    const h = setup()
    try {
      setUserVersion(h, CURRENT_VERSION + 1)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('SCHEMA_VERSION_UNSUPPORTED')
      expect(result.schemaCompatibility?.compatible).toBe(false)
    } finally {
      h.close()
    }
  })

  it('rejects an invalid negative user_version', () => {
    const h = setup()
    try {
      setUserVersion(h, -1)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('SCHEMA_VERSION_INVALID')
    } finally {
      h.close()
    }
  })

  it('allows a schema version older than current code (migration later)', () => {
    const h = setup()
    try {
      setUserVersion(h, 1)
      const result = h.service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(true)
      expect(result.schemaCompatibility).toMatchObject({
        backupUserVersion: 1,
        currentUserVersion: CURRENT_VERSION,
        compatible: true,
      })
    } finally {
      h.close()
    }
  })

  it('rejects artifact storage paths outside the current artifactsRoot', () => {
    const h = setup()
    try {
      const otherRoot = path.join(h.dir, 'other-artifacts')
      fs.mkdirSync(otherRoot, { recursive: true, mode: 0o700 })
      const service = new BackupRestorePrecheckService(
        h.backups,
        h.backupsRoot,
        otherRoot,
        CURRENT_VERSION,
      )
      const result = service.precheck(h.backupId)
      expect(result.failure?.code).toBe('STORAGE_PATH_INCOMPATIBLE')
    } finally {
      h.close()
    }
  })

  it('rejects a storage_path whose parent directory is a symlink', () => {
    const h = setup()
    try {
      const target = path.join(h.dir, 'storage-target')
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(target, 'PRD'), '# hello')
      const link = path.join(h.artifactsRoot, 'link')
      fs.symlinkSync(target, link)
      rewriteStoragePaths(h, (oldPath) => path.join(link, path.basename(oldPath)))
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('STORAGE_PATH_INCOMPATIBLE')
    } finally {
      h.close()
    }
  })

  it('accepts an artifactsRoot symlink after resolving it to a real directory', () => {
    const h = setup()
    try {
      const linkRoot = path.join(h.dir, 'artifacts-link')
      fs.symlinkSync(h.artifactsRoot, linkRoot)
      rewriteStoragePaths(h, (oldPath) =>
        path.join(linkRoot, path.relative(h.artifactsRoot, oldPath)),
      )
      const service = new BackupRestorePrecheckService(
        h.backups,
        h.backupsRoot,
        linkRoot,
        CURRENT_VERSION,
      )
      const result = service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(true)
    } finally {
      h.close()
    }
  })

  it('rejects a database artifact path set that differs from the manifest', () => {
    const h = setup()
    try {
      rewriteStoragePaths(h, (oldPath) =>
        path.join(h.artifactsRoot, 'work-1', 'other-artifact', 'v1', path.basename(oldPath)),
      )
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_MAPPING_MISMATCH')
    } finally {
      h.close()
    }
  })

  it('rejects duplicate artifact storage paths in the database', () => {
    const h = setup()
    try {
      insertDuplicateArtifactVersion(h)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_SCHEMA_INVALID')
    } finally {
      h.close()
    }
  })

  it('rejects a database without the artifact_versions table', () => {
    const h = setup()
    try {
      withBackupDb(h, (db) => {
        db.exec('DROP TABLE artifact_versions')
      })
      finishDatabaseMutation(h)
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('DATABASE_SCHEMA_INVALID')
    } finally {
      h.close()
    }
  })

  it('reports BACKUP_NOT_FOUND for an unknown backupId', () => {
    const h = setup()
    try {
      const result = h.service.precheck('bak-does-not-exist')
      expect(result.allowedToRestore).toBe(false)
      expect(result.failure?.code).toBe('BACKUP_NOT_FOUND')
    } finally {
      h.close()
    }
  })

  it('reports BACKUPS_ROOT_UNAVAILABLE when the backups root is missing', () => {
    const h = setup()
    try {
      const service = new BackupRestorePrecheckService(
        h.backups,
        path.join(h.dir, 'missing-backups'),
        h.artifactsRoot,
        CURRENT_VERSION,
      )
      const result = service.precheck(h.backupId)
      expect(result.failure?.code).toBe('BACKUPS_ROOT_UNAVAILABLE')
    } finally {
      h.close()
    }
  })

  it('reports ARTIFACTS_ROOT_UNAVAILABLE when the artifacts root is missing', () => {
    const h = setup()
    try {
      const service = new BackupRestorePrecheckService(
        h.backups,
        h.backupsRoot,
        path.join(h.dir, 'missing-artifacts'),
        CURRENT_VERSION,
      )
      const result = service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACTS_ROOT_UNAVAILABLE')
    } finally {
      h.close()
    }
  })

  it('is read-only: no package files or backup status are modified', () => {
    const h = setup()
    try {
      const before = snapshotPackage(h)
      const tempBefore = precheckTempDirs()
      const result = h.service.precheck(h.backupId)
      expect(result.allowedToRestore).toBe(true)
      expect(snapshotPackage(h)).toEqual(before)
      expectNoNewTempDirs(tempBefore)
    } finally {
      h.close()
    }
  })

  it('keeps the package read-only and removes temp data on a failure path', () => {
    const h = setup()
    try {
      flipByte(h.artifactPath)
      const before = snapshotPackage(h)
      const tempBefore = precheckTempDirs()
      const result = h.service.precheck(h.backupId)
      expect(result.failure?.code).toBe('ARTIFACT_SHA256_MISMATCH')
      expect(snapshotPackage(h)).toEqual(before)
      expectNoNewTempDirs(tempBefore)
    } finally {
      h.close()
    }
  })
})
