import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type RestoreJournal,
  RestoreJournalStore,
  RestoreMarkerSchema,
  type RestoreTerminalSnapshot,
} from '../lifecycle/restore-journal'
import { RestoreArchiveService } from './restore-archive-service'

const dirs: string[] = []
const NOW = '2026-11-04T00:00:00.000Z'

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ORDER = [
  'requested',
  'prepared',
  'drained',
  'handed_off',
  'capture',
  'capture_verified',
  'forward_replacement',
  'replaced',
  'self_row_fixing',
  'reconciling',
  'verifying',
  'verified',
] as const

function setup(): {
  paths: ReturnType<typeof agentraPaths>
  store: RestoreJournalStore
  archive: RestoreArchiveService
  verified: RestoreJournal
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a-rst-'))
  dirs.push(home)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const store = new RestoreJournalStore({
    restoreRoot: paths.restore,
    journalA: paths.restoreJournalA,
    journalB: paths.restoreJournalB,
    activeMarker: paths.restoreActiveMarker,
    archiveRoot: paths.restoreArchive,
  })
  const archive = new RestoreArchiveService(store, paths.restoreRetired, () => NOW)
  let journal = store.createInitial({ backupId: 'bak-target', now: NOW })
  journal = store.writeNext(
    journal,
    (draft) => {
      draft.targetBackupPath = '/tmp/bak'
    },
    NOW,
  )
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
  for (const phase of ORDER.slice(1)) {
    journal = store.writeNext(
      journal,
      (draft) => {
        draft.phase = phase
        if (phase === 'prepared') {
          draft.preRestoreBackupId = 'bak-pre'
          draft.steps.preRestoreVerified = true
        }
        if (phase === 'drained') {
          draft.steps.drained = true
          draft.steps.handedOff = true
          draft.steps.ingressPaused = true
          draft.steps.checkpointed = true
        }
        if (phase === 'capture_verified') draft.steps.captureVerified = true
        if (phase === 'replaced') draft.steps.filesReplaced = true
        if (phase === 'reconciling') draft.steps.selfRowFixed = true
        if (phase === 'verifying') draft.steps.reconciled = true
        if (phase === 'verified') draft.steps.verified = true
      },
      NOW,
    )
  }
  return { paths, store, archive, verified: journal }
}

function archivePath(paths: ReturnType<typeof agentraPaths>, journalId: string): string {
  return path.join(paths.restoreArchive, journalId, 'journal.json')
}

describe('RestoreArchiveService terminal protocol', () => {
  it('⑳ re-running createAndVerify is idempotent and keeps Archive bytes fixed', () => {
    const h = setup()
    const terminal = h.archive.persistTerminal(h.verified, 'completed', { databaseIntegrity: 'ok' })
    const first = h.archive.createAndVerify(terminal)
    const file = archivePath(h.paths, first.journalId)
    const bytes = fs.readFileSync(file)
    const hash = first.archiveRecord?.actualArchiveSha256

    const second = h.archive.createAndVerify(first)
    expect(second.archiveRecord?.status).toBe('verified')
    expect(second.archiveRecord?.actualArchiveSha256).toBe(hash)
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  })

  it('㊸ refuses to adopt a pre-existing Archive with a different snapshot', () => {
    const h = setup()
    const terminal = h.archive.persistTerminal(h.verified, 'completed', { databaseIntegrity: 'ok' })
    const file = archivePath(h.paths, terminal.journalId)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // 合法 payload，但 journalId 不同 → payload digest 与固定 snapshot 不符。
    const conflicting = {
      archiveVersion: 1,
      journalId: 'rst-other',
      terminalSourceGlobalRevision: terminal.terminalSourceGlobalRevision,
      terminalSnapshot: terminal.terminalSnapshot as RestoreTerminalSnapshot,
      terminalSnapshotSha256: terminal.terminalSnapshotSha256,
    }
    fs.writeFileSync(file, `${JSON.stringify(conflicting)}\n`)

    expect(() => h.archive.createAndVerify(terminal)).toThrow(
      /conflicts with fixed terminal snapshot/,
    )
  })

  it('㊿ refuses to accept a verified Archive that was modified afterwards', () => {
    const h = setup()
    const terminal = h.archive.persistTerminal(h.verified, 'completed', { databaseIntegrity: 'ok' })
    const verified = h.archive.createAndVerify(terminal)
    const file = archivePath(h.paths, verified.journalId)
    fs.appendFileSync(file, ' ')

    expect(() => h.archive.createAndVerify(verified)).toThrow(/verified Archive changed/)
  })

  it('㊽ terminal snapshot bytes do not change across later Journal revisions', () => {
    const h = setup()
    const terminal = h.archive.persistTerminal(h.verified, 'completed', { databaseIntegrity: 'ok' })
    const snapshotJson = JSON.stringify(terminal.terminalSnapshot)
    const withArchive = h.archive.createAndVerify(terminal)
    const withRetirement = h.archive.writeRetiredManifest(withArchive)

    expect(JSON.stringify(withRetirement.terminalSnapshot)).toBe(snapshotJson)
    expect(withRetirement.terminalSnapshotSha256).toBe(terminal.terminalSnapshotSha256)
    expect(withRetirement.globalRevision).toBeGreaterThan(terminal.globalRevision)
  })
})
