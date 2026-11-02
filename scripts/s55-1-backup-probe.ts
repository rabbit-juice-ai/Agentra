/**
 * S55-1 备份链探针：在隔离临时数据目录里真实创建一个备份包，
 * 打印 manifest、文件清单、integrity_check 与审计行，供 QA 复跑。
 *
 * 运行：pnpm exec tsx scripts/s55-1-backup-probe.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../apps/core/src/db/database'
import { migrate } from '../apps/core/src/db/migrations'
import { ArtifactRepository } from '../apps/core/src/db/repositories/artifact-repository'
import { AuditRepository } from '../apps/core/src/db/repositories/audit-repository'
import { BackupRepository } from '../apps/core/src/db/repositories/backup-repository'
import { ArtifactService } from '../apps/core/src/services/artifact-service'
import { BackupService } from '../apps/core/src/services/backup-service'

const NOW = '2026-11-02T00:00:00.000Z'

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-s55-1-probe-'))
  const db = openDatabase(path.join(dir, 'agentra.db'))
  try {
    migrate(db)
    db.prepare(
      `INSERT INTO works (id, name, description, objective, status, priority, root_path,
         repository_path, settings_json, created_at, updated_at, completed_at)
       VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
    ).run(NOW, NOW)
    const artifactsRoot = path.join(dir, 'artifacts')
    fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 })
    const artifactRepo = new ArtifactRepository(db)
    new ArtifactService(
      db,
      artifactRepo,
      artifactsRoot,
      {
        get: () => ({ id: 'work-1', status: 'active' }),
      },
      () => NOW,
    ).createVersion({
      workId: 'work-1',
      artifactType: 'markdown',
      name: 'PRD',
      content: '# probe',
      createdByType: 'agent',
    })

    const backupsRoot = path.join(dir, 'backups')
    const audit = new AuditRepository(db)
    const service = new BackupService(
      db,
      new BackupRepository(db),
      artifactRepo,
      audit,
      backupsRoot,
      artifactsRoot,
      () => NOW,
    )
    const backup = service.create()
    const pkg = path.join(backupsRoot, backup.id)
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'))
    const probe = new DatabaseSync(path.join(pkg, 'database.db'), { readOnly: true })
    const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    probe.close()
    const files = fs
      .readdirSync(pkg, { recursive: true })
      .map((entry) => String(entry))
      .sort()

    console.log(
      JSON.stringify(
        {
          backupId: backup.id,
          status: backup.status,
          dbSha256: backup.dbSha256,
          fileCount: backup.fileCount,
          integrity: integrity.integrity_check,
          manifestVersion: manifest.manifestVersion,
          artifacts: manifest.artifacts,
          packageFiles: files,
          auditRows: audit.listByAction('backup.created').length,
        },
        null,
        2,
      ),
    )
    console.log('S55_1_BACKUP_PROBE_PASS')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main()
