import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANONICAL_FORM_VERSION,
  canonicalJson,
  chooseJournal,
  createTerminalSnapshot,
  type JournalCopyState,
  markerCanonicalSha256,
  parseJsonNoDuplicateKeys,
  type RestoreJournal,
  RestoreJournalError,
  type RestoreJournalPaths,
  RestoreJournalSchema,
  RestoreJournalStore,
  RestoreMarkerSchema,
  terminalSnapshotSha256,
} from './restore-journal'

const dirs: string[] = []
const NOW = '2026-11-04T00:00:00.000Z'

function paths(): RestoreJournalPaths {
  const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-restore-journal-'))
  dirs.push(restoreRoot)
  return {
    restoreRoot,
    journalA: path.join(restoreRoot, 'journal.a.json'),
    journalB: path.join(restoreRoot, 'journal.b.json'),
    activeMarker: path.join(restoreRoot, 'active'),
    archiveRoot: path.join(restoreRoot, 'archive'),
  }
}

function baseJournal(revision = 1): RestoreJournal {
  return RestoreJournalSchema.parse({
    journalVersion: 1,
    globalRevision: revision,
    journalId: 'rst-test',
    backupId: 'bak-target',
    preRestoreBackupId: null,
    targetBackupPath: null,
    preRestoreBackupRecord: null,
    phase: 'requested',
    directionLock: null,
    steps: {
      preRestoreVerified: false,
      drained: false,
      ingressPaused: false,
      checkpointed: false,
      handedOff: false,
      captureVerified: false,
      filesReplaced: false,
      selfRowFixed: false,
      reconciled: false,
      verified: false,
    },
    operations: [],
    activationIntent: null,
    activationConfirmed: null,
    checkpointEvidence: null,
    terminalSnapshot: null,
    terminalSnapshotSha256: null,
    terminalSourceGlobalRevision: null,
    archiveIntent: null,
    archiveRecord: null,
    currentOperationId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Restore Journal canonical form', () => {
  it('is deterministic for key order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 1 } })).toBe(
      canonicalJson({ a: { x: 1, y: 2 }, z: 1 }),
    )
  })

  it('rejects duplicate JSON object keys', () => {
    expect(() => parseJsonNoDuplicateKeys('{"a":1,"a":2}')).toThrow(/duplicate/)
  })

  it('rejects non-safe integers and lone surrogates', () => {
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integers/)
    expect(() => canonicalJson('\ud800')).toThrow(/surrogate/)
  })
})

describe('RestoreJournalStore A/B', () => {
  it('creates identical durable copies and loads through the active marker', () => {
    const p = paths()
    const store = new RestoreJournalStore(p)
    const journal = store.createInitial({ backupId: 'bak-target', now: NOW })
    const parent = fs.lstatSync(p.restoreRoot)
    const marker = RestoreMarkerSchema.parse({
      markerVersion: 1,
      journalId: journal.journalId,
      backupId: journal.backupId,
      createdAt: NOW,
      canonicalForm: CANONICAL_FORM_VERSION,
    })
    const withIntent = store.createActivationIntent(
      journal,
      marker,
      { path: p.restoreRoot, dev: parent.dev, ino: parent.ino },
      NOW,
    )
    store.createActiveMarker(marker)
    const confirmed = store.verifyAndConfirmActivation(withIntent, NOW)
    expect(confirmed.activationConfirmed).not.toBeNull()
    const loaded = store.loadActive({ validateScene: () => true })
    expect(loaded?.journal.globalRevision).toBe(confirmed.globalRevision)
    expect(loaded?.degraded).toBe(false)
    expect(markerCanonicalSha256(marker)).toHaveLength(64)
  })

  it('uses a single valid copy only when the filesystem scene validator accepts it', () => {
    const p = paths()
    const store = new RestoreJournalStore(p)
    const journal = store.createInitial({ backupId: 'bak-target', now: NOW })
    fs.rmSync(p.journalB)
    const a = store.readCopy(p.journalA)
    const b = store.readCopy(p.journalB)
    expect(chooseJournal(a, b, () => true)).toMatchObject({
      journal: { journalId: journal.journalId },
      degraded: true,
    })
    expect(() => chooseJournal(a, b, () => false)).toThrow(RestoreJournalError)
  })

  it('locks on same-revision different content', () => {
    const aJournal = baseJournal(2)
    const bJournal = { ...baseJournal(2), updatedAt: '2026-11-04T00:00:01.000Z' }
    const a: JournalCopyState = {
      kind: 'valid',
      path: 'a',
      journal: aJournal,
      canonical: canonicalJson(aJournal),
    }
    const b: JournalCopyState = {
      kind: 'valid',
      path: 'b',
      journal: bJournal,
      canonical: canonicalJson(bJournal),
    }
    expect(() => chooseJournal(a, b, () => true)).toThrow(/same revision/)
  })

  it('㊹ adopts the higher revision only when it is a valid successor and the scene agrees', () => {
    const low = baseJournal(1)
    const high = { ...baseJournal(2), updatedAt: '2026-11-04T00:00:02.000Z' }
    const a: JournalCopyState = {
      kind: 'valid',
      path: 'a',
      journal: low,
      canonical: canonicalJson(low),
    }
    const b: JournalCopyState = {
      kind: 'valid',
      path: 'b',
      journal: high,
      canonical: canonicalJson(high),
    }
    expect(chooseJournal(a, b, () => true)).toMatchObject({
      journal: { globalRevision: 2 },
      degraded: true,
    })
    expect(() => chooseJournal(a, b, () => false)).toThrow(/filesystem scene/)
  })

  it('locks on an indeterminate copy instead of treating it as damaged', () => {
    const valid = baseJournal(1)
    const a: JournalCopyState = {
      kind: 'valid',
      path: 'a',
      journal: valid,
      canonical: canonicalJson(valid),
    }
    const b: JournalCopyState = { kind: 'indeterminate', path: 'b', error: 'EIO' }
    expect(() => chooseJournal(a, b, () => true)).toThrow(/indeterminate/)
  })
})

describe('TerminalSnapshotV1', () => {
  it('is fixed independently from later Archive lifecycle revisions', () => {
    const p = paths()
    const store = new RestoreJournalStore(p)
    let journal = store.createInitial({ backupId: 'bak-target', now: NOW })
    const marker = RestoreMarkerSchema.parse({
      markerVersion: 1,
      journalId: journal.journalId,
      backupId: journal.backupId,
      createdAt: NOW,
      canonicalForm: 1,
    })
    const parent = fs.lstatSync(p.restoreRoot)
    journal = store.createActivationIntent(
      journal,
      marker,
      { path: p.restoreRoot, dev: parent.dev, ino: parent.ino },
      NOW,
    )
    store.createActiveMarker(marker)
    journal = store.verifyAndConfirmActivation(journal, NOW)
    journal = store.writeNext(
      journal,
      (draft) => {
        draft.preRestoreBackupId = 'bak-pre'
        draft.phase = 'aborted'
      },
      NOW,
    )
    const snapshot = createTerminalSnapshot(journal, {
      terminalPhase: 'aborted',
      dataVerificationEvidence: { liveUnchanged: true },
      terminalAt: NOW,
    })
    const hash = terminalSnapshotSha256(snapshot)
    expect(hash).toHaveLength(64)
    const later = store.writeNext(
      journal,
      (draft) => {
        draft.terminalSnapshot = snapshot
        draft.terminalSnapshotSha256 = hash
        draft.terminalSourceGlobalRevision = journal.globalRevision
      },
      NOW,
    )
    expect(terminalSnapshotSha256(later.terminalSnapshot as never)).toBe(hash)
  })
})
