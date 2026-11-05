import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon/daemon-client'
import { openDatabase } from '../db/database'
import { MIGRATIONS, migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BackupRepository } from '../db/repositories/backup-repository'
import { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { MaintenanceController } from '../lifecycle/maintenance-controller'
import { PersistenceGate } from '../lifecycle/persistence-gate'
import {
  type RestoreJournalPaths,
  RestoreJournalSchema,
  RestoreJournalStore,
} from '../lifecycle/restore-journal'
import { BackupRestorePrecheckService } from './backup-restore-precheck-service'
import { BackupService } from './backup-service'
import { RestoreCoordinator } from './restore-coordinator'

const dirs: string[] = []
const openDbs: Array<{ close(): void }> = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // 测试清理失败不掩盖断言结果。
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Harness = {
  paths: ReturnType<typeof agentraPaths>
  store: RestoreJournalStore
  coordinator: RestoreCoordinator
  maintenance: MaintenanceController
  persistence: PersistenceGate
  drain: DrainCoordinator
  runtime: {
    pauseIngress: ReturnType<typeof vi.fn>
    resumeIngress: ReturnType<typeof vi.fn>
    isIngressPaused: ReturnType<typeof vi.fn>
  }
  shutdown: ReturnType<typeof vi.fn>
  backupId: string
  errors: string[]
}

function setup(options: { ingressStable?: boolean; drainDeadlineMs?: number } = {}): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a-rst-'))
  dirs.push(home)
  const paths = agentraPaths(home)
  ensureDirs(paths)

  const db = openDatabase(paths.database)
  openDbs.push(db)
  migrate(db)

  const backupRepository = new BackupRepository(db)
  const backupService = new BackupService(
    db,
    backupRepository,
    new ArtifactRepository(db),
    new AuditRepository(db),
    paths.backups,
    paths.artifacts,
  )
  const backup = backupService.create({ type: 'manual' })
  const precheck = new BackupRestorePrecheckService(
    backupRepository,
    paths.backups,
    paths.artifacts,
    Math.max(...MIGRATIONS.map((migration) => migration.version)),
  )

  const maintenance = new MaintenanceController()
  const drain = new DrainCoordinator()
  const persistence = new PersistenceGate(drain)
  const runtime = {
    pauseIngress: vi.fn(),
    resumeIngress: vi.fn(),
    isIngressPaused: vi.fn(() => options.ingressStable ?? true),
  }
  const shutdown = vi.fn()
  const errors: string[] = []
  const logger = {
    info: () => {},
    warn: () => {},
    error: (message: string, data?: Record<string, unknown>) => {
      errors.push(`${message}: ${String(data?.error ?? '')}`)
    },
  }

  const journalPaths: RestoreJournalPaths = {
    restoreRoot: paths.restore,
    journalA: paths.restoreJournalA,
    journalB: paths.restoreJournalB,
    activeMarker: paths.restoreActiveMarker,
    archiveRoot: paths.restoreArchive,
  }
  const store = new RestoreJournalStore(journalPaths)
  const coordinator = new RestoreCoordinator(
    journalPaths,
    paths.restoreRetired,
    db,
    maintenance,
    drain,
    persistence,
    runtime as unknown as DaemonClient,
    { listActive: () => [] },
    backupRepository,
    backupService,
    precheck,
    shutdown,
    logger,
    () => new Date().toISOString(),
    options.drainDeadlineMs ?? 5_000,
  )
  return {
    paths,
    store,
    coordinator,
    maintenance,
    persistence,
    drain,
    runtime,
    shutdown,
    backupId: backup.id,
    errors,
  }
}

describe('RestoreCoordinator old-Core orchestration', () => {
  it('drains, creates pre_restore, checkpoints and hands off', async () => {
    const h = setup()
    const accepted = h.coordinator.request(h.backupId)
    expect(accepted.state).toBe('requested')
    expect(accepted.journalId).toMatch(/^rst-/)

    await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalledWith('RESTORE_HANDOFF'), {
      timeout: 12_000,
    })
    expect(h.errors).toEqual([])

    const loaded = h.store.loadActive({ validateScene: () => true })
    expect(loaded).not.toBeNull()
    const journal = loaded?.journal
    expect(journal?.phase).toBe('handed_off')
    expect(journal?.steps.preRestoreVerified).toBe(true)
    expect(journal?.steps.drained).toBe(true)
    expect(journal?.steps.ingressPaused).toBe(true)
    expect(journal?.steps.checkpointed).toBe(true)
    expect(journal?.steps.handedOff).toBe(true)
    expect(journal?.preRestoreBackupId).not.toBeNull()
    expect(journal?.checkpointEvidence).toMatchObject({ busy: 0 })
    expect(h.runtime.pauseIngress).toHaveBeenCalledTimes(1)
    expect(h.maintenance.state).toBe('entering_maintenance')
  }, 20_000)

  it('aborts before replacement, archives the terminal snapshot and reopens business', async () => {
    const h = setup({ ingressStable: false })
    h.coordinator.request(h.backupId)

    await vi.waitFor(() => expect(h.runtime.resumeIngress).toHaveBeenCalledTimes(1), {
      timeout: 12_000,
    })
    expect(h.maintenance.state).toBe('normal')

    expect(h.shutdown).not.toHaveBeenCalled()
    expect(h.persistence.state).toBe('open')
    expect(h.coordinator.status()).toBeNull()

    // 终态收尾：marker 删除、active Journal 退役、正式 Archive 已 verified。
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(false)
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(false)
    expect(fs.existsSync(h.paths.restoreJournalB)).toBe(false)
    expect(fs.readdirSync(h.paths.restoreRetired)).toEqual([])

    const archiveDirs = fs.readdirSync(h.paths.restoreArchive)
    expect(archiveDirs).toHaveLength(1)
    const payload = JSON.parse(
      fs.readFileSync(
        path.join(h.paths.restoreArchive, archiveDirs[0] as string, 'journal.json'),
        'utf8',
      ),
    ) as { terminalSnapshot: { terminalPhase: string; preRestoreBackupId: string | null } }
    expect(payload.terminalSnapshot.terminalPhase).toBe('aborted')
    expect(payload.terminalSnapshot.preRestoreBackupId).toBeNull()
  }, 20_000)

  it('rejects a second request while one is active', async () => {
    const h = setup()
    h.coordinator.request(h.backupId)
    expect(() => h.coordinator.request(h.backupId)).toThrow(/Restore transaction is active/)
    await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalled(), { timeout: 12_000 })
  }, 20_000)

  it('writes Journal A/B with identical canonical content', async () => {
    const h = setup()
    h.coordinator.request(h.backupId)
    await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalled(), { timeout: 12_000 })
    const a = RestoreJournalSchema.parse(
      JSON.parse(fs.readFileSync(h.paths.restoreJournalA, 'utf8')),
    )
    const b = RestoreJournalSchema.parse(
      JSON.parse(fs.readFileSync(h.paths.restoreJournalB, 'utf8')),
    )
    expect(a.globalRevision).toBe(b.globalRevision)
    expect(a.journalId).toBe(b.journalId)
  }, 20_000)

  it('⑧ aborts without replacement when the drain deadline expires', async () => {
    const h = setup({ drainDeadlineMs: 200 })
    const lease = h.drain.acquire('artifact-write', 'test:hold')
    try {
      h.coordinator.request(h.backupId)
      await vi.waitFor(() => expect(h.maintenance.state).toBe('recovery_locked'), {
        timeout: 12_000,
      })
      expect(h.shutdown).not.toHaveBeenCalled()
      // 中止已完成正式终态归档（零文件替换）；在途 lease 使 reopen 失败 → locked。
      const archiveDirs = fs.readdirSync(h.paths.restoreArchive)
      expect(archiveDirs).toHaveLength(1)
      const payload = JSON.parse(
        fs.readFileSync(
          path.join(h.paths.restoreArchive, archiveDirs[0] as string, 'journal.json'),
          'utf8',
        ),
      ) as {
        terminalSnapshot: {
          terminalPhase: string
          dataVerificationEvidence: { lastErrorCode?: string }
        }
      }
      expect(payload.terminalSnapshot.terminalPhase).toBe('aborted')
      expect(payload.terminalSnapshot.dataVerificationEvidence.lastErrorCode).toBe(
        'RESTORE_DRAIN_TIMEOUT',
      )
    } finally {
      lease.release()
    }
  }, 20_000)

  it('⑨ aborts with RESTORE_CHECKPOINT_BUSY when the WAL checkpoint stays busy', async () => {
    const h = setup()
    const blocker = new DatabaseSync(h.paths.database)
    blocker.exec('BEGIN')
    blocker.prepare('SELECT COUNT(*) AS c FROM backups').get()
    try {
      h.coordinator.request(h.backupId)
      await vi.waitFor(() => expect(h.runtime.resumeIngress).toHaveBeenCalled(), {
        timeout: 20_000,
      })
      expect(h.maintenance.state).toBe('normal')
      const archiveDirs = fs.readdirSync(h.paths.restoreArchive)
      expect(archiveDirs).toHaveLength(1)
      const payload = JSON.parse(
        fs.readFileSync(
          path.join(h.paths.restoreArchive, archiveDirs[0] as string, 'journal.json'),
          'utf8',
        ),
      ) as {
        terminalSnapshot: {
          terminalPhase: string
          dataVerificationEvidence: { lastErrorCode?: string }
        }
      }
      expect(payload.terminalSnapshot.terminalPhase).toBe('aborted')
      expect(payload.terminalSnapshot.dataVerificationEvidence.lastErrorCode).toBe(
        'RESTORE_CHECKPOINT_BUSY',
      )
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 30_000)
})
