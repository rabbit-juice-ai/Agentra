import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { BackupRepository } from '../db/repositories/backup-repository'
import { RestoreLockedError, sha256FileByFd } from '../lifecycle/restore-filesystem'
import {
  canonicalJson,
  type RestoreJournal,
  type RestoreJournalPaths,
  RestoreJournalSchema,
  RestoreJournalStore,
  RestoreMarkerSchema,
} from '../lifecycle/restore-journal'
import {
  RestoreExecutor,
  type RestoreExecutorFaultPoint,
  RestoreSimulatedCrash,
} from './restore-executor'

const dirs: string[] = []
const NOW = '2026-11-04T00:00:00.000Z'

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): {
  paths: ReturnType<typeof agentraPaths>
  store: RestoreJournalStore
  journal: RestoreJournal
  targetPackage: string
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a-rst-'))
  dirs.push(home)
  const paths = agentraPaths(home)
  ensureDirs(paths)

  // Live pre-Restore database and Artifact tree.
  const live = openDatabase(paths.database)
  migrate(live)
  live.exec(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('live-work', 'Live', '', '', 'draft', 'normal', '/tmp/live', NULL, '{}', '${NOW}', '${NOW}', NULL)`,
  )
  live.close()
  fs.mkdirSync(path.join(paths.artifacts, 'live-only'), { recursive: true })
  fs.writeFileSync(path.join(paths.artifacts, 'live-only', 'before.txt'), 'before')

  // Registered target backup package. Its self-row is intentionally creating in the snapshot.
  const targetPackage = path.join(paths.backups, 'bak-target')
  fs.mkdirSync(path.join(targetPackage, 'artifacts'), { recursive: true })
  const targetDb = path.join(targetPackage, 'database.db')
  const target = openDatabase(targetDb)
  migrate(target)
  const targetBackups = new BackupRepository(target)
  targetBackups.create({ id: 'bak-target', type: 'manual', storagePath: targetPackage }, NOW)
  target.exec(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('restored-work', 'Restored', '', '', 'draft', 'normal', '/tmp/restored', NULL, '{}', '${NOW}', '${NOW}', NULL)`,
  )
  target.close()
  const dbSha256 = sha256FileByFd(targetDb)
  const bytes = fs.statSync(targetDb).size
  fs.writeFileSync(
    path.join(targetPackage, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      createdAt: NOW,
      type: 'manual',
      database: { file: 'database.db', sha256: dbSha256, bytes },
      artifacts: [],
      counts: { artifacts: 0, files: 0 },
    }),
  )

  const journalPaths: RestoreJournalPaths = {
    restoreRoot: paths.restore,
    journalA: paths.restoreJournalA,
    journalB: paths.restoreJournalB,
    activeMarker: paths.restoreActiveMarker,
    archiveRoot: paths.restoreArchive,
  }
  const store = new RestoreJournalStore(journalPaths)
  let journal = store.createInitial({ backupId: 'bak-target', now: NOW })
  const marker = RestoreMarkerSchema.parse({
    markerVersion: 1,
    journalId: journal.journalId,
    backupId: journal.backupId,
    createdAt: NOW,
    canonicalForm: 1,
  })
  const parent = fs.lstatSync(paths.restore)
  journal = store.createActivationIntent(
    journal,
    marker,
    { path: paths.restore, dev: parent.dev, ino: parent.ino },
    NOW,
  )
  store.createActiveMarker(marker)
  journal = store.verifyAndConfirmActivation(journal, NOW)
  journal = store.writeNext(
    journal,
    (draft) => {
      draft.phase = 'prepared'
      draft.preRestoreBackupId = 'bak-pre'
      draft.targetBackupPath = targetPackage
      draft.preRestoreBackupRecord = {
        manifestVersion: 1,
        dbSha256: 'a'.repeat(64),
        files: [],
        storagePath: path.join(paths.backups, 'bak-pre'),
        createdAt: NOW,
        completedAt: NOW,
        verifiedAt: NOW,
      }
      draft.steps.preRestoreVerified = true
    },
    NOW,
  )
  journal = store.writeNext(
    journal,
    (draft) => {
      draft.phase = 'drained'
      draft.steps.drained = true
      draft.steps.ingressPaused = true
      draft.steps.checkpointed = true
    },
    NOW,
  )
  journal = store.writeNext(
    journal,
    (draft) => {
      draft.phase = 'handed_off'
      draft.steps.handedOff = true
    },
    NOW,
  )
  return { paths, store, journal, targetPackage }
}

describe('RestoreExecutor real filesystem flow', () => {
  it('captures rollback, installs target DB/Artifacts and repairs backup rows', () => {
    const h = setup()
    const executor = new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW)
    const result = executor.execute()

    expect(result.restored).toBe(true)
    expect(result.rolledBack).toBe(false)
    expect(result.journal.phase).toBe('reconciling')
    expect(result.journal.steps.captureVerified).toBe(true)
    expect(result.journal.steps.filesReplaced).toBe(true)
    expect(result.journal.steps.selfRowFixed).toBe(true)

    const restored = openDatabase(h.paths.database)
    try {
      expect(
        restored.prepare("SELECT name FROM works WHERE id='restored-work'").get(),
      ).toMatchObject({
        name: 'Restored',
      })
      expect(
        restored.prepare("SELECT COUNT(*) AS c FROM works WHERE id='live-work'").get(),
      ).toMatchObject({
        c: 0,
      })
      expect(
        restored.prepare("SELECT status FROM backups WHERE id='bak-target'").get(),
      ).toMatchObject({
        status: 'restored',
      })
      expect(restored.prepare("SELECT status FROM backups WHERE id='bak-pre'").get()).toMatchObject(
        {
          status: 'verified',
        },
      )
    } finally {
      restored.close()
    }
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
    expect(
      fs.existsSync(
        path.join(h.paths.restoreCapturedRollback, 'artifacts', 'live-only', 'before.txt'),
      ),
    ).toBe(true)
    expect(fs.existsSync(path.join(h.paths.artifacts, 'live-only'))).toBe(false)
  })

  it('rolls back from the independent captured copy when forward self-row repair fails', () => {
    const h = setup()
    // Force self-row repair conflict: remove target backup row from the backup snapshot.
    const targetDb = path.join(h.targetPackage, 'database.db')
    const db = openDatabase(targetDb)
    db.exec("DELETE FROM backups WHERE id='bak-target'")
    db.close()
    const manifestPath = path.join(h.targetPackage, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string; bytes: number }
    }
    manifest.database.sha256 = sha256FileByFd(targetDb)
    manifest.database.bytes = fs.statSync(targetDb).size
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const executor = new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW)
    const result = executor.execute()
    expect(result.restored).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.journal.phase).toBe('rolled_back')

    const rolledBack = openDatabase(h.paths.database)
    try {
      expect(rolledBack.prepare("SELECT name FROM works WHERE id='live-work'").get()).toMatchObject(
        {
          name: 'Live',
        },
      )
      expect(
        rolledBack.prepare("SELECT COUNT(*) AS c FROM works WHERE id='restored-work'").get(),
      ).toMatchObject({ c: 0 })
    } finally {
      rolledBack.close()
    }
    // RB remains independent; rollback consumed only rollback-staged.
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
  })

  it('⑫ fails closed to rollback when the registered backup package is damaged', () => {
    const h = setup()
    const targetDb = path.join(h.targetPackage, 'database.db')
    fs.appendFileSync(targetDb, Buffer.from('tamper'))
    const result = new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW).execute()
    expect(result.restored).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.journal.phase).toBe('rolled_back')
    // 备份包只读：失败路径不得删除或改写登记包。
    expect(fs.existsSync(targetDb)).toBe(true)
    const live = openDatabase(h.paths.database)
    try {
      expect(live.prepare("SELECT name FROM works WHERE id='live-work'").get()).toMatchObject({
        name: 'Live',
      })
    } finally {
      live.close()
    }
  })

  it('⑬ fails closed when a non-empty WAL survives the handoff', () => {
    const h = setup()
    fs.writeFileSync(`${h.paths.database}-wal`, 'dirty')
    const executor = new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW)
    expect(() => executor.execute()).toThrow(/non-empty WAL/)
    const resumed = reload(h)
    expect(resumed.phase).toBe('rollback_failed')
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
  })

  it('㉗ refuses rollback when capturedRollback no longer matches its manifest', () => {
    const h = setup()
    // 前向自愈失败（self-row 冲突）+ RB 在捕获后被外部篡改。
    const targetDb = path.join(h.targetPackage, 'database.db')
    const db = openDatabase(targetDb)
    db.exec("DELETE FROM backups WHERE id='bak-target'")
    db.close()
    const manifestPath = path.join(h.targetPackage, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string; bytes: number }
    }
    manifest.database.sha256 = sha256FileByFd(targetDb)
    manifest.database.bytes = fs.statSync(targetDb).size
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const executor = new RestoreExecutor(
      h.paths,
      h.store,
      h.journal,
      undefined,
      () => NOW,
      (point) => {
        if (point === 'after-forward-prepare-db') {
          fs.appendFileSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'), 'x')
        }
      },
    )
    expect(() => executor.execute()).toThrow()
    const resumed = reload(h)
    expect(resumed.phase).toBe('rollback_failed')
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
  })

  it('㉛ refuses rollback when RB changes after rollback-staged was verified', () => {
    const h = setup()
    const targetDb = path.join(h.targetPackage, 'database.db')
    const db = openDatabase(targetDb)
    db.exec("DELETE FROM backups WHERE id='bak-target'")
    db.close()
    const manifestPath = path.join(h.targetPackage, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string; bytes: number }
    }
    manifest.database.sha256 = sha256FileByFd(targetDb)
    manifest.database.bytes = fs.statSync(targetDb).size
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const executor = new RestoreExecutor(
      h.paths,
      h.store,
      h.journal,
      undefined,
      () => NOW,
      (point) => {
        if (point === 'after-rb-stage-art') {
          fs.appendFileSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'), 'x')
        }
      },
    )
    expect(() => executor.execute()).toThrow()
    const resumed = reload(h)
    expect(resumed.phase).toBe('rollback_failed')
  })

  it('㊻ refuses rollback when the RB Artifact set changes without touching copied hashes', () => {
    const h = setup()
    const targetDb = path.join(h.targetPackage, 'database.db')
    const db = openDatabase(targetDb)
    db.exec("DELETE FROM backups WHERE id='bak-target'")
    db.close()
    const manifestPath = path.join(h.targetPackage, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string; bytes: number }
    }
    manifest.database.sha256 = sha256FileByFd(targetDb)
    manifest.database.bytes = fs.statSync(targetDb).size
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const executor = new RestoreExecutor(
      h.paths,
      h.store,
      h.journal,
      undefined,
      () => NOW,
      (point) => {
        if (point === 'after-forward-prepare-db') {
          fs.writeFileSync(
            path.join(h.paths.restoreCapturedRollback, 'artifacts', 'intruder.txt'),
            'x',
          )
        }
      },
    )
    expect(() => executor.execute()).toThrow()
    const resumed = reload(h)
    expect(resumed.phase).toBe('rollback_failed')
  })
})

function reload(h: ReturnType<typeof setup>) {
  const loaded = h.store.loadActive({ validateScene: () => true })
  if (!loaded) throw new Error('active journal missing after simulated crash')
  return loaded.journal
}

describe('RestoreExecutor crash replay (v17 ⑩⑪⑭⑮)', () => {
  function crashingExecutor(h: ReturnType<typeof setup>, point: RestoreExecutorFaultPoint) {
    return new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW, crashAt(point))
  }

  function crashAt(point: RestoreExecutorFaultPoint) {
    return (hit: RestoreExecutorFaultPoint) => {
      if (hit === point) throw new RestoreSimulatedCrash(hit)
    }
  }

  it('resumes capture after a crash between CAP-DB verified and CAP-ART', () => {
    const h = setup()
    expect(() => crashingExecutor(h, 'after-capture-db-verified').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    const resumed = reload(h)
    expect(resumed.phase).toBe('capture')
    expect(resumed.operations.find((op) => op.operationId === 'cap-db-1')?.status).toBe('verified')
    expect(resumed.steps.captureVerified).toBe(false)

    const result = new RestoreExecutor(h.paths, h.store, resumed, undefined, () => NOW).execute()
    expect(result.restored).toBe(true)
    expect(result.journal.phase).toBe('reconciling')
    expect(result.journal.steps.captureVerified).toBe(true)
    expect(
      fs.existsSync(
        path.join(h.paths.restoreCapturedRollback, 'artifacts', 'live-only', 'before.txt'),
      ),
    ).toBe(true)
  })

  it('replays a completed F-DB rename whose operation was not recorded', () => {
    const h = setup()
    expect(() => crashingExecutor(h, 'after-f-db-rename').execute()).toThrow(RestoreSimulatedCrash)
    const resumed = reload(h)
    expect(resumed.phase).toBe('forward_replacement')
    const fdb = resumed.operations.find((op) => op.operationId === 'f-db-1')
    expect(fdb?.status).toBe('intent')
    // Rename already happened: staged DB is gone, live DB has the backup identity.
    expect(fs.existsSync(path.join(h.paths.restoreForwardStaged, 'db', 'agentra.db'))).toBe(false)

    const result = new RestoreExecutor(h.paths, h.store, resumed, undefined, () => NOW).execute()
    expect(result.restored).toBe(true)
    expect(result.journal.phase).toBe('reconciling')
    expect(result.journal.operations.find((op) => op.operationId === 'f-db-1')?.status).toBe('done')
  })

  it('replays a completed F-ART directory rename whose operation was not recorded', () => {
    const h = setup()
    expect(() => crashingExecutor(h, 'after-f-art-rename').execute()).toThrow(RestoreSimulatedCrash)
    const resumed = reload(h)
    expect(resumed.phase).toBe('forward_replacement')
    expect(resumed.operations.find((op) => op.operationId === 'f-art-1')?.status).toBe('intent')
    expect(fs.existsSync(path.join(h.paths.restoreForwardStaged, 'artifacts'))).toBe(false)

    const result = new RestoreExecutor(h.paths, h.store, resumed, undefined, () => NOW).execute()
    expect(result.restored).toBe(true)
    expect(result.journal.operations.find((op) => op.operationId === 'f-art-1')?.status).toBe(
      'done',
    )
  })

  it('replays the idempotent self-row repair transaction', () => {
    const h = setup()
    expect(() => crashingExecutor(h, 'after-self-row').execute()).toThrow(RestoreSimulatedCrash)
    const resumed = reload(h)
    expect(resumed.phase).toBe('self_row_fixing')
    expect(resumed.steps.selfRowFixed).toBe(false)

    const result = new RestoreExecutor(h.paths, h.store, resumed, undefined, () => NOW).execute()
    expect(result.restored).toBe(true)
    expect(result.journal.phase).toBe('reconciling')
    expect(result.journal.steps.selfRowFixed).toBe(true)
  })

  it('resumes an interrupted rollback from rollback_in_progress without consuming RB', () => {
    const h = setup()
    // Force a forward failure after capture (self-row conflict), then crash mid-rollback.
    const targetDb = path.join(h.targetPackage, 'database.db')
    const db = openDatabase(targetDb)
    db.exec("DELETE FROM backups WHERE id='bak-target'")
    db.close()
    const manifestPath = path.join(h.targetPackage, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string; bytes: number }
    }
    manifest.database.sha256 = sha256FileByFd(targetDb)
    manifest.database.bytes = fs.statSync(targetDb).size
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => crashingExecutor(h, 'after-rb-db-rename').execute()).toThrow(RestoreSimulatedCrash)
    const resumed = reload(h)
    expect(resumed.phase).toBe('rollback_in_progress')
    expect(resumed.directionLock).toBe('rollback')

    const rolledBack = new RestoreExecutor(
      h.paths,
      h.store,
      resumed,
      undefined,
      () => NOW,
    ).resumeRollback()
    expect(rolledBack.phase).toBe('rolled_back')
    const live = openDatabase(h.paths.database)
    try {
      expect(live.prepare("SELECT name FROM works WHERE id='live-work'").get()).toMatchObject({
        name: 'Live',
      })
    } finally {
      live.close()
    }
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
  })
})

describe('RestoreExecutor sidecar attribution replay (v17 ㊼)', () => {
  function crashAt(point: RestoreExecutorFaultPoint) {
    return (hit: RestoreExecutorFaultPoint) => {
      if (hit === point) throw new RestoreSimulatedCrash(hit)
    }
  }

  function crashExecutor(h: ReturnType<typeof setup>, point: RestoreExecutorFaultPoint) {
    return new RestoreExecutor(h.paths, h.store, h.journal, undefined, () => NOW, crashAt(point))
  }

  function resumeExecutor(h: ReturnType<typeof setup>, journal: RestoreJournal) {
    return new RestoreExecutor(h.paths, h.store, journal, undefined, () => NOW)
  }

  const walFile = (h: ReturnType<typeof setup>) => `${h.paths.database}-wal`
  const shmFile = (h: ReturnType<typeof setup>) => `${h.paths.database}-shm`
  const sidecar = (journal: RestoreJournal, id: string) =>
    journal.operations.find((op) => op.operationId === id)

  it('A: durable intent + missing target + no evidence → recovery_locked, no evidence written', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    const crashed = reload(h)
    expect(sidecar(crashed, 'f-side-wal-1')?.status).toBe('intent')
    expect(sidecar(crashed, 'f-side-wal-1')?.targetAnchor?.type).toBe('regular-file')

    fs.rmSync(walFile(h))
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const wal = sidecar(locked, 'f-side-wal-1')
    expect(wal?.status).toBe('blocked')
    expect(wal?.evidenceAnchor).toBeNull()
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalB)).toBe(true)
  })

  it('B: target replaced after intent → recovery_locked and the durable intent anchor is preserved', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    const crashed = reload(h)
    const before = sidecar(crashed, 'f-side-wal-1')?.targetAnchor
    expect(before?.type).toBe('regular-file')

    fs.rmSync(walFile(h))
    fs.writeFileSync(walFile(h), 'tampered')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    // 原始 intent anchor 未被当前 anchor 覆盖。
    expect(sidecar(locked, 'f-side-wal-1')?.targetAnchor).toEqual(before)
    expect(sidecar(locked, 'f-side-wal-1')?.status).toBe('blocked')
    // 未执行 unlink：被替换的对象仍在。
    expect(fs.readFileSync(walFile(h), 'utf8')).toBe('tampered')
  })

  it('C/D: WAL completion with evidence is trusted and only SHM continues', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal').execute()).toThrow(RestoreSimulatedCrash)

    const crashed = reload(h)
    const wal = sidecar(crashed, 'f-side-wal-1')
    expect(wal?.status).toBe('done')
    expect(wal?.evidenceAnchor).toMatchObject({
      targetAbsent: true,
      nlinkAfter: 0,
      directoryFsyncCompleted: true,
    })
    const walEvidence = wal?.evidenceAnchor
    expect(sidecar(crashed, 'f-side-shm-1')).toBeUndefined()
    expect(fs.existsSync(walFile(h))).toBe(false)

    const result = resumeExecutor(h, crashed).execute()
    expect(result.restored).toBe(true)

    const finished = reload(h)
    expect(sidecar(finished, 'f-side-wal-1')?.evidenceAnchor).toEqual(walEvidence)
    expect(sidecar(finished, 'f-side-shm-1')?.status).toBe('done')
    expect(fs.existsSync(walFile(h))).toBe(false)
    expect(fs.existsSync(shmFile(h))).toBe(false)
  })

  it('A: WAL missing without evidence locks and never starts the SHM operation', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    fs.rmSync(walFile(h))

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-shm-1')).toBeUndefined()
    expect(sidecar(locked, 'f-side-wal-1')?.status).toBe('blocked')
    expect(fs.readFileSync(shmFile(h), 'utf8')).toBe('')
  })

  it('B: SHM identity changed after its intent → recovery_locked, WAL evidence untouched', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-shm-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )

    const crashed = reload(h)
    expect(sidecar(crashed, 'f-side-wal-1')?.status).toBe('done')
    expect(sidecar(crashed, 'f-side-shm-1')?.status).toBe('intent')
    const walEvidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor

    fs.rmSync(shmFile(h))
    fs.writeFileSync(shmFile(h), 'tampered-shm')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-shm-1')?.status).toBe('blocked')
    expect(sidecar(locked, 'f-side-wal-1')?.evidenceAnchor).toEqual(walEvidence)
    expect(fs.readFileSync(shmFile(h), 'utf8')).toBe('tampered-shm')
  })

  it('preserves the durable intent anchor verbatim across replay failures', () => {
    const h = setup()
    fs.writeFileSync(shmFile(h), 'abc')
    expect(() => crashExecutor(h, 'after-sidecar-shm-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )

    const crashed = reload(h)
    const before = sidecar(crashed, 'f-side-shm-1')?.targetAnchor
    expect(before?.type).toBe('regular-file')
    expect(before?.sha256).not.toBeNull()

    // 同长度、不同内容的替换：只有内容 hash 变化，anchor 必须保持原值。
    fs.rmSync(shmFile(h))
    fs.writeFileSync(shmFile(h), 'xyz')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const after = sidecar(locked, 'f-side-shm-1')?.targetAnchor
    expect(after).toEqual(before)
    expect(after?.dev).toBe(before?.dev)
    expect(after?.ino).toBe(before?.ino)
    expect(after?.bytes).toBe(before?.bytes)
    expect(after?.sha256).toBe(before?.sha256)
    expect(fs.readFileSync(shmFile(h), 'utf8')).toBe('xyz')
  })

  it('op durable + no intent + target missing → recovery_locked without absent-intent or done', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-op-created').execute()).toThrow(
      RestoreSimulatedCrash,
    )

    const crashed = reload(h)
    const created = sidecar(crashed, 'f-side-wal-1')
    expect(created?.status).toBe('not_started')
    expect(created?.targetAnchor).toBeNull()
    expect(created?.intentState).toBeNull()

    fs.rmSync(walFile(h))
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const after = sidecar(locked, 'f-side-wal-1')
    expect(after?.status).toBe('blocked')
    // 不得补造 absent-intent 或完成证据。
    expect(after?.targetAnchor).toBeNull()
    expect(after?.intentState).toBeNull()
    expect(after?.evidenceAnchor).toBeNull()
    expect(after?.failureEvidence).toMatchObject({ code: 'UNLINK_ATTRIBUTION_UNKNOWN' })
    // 现场保留：marker、Journal A/B、RB 均不清理。
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalB)).toBe(true)
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
  })

  it('op durable + no intent + target present → establishes intent and unlinks normally', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-op-created').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    const crashed = reload(h)
    expect(sidecar(crashed, 'f-side-wal-1')?.status).toBe('not_started')

    const result = resumeExecutor(h, crashed).execute()
    expect(result.restored).toBe(true)

    const finished = reload(h)
    const wal = sidecar(finished, 'f-side-wal-1')
    expect(wal?.status).toBe('done')
    expect(wal?.targetAnchor?.type).toBe('regular-file')
    expect(wal?.evidenceAnchor).toMatchObject({ targetAbsent: true, nlinkAfter: 0 })
    expect(fs.existsSync(walFile(h))).toBe(false)
  })

  it('SHM op durable + no intent + SHM missing → locked; WAL evidence is not borrowed', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-shm-op-created').execute()).toThrow(
      RestoreSimulatedCrash,
    )

    const crashed = reload(h)
    const walEvidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor
    expect(sidecar(crashed, 'f-side-wal-1')?.status).toBe('done')
    expect(sidecar(crashed, 'f-side-shm-1')?.status).toBe('not_started')
    expect(sidecar(crashed, 'f-side-shm-1')?.targetAnchor).toBeNull()

    fs.rmSync(shmFile(h))
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const shm = sidecar(locked, 'f-side-shm-1')
    expect(shm?.status).toBe('blocked')
    expect(shm?.targetAnchor).toBeNull()
    expect(shm?.evidenceAnchor).toBeNull()
    // WAL 自身的证据不因 SHM 锁定而改变，也不能被借用于 SHM。
    expect(sidecar(locked, 'f-side-wal-1')?.evidenceAnchor).toEqual(walEvidence)
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(true)
  })

  it('WAL op durable + no intent + WAL missing → locked and SHM is never started', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-op-created').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    fs.rmSync(walFile(h))

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-shm-1')).toBeUndefined()
    expect(fs.readFileSync(shmFile(h), 'utf8')).toBe('')
  })

  it('restart replay of the locked state never upgrades a missing target to done', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal-op-created').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    fs.rmSync(walFile(h))
    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)

    const restarted = reload(h)
    expect(restarted.phase).toBe('recovery_locked')
    expect(() => resumeExecutor(h, restarted).execute()).toThrow()

    const after = reload(h)
    expect(after.phase).toBe('recovery_locked')
    expect(sidecar(after, 'f-side-wal-1')?.status).toBe('blocked')
    expect(sidecar(after, 'f-side-wal-1')?.evidenceAnchor).toBeNull()
  })

  function rewriteJournal(
    h: ReturnType<typeof setup>,
    mutate: (journal: RestoreJournal) => void,
  ): void {
    const journal = RestoreJournalSchema.parse(
      JSON.parse(fs.readFileSync(h.paths.restoreJournalA, 'utf8')),
    )
    mutate(journal)
    const body = `${canonicalJson(journal)}\n`
    fs.writeFileSync(h.paths.restoreJournalA, body)
    fs.writeFileSync(h.paths.restoreJournalB, body)
  }

  function doneWalState(h: ReturnType<typeof setup>): RestoreJournal {
    fs.writeFileSync(walFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-wal').execute()).toThrow(RestoreSimulatedCrash)
    const crashed = reload(h)
    expect(sidecar(crashed, 'f-side-wal-1')?.status).toBe('done')
    return crashed
  }

  it('P1: done + trusted evidence + target absent + parent unchanged → completion confirmed', () => {
    const h = setup()
    const crashed = doneWalState(h)
    const evidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor
    expect(evidence).toBeTruthy()

    const result = resumeExecutor(h, crashed).execute()
    expect(result.restored).toBe(true)

    const finished = reload(h)
    expect(sidecar(finished, 'f-side-wal-1')?.status).toBe('done')
    expect(sidecar(finished, 'f-side-wal-1')?.evidenceAnchor).toEqual(evidence)
    expect(fs.existsSync(walFile(h))).toBe(false)
  })

  it('P1: done + target reappears with identical content → recovery_locked', () => {
    const h = setup()
    const crashed = doneWalState(h)
    const evidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor

    fs.writeFileSync(walFile(h), '')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const wal = sidecar(locked, 'f-side-wal-1')
    expect(wal?.status).toBe('blocked')
    expect(wal?.evidenceAnchor).toEqual(evidence)
    expect(wal?.failureEvidence).toMatchObject({ code: 'TARGET_CONFLICT' })
    expect(fs.existsSync(walFile(h))).toBe(true)
  })

  it('P1: done + target reappears with different content → recovery_locked', () => {
    const h = setup()
    const crashed = doneWalState(h)
    fs.writeFileSync(walFile(h), 'tampered')

    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)
    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-wal-1')?.status).toBe('blocked')
    expect(fs.readFileSync(walFile(h), 'utf8')).toBe('tampered')
  })

  it('P1: done + evidence parent identity mismatch → recovery_locked', () => {
    const h = setup()
    doneWalState(h)
    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op?.evidenceAnchor) throw new Error('missing evidence')
      op.evidenceAnchor = {
        ...op.evidenceAnchor,
        parentIno: (op.evidenceAnchor.parentIno as number) + 1,
      }
    })

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-wal-1')?.failureEvidence).toMatchObject({
      code: 'IDENTITY_MISMATCH',
    })
  })

  it('P1: done + empty evidence object → recovery_locked', () => {
    const h = setup()
    doneWalState(h)
    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op) throw new Error('missing op')
      op.evidenceAnchor = {}
    })

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-wal-1')?.evidenceAnchor).toEqual({})
  })

  it('P1: done + evidence operationId mismatch → recovery_locked', () => {
    const h = setup()
    doneWalState(h)
    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op?.evidenceAnchor) throw new Error('missing evidence')
      op.evidenceAnchor = { ...op.evidenceAnchor, operationId: 'f-side-shm-1' }
    })

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    expect(reload(h).phase).toBe('recovery_locked')
  })

  it('P1: done + evidence missing a required field → recovery_locked', () => {
    const h = setup()
    doneWalState(h)
    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op?.evidenceAnchor) throw new Error('missing evidence')
      const { nlinkAfter: _dropped, ...rest } = op.evidenceAnchor
      op.evidenceAnchor = rest
    })

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    expect(reload(h).phase).toBe('recovery_locked')
  })

  it('P1: done + evidence with invalid field value/type → recovery_locked', () => {
    const h = setup()
    doneWalState(h)
    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op?.evidenceAnchor) throw new Error('missing evidence')
      op.evidenceAnchor = { ...op.evidenceAnchor, directoryFsyncCompleted: false }
    })
    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    expect(reload(h).phase).toBe('recovery_locked')

    const h2 = setup()
    doneWalState(h2)
    rewriteJournal(h2, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op?.evidenceAnchor) throw new Error('missing evidence')
      op.evidenceAnchor = { ...op.evidenceAnchor, parentDev: 'not-a-number' }
    })
    expect(() => resumeExecutor(h2, reload(h2)).execute()).toThrow(RestoreLockedError)
    expect(reload(h2).phase).toBe('recovery_locked')
  })

  it('P1: SHM completion uses only its own evidence; WAL evidence is untouched', () => {
    const h = setup()
    fs.writeFileSync(walFile(h), '')
    fs.writeFileSync(shmFile(h), '')
    expect(() => crashExecutor(h, 'after-sidecar-shm').execute()).toThrow(RestoreSimulatedCrash)

    const crashed = reload(h)
    const walEvidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor
    const shmEvidence = sidecar(crashed, 'f-side-shm-1')?.evidenceAnchor
    expect(shmEvidence).toBeTruthy()

    fs.writeFileSync(shmFile(h), 'reappeared')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-shm-1')?.status).toBe('blocked')
    expect(sidecar(locked, 'f-side-shm-1')?.evidenceAnchor).toEqual(shmEvidence)
    expect(sidecar(locked, 'f-side-wal-1')?.status).toBe('done')
    expect(sidecar(locked, 'f-side-wal-1')?.evidenceAnchor).toEqual(walEvidence)
    expect(fs.existsSync(walFile(h))).toBe(false)
  })

  it('P1: locked completion replay does not roll back and preserves all scenes', () => {
    const h = setup()
    const crashed = doneWalState(h)
    fs.writeFileSync(walFile(h), '')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(locked.directionLock).toBeNull()
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(true)
    expect(fs.existsSync(h.paths.restoreJournalB)).toBe(true)
    expect(fs.existsSync(path.join(h.paths.restoreCapturedRollback, 'db', 'agentra.db'))).toBe(true)
    // forward 未继续：staged DB 仍在，live DB 未被替换。
    expect(fs.existsSync(path.join(h.paths.restoreForwardStaged, 'db', 'agentra.db'))).toBe(true)
    const live = openDatabase(h.paths.database)
    try {
      expect(live.prepare("SELECT name FROM works WHERE id='live-work'").get()).toMatchObject({
        name: 'Live',
      })
      expect(
        live.prepare("SELECT COUNT(*) AS c FROM works WHERE id='restored-work'").get(),
      ).toMatchObject({ c: 0 })
    } finally {
      live.close()
    }
  })

  it('P2: blocked + absent anchor + target missing → locked, never upgraded to done', () => {
    const h = setup()
    expect(() => crashExecutor(h, 'after-sidecar-wal-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    const crashed = reload(h)
    expect(sidecar(crashed, 'f-side-wal-1')?.targetAnchor?.type).toBe('absent')

    rewriteJournal(h, (journal) => {
      const op = journal.operations.find((entry) => entry.operationId === 'f-side-wal-1')
      if (!op) throw new Error('missing op')
      op.status = 'blocked'
      op.failureEvidence = { code: 'TARGET_CONFLICT', message: 'simulated prior lock' }
    })
    expect(fs.existsSync(walFile(h))).toBe(false)

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    const wal = sidecar(locked, 'f-side-wal-1')
    expect(wal?.status).toBe('blocked')
    expect(wal?.evidenceAnchor).toBeNull()
    expect(wal?.failureEvidence).toMatchObject({ code: 'UNLINK_ATTRIBUTION_UNKNOWN' })
  })

  it('P2: blocked durable + failed recovery_locked phase write stays locked after restart', () => {
    const h = setup()
    // 真实产生 blocked：absent-intent 后目标重现 → TARGET_CONFLICT 锁定。
    expect(() => crashExecutor(h, 'after-sidecar-wal-intent').execute()).toThrow(
      RestoreSimulatedCrash,
    )
    fs.writeFileSync(walFile(h), '')
    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    const firstLock = reload(h)
    expect(firstLock.phase).toBe('recovery_locked')
    expect(sidecar(firstLock, 'f-side-wal-1')?.status).toBe('blocked')

    // 模拟 recovery_locked phase 写入失败：phase 回退为 forward_replacement，op 仍 blocked。
    rewriteJournal(h, (journal) => {
      journal.phase = 'forward_replacement'
    })
    fs.rmSync(walFile(h))

    expect(() => resumeExecutor(h, reload(h)).execute()).toThrow(RestoreLockedError)
    const restarted = reload(h)
    expect(restarted.phase).toBe('recovery_locked')
    const wal = sidecar(restarted, 'f-side-wal-1')
    expect(wal?.status).toBe('blocked')
    expect(wal?.evidenceAnchor).toBeNull()
  })

  it('P2: repeated replay of a locked sidecar never produces done or new evidence', () => {
    const h = setup()
    const crashed = doneWalState(h)
    const evidence = sidecar(crashed, 'f-side-wal-1')?.evidenceAnchor
    fs.writeFileSync(walFile(h), '')
    expect(() => resumeExecutor(h, crashed).execute()).toThrow(RestoreLockedError)

    const locked = reload(h)
    expect(locked.phase).toBe('recovery_locked')
    expect(sidecar(locked, 'f-side-wal-1')?.status).toBe('blocked')
    expect(sidecar(locked, 'f-side-wal-1')?.evidenceAnchor).toEqual(evidence)

    expect(() => resumeExecutor(h, locked).execute()).toThrow()
    const again = reload(h)
    expect(again.phase).toBe('recovery_locked')
    expect(sidecar(again, 'f-side-wal-1')?.status).toBe('blocked')
    expect(sidecar(again, 'f-side-wal-1')?.evidenceAnchor).toEqual(evidence)
  })
})
