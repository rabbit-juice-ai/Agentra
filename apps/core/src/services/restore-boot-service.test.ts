import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type RestoreJournal,
  RestoreJournalStore,
  RestoreMarkerSchema,
} from '../lifecycle/restore-journal'
import { RestoreArchiveService } from './restore-archive-service'
import { RestoreBootService } from './restore-boot-service'

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
  'completed',
] as const

type Setup = {
  paths: ReturnType<typeof agentraPaths>
  store: RestoreJournalStore
  archive: RestoreArchiveService
  boot: RestoreBootService
}

function setup(): Setup {
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
  const boot = new RestoreBootService(store, archive, paths.restoreArchive, undefined, () => NOW)
  return { paths, store, archive, boot }
}

function createJournal(
  h: Setup,
  options: { activate?: boolean; confirm?: boolean; marker?: boolean } = {},
): RestoreJournal {
  const { activate = true, confirm = true, marker = true } = options
  let journal = h.store.createInitial({ backupId: 'bak-target', now: NOW })
  journal = h.store.writeNext(
    journal,
    (draft) => {
      draft.targetBackupPath = '/tmp/agentra-backups/bak-target'
    },
    NOW,
  )
  if (!activate) return journal
  const markerBody = RestoreMarkerSchema.parse({
    markerVersion: 1,
    journalId: journal.journalId,
    backupId: journal.backupId,
    createdAt: NOW,
    canonicalForm: 1,
  })
  const parent = fs.lstatSync(h.paths.restore)
  journal = h.store.createActivationIntent(
    journal,
    markerBody,
    { path: h.paths.restore, dev: parent.dev, ino: parent.ino },
    NOW,
  )
  if (marker) h.store.createActiveMarker(markerBody)
  if (confirm) journal = h.store.verifyAndConfirmActivation(journal, NOW)
  return journal
}

function advanceTo(
  h: Setup,
  journal: RestoreJournal,
  target: (typeof ORDER)[number],
): RestoreJournal {
  let current = journal
  const targetIndex = ORDER.indexOf(target)
  for (
    let index = ORDER.indexOf(current.phase as (typeof ORDER)[number]) + 1;
    index <= targetIndex;
    index += 1
  ) {
    const phase = ORDER[index] as (typeof ORDER)[number]
    current = h.store.writeNext(
      current,
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
  return current
}

describe('RestoreBootService scene detection (A0–A10)', () => {
  it('returns none without marker or journal', () => {
    const h = setup()
    expect(h.boot.detect()).toEqual({ kind: 'none' })
  })

  it('resumes a handed_off transaction as forward', () => {
    const h = setup()
    advanceTo(h, createJournal(h), 'handed_off')
    expect(h.boot.detect().kind).toBe('forward')
  })

  it('A2: intent without confirmed and without marker is recovery_locked', () => {
    const h = setup()
    createJournal(h, { confirm: false, marker: false })
    const scene = h.boot.detect()
    expect(scene.kind).toBe('locked')
  })

  it('A3: marker with intent but no confirmed writes confirmed without recreating the marker', () => {
    const h = setup()
    const journal = advanceTo(h, createJournal(h, { confirm: false }), 'handed_off')
    expect(journal.activationConfirmed).toBeNull()
    const markerBefore = fs.readFileSync(h.paths.restoreActiveMarker, 'utf8')

    const scene = h.boot.detect()
    expect(scene.kind).toBe('forward')
    const reloaded = h.store.loadActive({ validateScene: () => true })
    expect(reloaded?.journal.activationConfirmed).not.toBeNull()
    expect(fs.readFileSync(h.paths.restoreActiveMarker, 'utf8')).toBe(markerBefore)
  })

  it('A6: confirmed without marker in a non-terminal phase is recovery_locked', () => {
    const h = setup()
    advanceTo(h, createJournal(h), 'handed_off')
    fs.unlinkSync(h.paths.restoreActiveMarker)
    expect(h.boot.detect().kind).toBe('locked')
  })

  it('㉙ A3 marker tampering is recovery_locked and never writes confirmed', () => {
    const h = setup()
    advanceTo(h, createJournal(h, { confirm: false }), 'handed_off')
    const markerPath = h.paths.restoreActiveMarker
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { createdAt: string }
    marker.createdAt = '2026-11-05T00:00:00.000Z'
    fs.writeFileSync(markerPath, JSON.stringify(marker))
    const revisionBefore = (
      h.store.readCopy(h.paths.restoreJournalA) as { journal: RestoreJournal }
    ).journal.globalRevision

    expect(h.boot.detect().kind).toBe('locked')
    const copy = h.store.readCopy(h.paths.restoreJournalA)
    if (copy.kind !== 'valid') throw new Error('journal unreadable')
    expect(copy.journal.activationConfirmed).toBeNull()
    expect(copy.journal.globalRevision).toBe(revisionBefore)
  })

  it('A1: marker without activation intent is recovery_locked', () => {
    const h = setup()
    const journal = createJournal(h, { activate: false })
    const markerBody = RestoreMarkerSchema.parse({
      markerVersion: 1,
      journalId: journal.journalId,
      backupId: journal.backupId,
      createdAt: NOW,
      canonicalForm: 1,
    })
    h.store.createActiveMarker(markerBody)
    expect(h.boot.detect().kind).toBe('locked')
  })

  it('A8: terminal journal without marker is finalized and archived', () => {
    const h = setup()
    const verified = advanceTo(h, createJournal(h), 'verified')
    h.archive.persistTerminal(verified, 'completed', { databaseIntegrity: 'ok' })
    fs.unlinkSync(h.paths.restoreActiveMarker)

    const scene = h.boot.detect()
    expect(scene.kind).toBe('terminal')
    if (scene.kind !== 'terminal') return
    const completed = h.boot.finalizeTerminal(scene.journal)
    expect(completed.phase).toBe('completed')
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(false)
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(false)
    const archiveDirs = fs.readdirSync(h.paths.restoreArchive)
    expect(archiveDirs).toContain(scene.journal.journalId)
  })

  it('aborts a pre-handoff transaction with a formal aborted archive', () => {
    const h = setup()
    const journal = advanceTo(h, createJournal(h), 'drained')
    const scene = h.boot.detect()
    expect(scene.kind).toBe('aborted')
    if (scene.kind !== 'aborted') return
    const aborted = h.boot.abortBeforeReplacement(scene.journal)
    expect(aborted.phase).toBe('aborted')
    expect(fs.existsSync(h.paths.restoreActiveMarker)).toBe(false)
    const archiveDir = path.join(h.paths.restoreArchive, journal.journalId, 'journal.json')
    const payload = JSON.parse(fs.readFileSync(archiveDir, 'utf8')) as {
      terminalSnapshot: { terminalPhase: string }
    }
    expect(payload.terminalSnapshot.terminalPhase).toBe('aborted')
  })

  it('archives an unactivated journal as abandoned', () => {
    const h = setup()
    const journal = createJournal(h, { activate: false })
    const scene = h.boot.detect()
    expect(scene.kind).toBe('abandoned')
    if (scene.kind !== 'abandoned') return
    const aborted = h.boot.archiveAbandoned(scene.journal)
    expect(aborted.phase).toBe('aborted')
    expect(fs.existsSync(h.paths.restoreJournalA)).toBe(false)
    expect(
      fs.existsSync(
        path.join(h.paths.restoreArchive, 'abandoned', journal.journalId, 'journal.a.json'),
      ),
    ).toBe(true)
  })
})
