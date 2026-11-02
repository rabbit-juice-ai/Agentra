import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BackupRepository } from '../db/repositories/backup-repository'
import { ArtifactService } from './artifact-service'
import { BackupError, BackupService } from './backup-service'

const NOW = '2026-11-02T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function expectExportRejected(fn: () => unknown): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).code).toBe('EXPORT_PATH_INVALID')
    return
  }
  throw new Error('expected export to be rejected')
}

type Harness = {
  db: Database
  file: string
  dir: string
  service: BackupService
  artifacts: ArtifactRepository
  backupRepo: BackupRepository
  audit: AuditRepository
  artifactsRoot: string
  backupsRoot: string
  close: () => void
}

function setup(): Harness {
  let clock = Date.parse(NOW)
  const now = () => {
    clock += 1000
    return new Date(clock).toISOString()
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-backup-'))
  dirs.push(dir)
  const file = path.join(dir, 'agentra.db')
  const db = openDatabase(file)
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
  const backupRepo = new BackupRepository(db)
  const service = new BackupService(
    db,
    backupRepo,
    artifactRepo,
    audit,
    backupsRoot,
    artifactsRoot,
    now,
  )
  return {
    db,
    file,
    dir,
    service,
    artifacts: artifactRepo,
    backupRepo,
    audit,
    artifactsRoot,
    backupsRoot,
    close: () => db.close(),
  }
}

describe('BackupService · S55-1 备份链', () => {
  it('creates a verified package with manifest, sha256, integrity and artifact copies', () => {
    const h = setup()
    try {
      const artifact = new ArtifactService(
        h.db,
        h.artifacts,
        h.artifactsRoot,
        {
          get: () => ({ id: 'work-1', status: 'active' }),
        },
        () => NOW,
      ).createVersion({
        workId: 'work-1',
        artifactType: 'markdown',
        name: 'PRD',
        content: '# hello',
        createdByType: 'agent',
      })

      const backup = h.service.create()
      expect(backup.status).toBe('verified')
      expect(backup.dbSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(backup.fileCount).toBe(1)

      const pkg = path.join(h.backupsRoot, backup.id)
      expect(fs.existsSync(path.join(pkg, 'database.db'))).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({
        manifestVersion: 1,
        type: 'manual',
        database: { file: 'database.db' },
      })
      expect(manifest.database.sha256).toBe(backup.dbSha256)
      expect(manifest.artifacts).toHaveLength(1)
      expect(manifest.artifacts[0]).toMatchObject({
        path: expect.stringContaining('PRD'),
        bytes: '# hello'.length,
      })
      expect(manifest.counts.artifacts).toBe(manifest.artifacts.length)
      expect(manifest.counts.files).toBe(manifest.artifacts.length)
      // 备份包内的 artifact 内容与校验值一致
      const copiedBytes = fs.readFileSync(path.join(pkg, 'artifacts', manifest.artifacts[0].path))
      expect(copiedBytes.toString('utf8')).toBe('# hello')
      const copiedSha256 = createHash('sha256').update(copiedBytes).digest('hex')
      expect(manifest.artifacts[0].sha256).toBe(copiedSha256)
      expect(artifact.version.version).toBe(1)

      // 备份数据库完整性
      const probe = new DatabaseSync(path.join(pkg, 'database.db'), { readOnly: true })
      const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      probe.close()
      expect(integrity.integrity_check).toBe('ok')

      // 审计
      expect(h.audit.listByAction('backup.created')).toHaveLength(1)
      expect(h.audit.listByAction('backup.created')[0]?.targetId).toBe(backup.id)
    } finally {
      h.close()
    }
  })

  it('fails closed: a missing artifact file marks the backup failed, never completed', () => {
    const h = setup()
    try {
      const artifactService = new ArtifactService(
        h.db,
        h.artifacts,
        h.artifactsRoot,
        {
          get: () => ({ id: 'work-1', status: 'active' }),
        },
        () => NOW,
      )
      const created = artifactService.createVersion({
        workId: 'work-1',
        artifactType: 'text',
        name: 'spec',
        content: 'x',
        createdByType: 'system',
      })
      fs.rmSync(created.version.storagePath)

      expect(() => h.service.create()).toThrow(BackupError)
      const backups = h.service.list()
      expect(backups).toHaveLength(1)
      expect(backups[0]?.status).toBe('failed')
      expect(backups[0]?.error).toMatchObject({ message: expect.stringContaining('missing') })
      expect(backups[0]?.dbSha256).toBeNull()
      expect(h.audit.listByAction('backup.failed')).toHaveLength(1)
      // 失败备份不得呈现为 completed/verified
      expect(['completed', 'verified']).not.toContain(backups[0]?.status)
    } finally {
      h.close()
    }
  })

  it('snapshots a consistent WAL state while another process keeps writing (B2)', async () => {
    const h = setup()
    try {
      // 已提交数据必须进备份
      h.db
        .prepare(
          `INSERT INTO works (id, name, description, objective, status, priority, root_path,
           repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('work-committed', 'C', '', '', 'active', 'normal', '/tmp/c', NULL, '{}', ?, ?, NULL)`,
        )
        .run(NOW, NOW)

      // 真实并发写入：子进程持续 INSERT（WAL 读写并发），父进程同时做备份。
      const writerScript = path.join(h.dir, 'writer.cjs')
      fs.writeFileSync(
        writerScript,
        `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(${JSON.stringify(h.file)})
db.exec('PRAGMA busy_timeout = 5000')
let n = 0
const timer = setInterval(() => {
  db.prepare("INSERT INTO works (id, name, description, objective, status, priority, root_path, repository_path, settings_json, created_at, updated_at, completed_at) VALUES (?, 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)").run('work-writer-' + (++n), new Date().toISOString(), new Date().toISOString())
}, 5)
setTimeout(() => { clearInterval(timer); db.close(); process.exit(0) }, 1500)
`,
      )
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [writerScript], { stdio: 'ignore' })
      await new Promise((resolve) => setTimeout(resolve, 300))

      const backup = h.service.create()
      expect(backup.status).toBe('verified')

      await new Promise((resolve) => child.once('exit', resolve))

      // 备份内必须包含已提交数据，且 integrity ok；写入方在备份期间持续提交
      const probe = new DatabaseSync(path.join(h.backupsRoot, backup.id, 'database.db'), {
        readOnly: true,
      })
      const ids = (probe.prepare('SELECT id FROM works').all() as { id: string }[]).map(
        (row) => row.id,
      )
      const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      probe.close()
      expect(ids).toContain('work-1')
      expect(ids).toContain('work-committed')
      expect(integrity.integrity_check).toBe('ok')
      // 主库确实在备份期间收到了并发写入
      const writerRows = h.db
        .prepare("SELECT COUNT(*) AS c FROM works WHERE id LIKE 'work-writer-%'")
        .get() as { c: number }
      expect(writerRows.c).toBeGreaterThan(0)
    } finally {
      h.close()
    }
  })

  it('exports the package to a target directory and audits the export', () => {
    const h = setup()
    try {
      const backup = h.service.create()
      const targetDir = path.join(h.dir, 'export')
      const target = h.service.exportTo(backup.id, targetDir)
      expect(target).toBe(path.join(targetDir, backup.id))
      expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(true)
      expect(fs.existsSync(path.join(target, 'database.db'))).toBe(true)
      expect(h.audit.listByAction('backup.exported')).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('rejects export targets inside backupsRoot, including symlink targets', () => {
    const h = setup()
    try {
      const backup = h.service.create()
      const nested = path.join(h.backupsRoot, 'nested')
      const link = path.join(h.dir, 'link-to-backups')
      fs.symlinkSync(h.backupsRoot, link)
      expectExportRejected(() => h.service.exportTo(backup.id, h.backupsRoot))
      expectExportRejected(() => h.service.exportTo(backup.id, nested))
      expectExportRejected(() => h.service.exportTo(backup.id, link))
      expect(fs.existsSync(nested)).toBe(false)
    } finally {
      h.close()
    }
  })

  it('rejects export into the backup package or its subdirectories', () => {
    const h = setup()
    try {
      const backup = h.service.create()
      const pkg = path.join(h.backupsRoot, backup.id)
      expectExportRejected(() => h.service.exportTo(backup.id, pkg))
      expectExportRejected(() => h.service.exportTo(backup.id, path.join(pkg, 'sub')))
    } finally {
      h.close()
    }
  })

  it('lists backups newest first and reads the manifest for precheck', () => {
    const h = setup()
    try {
      const first = h.service.create()
      const second = h.service.create()
      const list = h.service.list()
      expect(list.map((backup) => backup.id)).toEqual([second.id, first.id])
      const manifest = h.service.readManifest(first.id)
      expect(manifest.type).toBe('manual')
      expect(manifest.counts.files).toBe(0)
    } finally {
      h.close()
    }
  })
})

describe('BackupRpcService · 协议封装', () => {
  it('maps create/list/export to DTOs and preserves failed status', async () => {
    const h = setup()
    try {
      const { BackupRpcService } = await import('./backup-rpc-service')
      const rpc = new BackupRpcService(h.service)
      const created = rpc.create()
      expect(created).toMatchObject({ type: 'manual', status: 'verified' })
      expect(rpc.list().map((backup) => backup.id)).toEqual([created.id])
      const target = rpc.exportTo(created.id, path.join(h.dir, 'rpc-export'))
      expect(target).toContain(created.id)
    } finally {
      h.close()
    }
  })
})
