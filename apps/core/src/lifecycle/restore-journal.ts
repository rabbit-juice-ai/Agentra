import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  RestoreOperationKindSchema,
  RestoreOperationStatusSchema,
  type RestorePhase,
  RestorePhaseSchema,
} from '@agentra/protocol'
import { z } from 'zod'

/** S55-2C Restore Journal/Marker/TerminalSnapshot 持久化内核。 */
export const RESTORE_JOURNAL_VERSION = 1 as const
export const RESTORE_MARKER_VERSION = 1 as const
export const CANONICAL_FORM_VERSION = 1 as const
export const TERMINAL_SNAPSHOT_VERSION = 1 as const

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const IdSchema = z.string().min(1)
const TimestampSchema = z.string().datetime({ offset: true })

export const RestoreFileTypeSchema = z.enum(['regular-file', 'directory', 'absent'])
export const RestoreFileAnchorSchema = z
  .object({
    path: z.string().min(1),
    realPath: z.string().min(1).nullable(),
    type: RestoreFileTypeSchema,
    dev: z.number().int().nonnegative().nullable(),
    ino: z.number().int().nonnegative().nullable(),
    nlink: z.number().int().nonnegative().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    sha256: Sha256Schema.nullable(),
  })
  .strict()
export type RestoreFileAnchor = z.infer<typeof RestoreFileAnchorSchema>

export const RestoreManifestEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    type: z.enum(['file', 'directory']),
    bytes: z.number().int().nonnegative().nullable(),
    sha256: Sha256Schema.nullable(),
    dev: z.number().int().nonnegative().nullable(),
    ino: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type RestoreManifestEntry = z.infer<typeof RestoreManifestEntrySchema>

export const RestoreDirectoryInventorySchema = z
  .object({ root: RestoreFileAnchorSchema, entries: z.array(RestoreManifestEntrySchema) })
  .strict()
export type RestoreDirectoryInventory = z.infer<typeof RestoreDirectoryInventorySchema>

export const RestoreOperationTypeSchema = z.enum([
  'capture',
  'forward_prepare',
  'sidecar',
  'forward_install',
  'rollback_stage',
  'rollback_install',
  'archive',
  'marker',
  'cleanup',
])
export const RestoreSourceRoleSchema = z.enum([
  'live',
  'backup_package',
  'captured_rollback',
  'forward_staged',
  'rollback_staged',
  'none',
])
export const RestoreTargetPolicySchema = z.enum(['must_be_absent', 'must_exist_and_match'])

export const RestorePerFileUnlinkSchema = z
  .object({
    relativePath: z.string().min(1),
    targetAnchor: RestoreFileAnchorSchema,
    unlinkIntentRevision: z.number().int().min(1),
    completeEvidenceRevision: z.number().int().min(1).nullable(),
    status: z.enum(['intent', 'complete', 'blocked']),
  })
  .strict()

export const RestoreOperationSchema = z
  .object({
    operationId: IdSchema,
    operationType: RestoreOperationTypeSchema,
    kind: RestoreOperationKindSchema,
    sourceRole: RestoreSourceRoleSchema,
    source: z.string().min(1).nullable(),
    target: z.string().min(1),
    expectedType: RestoreFileTypeSchema,
    targetPolicy: RestoreTargetPolicySchema.nullable(),
    expectedSha256: Sha256Schema.nullable(),
    actualSha256: Sha256Schema.nullable(),
    expectedManifest: z.array(RestoreManifestEntrySchema).nullable(),
    actualManifest: z.array(RestoreManifestEntrySchema).nullable(),
    sourceAnchor: RestoreFileAnchorSchema.nullable(),
    targetAnchor: RestoreFileAnchorSchema.nullable(),
    sourceParentAnchor: RestoreFileAnchorSchema.nullable(),
    targetParentAnchor: RestoreFileAnchorSchema.nullable(),
    directoryInventory: RestoreDirectoryInventorySchema.nullable(),
    perFileUnlinks: z.array(RestorePerFileUnlinkSchema),
    intentState: z.string().min(1).nullable(),
    status: RestoreOperationStatusSchema,
    opRev: z.number().int().min(1),
    globalRevAtLastWrite: z.number().int().min(1),
    evidenceAnchor: z.record(z.string(), z.unknown()).nullable(),
    failureEvidence: z.record(z.string(), z.unknown()).nullable(),
    evidenceDigest: Sha256Schema.nullable(),
  })
  .strict()
export type RestoreOperation = z.infer<typeof RestoreOperationSchema>

export const RestoreActivationIntentSchema = z
  .object({
    journalId: IdSchema,
    backupId: IdSchema,
    expectedMarkerPath: z.string().min(1),
    markerCanonicalForm: z.literal(CANONICAL_FORM_VERSION),
    expectedMarkerCanonicalSha256: Sha256Schema,
    expectedParentPath: z.string().min(1),
    expectedParentDev: z.number().int().nonnegative(),
    expectedParentIno: z.number().int().nonnegative(),
  })
  .strict()
export type RestoreActivationIntent = z.infer<typeof RestoreActivationIntentSchema>

export const RestoreActivationConfirmedSchema = z
  .object({
    confirmedAt: TimestampSchema,
    markerDev: z.number().int().nonnegative(),
    markerIno: z.number().int().nonnegative(),
    markerCanonicalSha256: Sha256Schema,
    parentDev: z.number().int().nonnegative(),
    parentIno: z.number().int().nonnegative(),
  })
  .strict()
export type RestoreActivationConfirmed = z.infer<typeof RestoreActivationConfirmedSchema>

export const RestoreStepsSchema = z
  .object({
    preRestoreVerified: z.boolean(),
    drained: z.boolean(),
    ingressPaused: z.boolean(),
    checkpointed: z.boolean(),
    handedOff: z.boolean(),
    captureVerified: z.boolean(),
    filesReplaced: z.boolean(),
    selfRowFixed: z.boolean(),
    reconciled: z.boolean(),
    verified: z.boolean(),
  })
  .strict()
export type RestoreSteps = z.infer<typeof RestoreStepsSchema>

export const RestoreTerminalSnapshotSchema = z
  .object({
    terminalSnapshotVersion: z.literal(TERMINAL_SNAPSHOT_VERSION),
    journalVersion: z.literal(RESTORE_JOURNAL_VERSION),
    journalId: IdSchema,
    backupId: IdSchema,
    // v17：aborted 可发生在 pre_restore 之前（drain 超时/Execution≠0/ingress 不稳定），
    // 此时不存在 pre_restore 备份；completed/rolled_back 仍强制非空（由生成器校验）。
    preRestoreBackupId: IdSchema.nullable(),
    terminalPhase: z.enum(['completed', 'rolled_back', 'aborted']),
    terminalSteps: RestoreStepsSchema,
    operations: z.array(RestoreOperationSchema),
    checkpointEvidence: z.record(z.string(), z.unknown()).nullable(),
    activationIntent: RestoreActivationIntentSchema,
    activationConfirmed: RestoreActivationConfirmedSchema,
    directionLock: z.enum(['rollback']).nullable(),
    dataVerificationEvidence: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
    terminalAt: TimestampSchema,
  })
  .strict()
export type RestoreTerminalSnapshot = z.infer<typeof RestoreTerminalSnapshotSchema>

export const RestoreArchiveIntentSchema = z
  .object({
    archiveVersion: z.literal(1),
    journalId: IdSchema,
    terminalSourceGlobalRevision: z.number().int().min(1),
    terminalSnapshotSha256: Sha256Schema,
    targetPath: z.string().min(1),
  })
  .strict()

export const RestoreArchiveRecordSchema = z
  .object({
    status: z.enum(['intent', 'recorded', 'verified']),
    path: z.string().min(1),
    sourceGlobalRevision: z.number().int().min(1),
    terminalSnapshotSha256: Sha256Schema,
    actualArchiveSha256: Sha256Schema.nullable(),
    verifiedAt: TimestampSchema.nullable(),
    retiredManifest: z
      .object({
        canonicalForm: z.literal(CANONICAL_FORM_VERSION),
        journalASha256: Sha256Schema,
        journalBSha256: Sha256Schema,
      })
      .strict()
      .nullable(),
  })
  .strict()

export const RestorePreBackupRecordSchema = z
  .object({
    manifestVersion: z.number().int().min(1),
    dbSha256: Sha256Schema,
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: Sha256Schema,
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    storagePath: z.string().min(1),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema,
    verifiedAt: TimestampSchema,
  })
  .strict()
export type RestorePreBackupRecord = z.infer<typeof RestorePreBackupRecordSchema>

export const RestoreJournalSchema = z
  .object({
    journalVersion: z.literal(RESTORE_JOURNAL_VERSION),
    globalRevision: z.number().int().min(1),
    journalId: IdSchema,
    backupId: IdSchema,
    preRestoreBackupId: IdSchema.nullable(),
    targetBackupPath: z.string().min(1).nullable(),
    preRestoreBackupRecord: RestorePreBackupRecordSchema.nullable(),
    phase: RestorePhaseSchema,
    directionLock: z.enum(['rollback']).nullable(),
    steps: RestoreStepsSchema,
    operations: z.array(RestoreOperationSchema),
    activationIntent: RestoreActivationIntentSchema.nullable(),
    activationConfirmed: RestoreActivationConfirmedSchema.nullable(),
    checkpointEvidence: z.record(z.string(), z.unknown()).nullable(),
    terminalSnapshot: RestoreTerminalSnapshotSchema.nullable(),
    terminalSnapshotSha256: Sha256Schema.nullable(),
    terminalSourceGlobalRevision: z.number().int().min(1).nullable(),
    archiveIntent: RestoreArchiveIntentSchema.nullable(),
    archiveRecord: RestoreArchiveRecordSchema.nullable(),
    currentOperationId: z.string().nullable(),
    lastError: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict()
      .nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type RestoreJournal = z.infer<typeof RestoreJournalSchema>

export const RestoreMarkerSchema = z
  .object({
    markerVersion: z.literal(RESTORE_MARKER_VERSION),
    journalId: IdSchema,
    backupId: IdSchema,
    createdAt: TimestampSchema,
    canonicalForm: z.literal(CANONICAL_FORM_VERSION),
  })
  .strict()
export type RestoreMarker = z.infer<typeof RestoreMarkerSchema>

export const RestoreArchivePayloadSchema = z
  .object({
    archiveVersion: z.literal(1),
    journalId: IdSchema,
    terminalSourceGlobalRevision: z.number().int().min(1),
    terminalSnapshot: RestoreTerminalSnapshotSchema,
    terminalSnapshotSha256: Sha256Schema,
  })
  .strict()
export type RestoreArchivePayload = z.infer<typeof RestoreArchivePayloadSchema>

export type RestoreJournalPaths = {
  restoreRoot: string
  journalA: string
  journalB: string
  activeMarker: string
  archiveRoot: string
}

export type JournalCopyState =
  | { kind: 'missing'; path: string }
  | { kind: 'valid'; path: string; journal: RestoreJournal; canonical: string }
  | { kind: 'invalid'; path: string; error: string }
  | { kind: 'indeterminate'; path: string; error: string }

export class RestoreJournalError extends Error {
  constructor(
    readonly code:
      | 'RESTORE_JOURNAL_INVALID'
      | 'RESTORE_JOURNAL_CONFLICT'
      | 'RESTORE_JOURNAL_INDETERMINATE'
      | 'RESTORE_JOURNAL_TRANSITION_INVALID'
      | 'RESTORE_MARKER_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RestoreJournalError'
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new Error(`canonical JSON requires safe integers: ${value}`)
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'string') {
    assertNoLoneSurrogates(value)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object).sort()
    for (const key of keys) assertNoLoneSurrogates(key)
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  throw new Error(`unsupported canonical JSON value: ${typeof value}`)
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function sha256File(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

export function parseJsonNoDuplicateKeys(raw: string): unknown {
  return new StrictJsonParser(raw).parse()
}

export function parseRestoreJournal(raw: string): RestoreJournal {
  return RestoreJournalSchema.parse(parseJsonNoDuplicateKeys(raw))
}

export function parseRestoreMarker(raw: string): RestoreMarker {
  return RestoreMarkerSchema.parse(parseJsonNoDuplicateKeys(raw))
}

export function markerCanonicalSha256(marker: RestoreMarker): string {
  return sha256Canonical(RestoreMarkerSchema.parse(marker))
}

export function terminalSnapshotSha256(snapshot: RestoreTerminalSnapshot): string {
  return sha256Canonical(RestoreTerminalSnapshotSchema.parse(snapshot))
}

export function archivePayloadSha256(payload: RestoreArchivePayload): string {
  return sha256Canonical(RestoreArchivePayloadSchema.parse(payload))
}

const PHASE_TRANSITIONS: Readonly<Record<RestorePhase, readonly RestorePhase[]>> = {
  requested: ['prepared', 'aborted', 'recovery_locked'],
  prepared: ['drained', 'aborted', 'recovery_locked'],
  drained: ['handed_off', 'aborted', 'recovery_locked'],
  handed_off: ['capture', 'rollback_in_progress', 'recovery_locked'],
  capture: ['capture_verified', 'aborted', 'recovery_locked'],
  capture_verified: ['forward_replacement', 'rollback_in_progress', 'recovery_locked'],
  forward_replacement: ['replaced', 'rollback_in_progress', 'recovery_locked'],
  replaced: ['self_row_fixing', 'rollback_in_progress', 'recovery_locked'],
  self_row_fixing: ['reconciling', 'rollback_in_progress', 'recovery_locked'],
  reconciling: ['verifying', 'rollback_in_progress', 'recovery_locked'],
  verifying: ['verified', 'rollback_in_progress', 'recovery_locked'],
  verified: ['completed', 'rollback_in_progress', 'recovery_locked'],
  completed: ['recovery_locked'],
  rollback_in_progress: ['rolled_back', 'rollback_failed', 'recovery_locked'],
  rolled_back: ['recovery_locked'],
  rollback_failed: ['recovery_locked'],
  aborted: ['recovery_locked'],
  recovery_locked: [],
}

export function assertRestorePhaseTransition(from: RestorePhase, to: RestorePhase): void {
  if (from === to) return
  if (!PHASE_TRANSITIONS[from].includes(to)) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_TRANSITION_INVALID',
      `illegal Restore phase transition: ${from} -> ${to}`,
    )
  }
}

export function assertOperationMonotonic(previous: RestoreOperation, next: RestoreOperation): void {
  if (previous.operationId !== next.operationId || next.opRev < previous.opRev) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_TRANSITION_INVALID',
      `operation identity/revision regressed: ${next.operationId}`,
    )
  }
  const order = [
    'not_started',
    'intent',
    'capturing',
    'captured',
    'verifying',
    'verified',
    'installed',
    'done',
    'rb_staged',
    'rb_verified',
    'blocked',
  ] as const
  if (order.indexOf(next.status) < order.indexOf(previous.status)) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_TRANSITION_INVALID',
      `operation status regressed: ${previous.status} -> ${next.status}`,
    )
  }
}

export function chooseJournal(
  a: JournalCopyState,
  b: JournalCopyState,
  validateScene: (journal: RestoreJournal) => boolean,
): { journal: RestoreJournal; degraded: boolean } {
  if (a.kind === 'indeterminate' || b.kind === 'indeterminate') {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_INDETERMINATE',
      'Journal copy identity/read state is indeterminate',
      { a, b },
    )
  }
  if (a.kind === 'valid' && b.kind === 'valid') {
    if (a.journal.globalRevision === b.journal.globalRevision) {
      if (a.canonical !== b.canonical) {
        throw new RestoreJournalError(
          'RESTORE_JOURNAL_CONFLICT',
          'Journal A/B have same revision but different content',
        )
      }
      if (!validateScene(a.journal)) throw sceneConflict()
      return { journal: a.journal, degraded: false }
    }
    const high = a.journal.globalRevision > b.journal.globalRevision ? a : b
    const low = high === a ? b : a
    assertJournalMonotonic(low.journal, high.journal)
    if (!validateScene(high.journal)) throw sceneConflict()
    return { journal: high.journal, degraded: true }
  }
  const only = a.kind === 'valid' ? a : b.kind === 'valid' ? b : null
  if (!only) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_INVALID',
      'active Journal copies are missing or invalid',
      { a, b },
    )
  }
  if (!validateScene(only.journal)) throw sceneConflict()
  return { journal: only.journal, degraded: true }
}

function sceneConflict(): RestoreJournalError {
  return new RestoreJournalError(
    'RESTORE_JOURNAL_CONFLICT',
    'Journal content conflicts with filesystem scene',
  )
}

export class RestoreJournalStore {
  constructor(readonly paths: RestoreJournalPaths) {}

  createInitial(input: { backupId: string; now: string }): RestoreJournal {
    fs.mkdirSync(this.paths.restoreRoot, { recursive: true, mode: 0o700 })
    const journal = RestoreJournalSchema.parse({
      journalVersion: RESTORE_JOURNAL_VERSION,
      globalRevision: 1,
      journalId: `rst-${randomUUID()}`,
      backupId: input.backupId,
      preRestoreBackupId: null,
      targetBackupPath: null,
      preRestoreBackupRecord: null,
      phase: 'requested',
      directionLock: null,
      steps: emptySteps(),
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
      createdAt: input.now,
      updatedAt: input.now,
    })
    this.writeBoth(journal)
    return journal
  }

  loadActive(options: {
    validateScene: (journal: RestoreJournal) => boolean
    repairDegraded?: boolean
  }): { journal: RestoreJournal; degraded: boolean } | null {
    if (!fs.existsSync(this.paths.activeMarker)) return null
    const marker = this.readAndValidateMarker()
    const chosen = chooseJournal(
      this.readCopy(this.paths.journalA),
      this.readCopy(this.paths.journalB),
      options.validateScene,
    )
    if (
      chosen.journal.journalId !== marker.journalId ||
      chosen.journal.backupId !== marker.backupId
    ) {
      throw new RestoreJournalError(
        'RESTORE_MARKER_INVALID',
        'active marker does not match Restore Journal identity',
      )
    }
    if (chosen.degraded && options.repairDegraded) this.writeBoth(chosen.journal)
    return chosen
  }

  writeNext(
    previous: RestoreJournal,
    update: (draft: RestoreJournal) => void,
    now: string,
  ): RestoreJournal {
    const draft = structuredClone(previous)
    update(draft)
    draft.globalRevision = previous.globalRevision + 1
    draft.updatedAt = now
    const parsed = RestoreJournalSchema.parse(draft)
    assertJournalMonotonic(previous, parsed)
    this.writeBoth(parsed)
    return parsed
  }

  createActivationIntent(
    journal: RestoreJournal,
    marker: RestoreMarker,
    parentAnchor: { path: string; dev: number; ino: number },
    now: string,
  ): RestoreJournal {
    return this.writeNext(
      journal,
      (draft) => {
        draft.activationIntent = {
          journalId: journal.journalId,
          backupId: journal.backupId,
          expectedMarkerPath: this.paths.activeMarker,
          markerCanonicalForm: CANONICAL_FORM_VERSION,
          expectedMarkerCanonicalSha256: markerCanonicalSha256(marker),
          expectedParentPath: parentAnchor.path,
          expectedParentDev: parentAnchor.dev,
          expectedParentIno: parentAnchor.ino,
        }
      },
      now,
    )
  }

  createActiveMarker(marker: RestoreMarker): void {
    atomicWrite(this.paths.activeMarker, `${canonicalJson(RestoreMarkerSchema.parse(marker))}\n`)
  }

  verifyAndConfirmActivation(journal: RestoreJournal, now: string): RestoreJournal {
    const intent = journal.activationIntent
    if (!intent)
      throw new RestoreJournalError('RESTORE_MARKER_INVALID', 'activation intent is missing')
    const marker = this.readAndValidateMarker(intent)
    const markerStat = fs.lstatSync(this.paths.activeMarker)
    const parentPath = path.dirname(this.paths.activeMarker)
    const parentStat = fs.lstatSync(parentPath)
    if (!markerStat.isFile() || !parentStat.isDirectory()) {
      throw new RestoreJournalError('RESTORE_MARKER_INVALID', 'marker or parent has wrong type')
    }
    if (
      parentStat.dev !== intent.expectedParentDev ||
      parentStat.ino !== intent.expectedParentIno ||
      parentPath !== intent.expectedParentPath
    ) {
      throw new RestoreJournalError('RESTORE_MARKER_INVALID', 'marker parent identity changed')
    }
    const fd = fs.openSync(this.paths.activeMarker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd)
      if (opened.dev !== markerStat.dev || opened.ino !== markerStat.ino || !opened.isFile()) {
        throw new RestoreJournalError('RESTORE_MARKER_INVALID', 'marker identity changed')
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fsyncDirectory(parentPath)
    // A3: reopen and revalidate after marker + directory fsync.
    this.readAndValidateMarker(intent)
    return this.writeNext(
      journal,
      (draft) => {
        draft.activationConfirmed = {
          confirmedAt: now,
          markerDev: markerStat.dev,
          markerIno: markerStat.ino,
          markerCanonicalSha256: markerCanonicalSha256(marker),
          parentDev: parentStat.dev,
          parentIno: parentStat.ino,
        }
      },
      now,
    )
  }

  readCopy(file: string): JournalCopyState {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: file }
      return { kind: 'indeterminate', path: file, error: String(error) }
    }
    if (!stat.isFile()) return { kind: 'invalid', path: file, error: 'not a regular file' }
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      return { kind: 'indeterminate', path: file, error: String(error) }
    }
    try {
      const journal = parseRestoreJournal(raw)
      return { kind: 'valid', path: file, journal, canonical: canonicalJson(journal) }
    } catch (error) {
      return { kind: 'invalid', path: file, error: String(error) }
    }
  }

  private writeBoth(journal: RestoreJournal): void {
    const body = `${canonicalJson(RestoreJournalSchema.parse(journal))}\n`
    atomicWrite(this.paths.journalA, body)
    atomicWrite(this.paths.journalB, body)
    const a = this.readCopy(this.paths.journalA)
    const b = this.readCopy(this.paths.journalB)
    if (a.kind !== 'valid' || b.kind !== 'valid' || a.canonical !== b.canonical) {
      throw new RestoreJournalError('RESTORE_JOURNAL_CONFLICT', 'Journal A/B readback mismatch')
    }
  }

  private readAndValidateMarker(intent?: RestoreActivationIntent): RestoreMarker {
    const marker = parseRestoreMarker(fs.readFileSync(this.paths.activeMarker, 'utf8'))
    if (
      intent &&
      (marker.journalId !== intent.journalId ||
        marker.backupId !== intent.backupId ||
        markerCanonicalSha256(marker) !== intent.expectedMarkerCanonicalSha256)
    ) {
      throw new RestoreJournalError(
        'RESTORE_MARKER_INVALID',
        'marker content does not match activation intent',
      )
    }
    return marker
  }
}

export function createTerminalSnapshot(
  journal: RestoreJournal,
  input: {
    terminalPhase: 'completed' | 'rolled_back' | 'aborted'
    dataVerificationEvidence: Record<string, unknown>
    terminalAt: string
  },
): RestoreTerminalSnapshot {
  if (!journal.activationIntent || !journal.activationConfirmed) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_INVALID',
      'terminal snapshot requires confirmed activation',
    )
  }
  if (input.terminalPhase !== 'aborted' && !journal.preRestoreBackupId) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_INVALID',
      'completed/rolled_back snapshot requires pre-restore backup',
    )
  }
  return RestoreTerminalSnapshotSchema.parse({
    terminalSnapshotVersion: TERMINAL_SNAPSHOT_VERSION,
    journalVersion: RESTORE_JOURNAL_VERSION,
    journalId: journal.journalId,
    backupId: journal.backupId,
    preRestoreBackupId: journal.preRestoreBackupId,
    terminalPhase: input.terminalPhase,
    terminalSteps: journal.steps,
    operations: journal.operations,
    checkpointEvidence: journal.checkpointEvidence,
    activationIntent: journal.activationIntent,
    activationConfirmed: journal.activationConfirmed,
    directionLock: journal.directionLock,
    dataVerificationEvidence: input.dataVerificationEvidence,
    createdAt: journal.createdAt,
    terminalAt: input.terminalAt,
  })
}

function assertJournalMonotonic(previous: RestoreJournal, next: RestoreJournal): void {
  if (next.globalRevision <= previous.globalRevision) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_TRANSITION_INVALID',
      'global Journal revision must increase',
    )
  }
  if (previous.journalId !== next.journalId || previous.backupId !== next.backupId) {
    throw new RestoreJournalError(
      'RESTORE_JOURNAL_TRANSITION_INVALID',
      'Journal identity is immutable',
    )
  }
  assertRestorePhaseTransition(previous.phase, next.phase)
  const previousOps = new Map(
    previous.operations.map((operation) => [operation.operationId, operation]),
  )
  for (const operation of next.operations) {
    const before = previousOps.get(operation.operationId)
    if (before) assertOperationMonotonic(before, operation)
  }
  if (previous.terminalSnapshot) {
    if (!next.terminalSnapshot) {
      throw new RestoreJournalError(
        'RESTORE_JOURNAL_TRANSITION_INVALID',
        'terminal snapshot cannot be removed',
      )
    }
    if (
      terminalSnapshotSha256(previous.terminalSnapshot) !==
      terminalSnapshotSha256(next.terminalSnapshot)
    ) {
      throw new RestoreJournalError(
        'RESTORE_JOURNAL_TRANSITION_INVALID',
        'terminal snapshot is immutable',
      )
    }
  }
}

function emptySteps(): RestoreSteps {
  return {
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
  }
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.new`
  try {
    fs.rmSync(temp, { force: true })
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, body, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
    fsyncDirectory(path.dirname(file))
  } catch (error) {
    // Only a .new temporary is safe to remove. Never delete a durable Journal copy.
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Preserve original error.
    }
    throw error
  }
}

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('lone high surrogate')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('lone low surrogate')
    }
  }
}

class StrictJsonParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace()
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.source.length) throw new Error('unexpected trailing JSON content')
    return value
  }

  private parseValue(): unknown {
    this.skipWhitespace()
    const char = this.source[this.index]
    if (char === '{') return this.parseObject()
    if (char === '[') return this.parseArray()
    if (char === '"') return this.parseString()
    if (char === 't') return this.parseLiteral('true', true)
    if (char === 'f') return this.parseLiteral('false', false)
    if (char === 'n') return this.parseLiteral('null', null)
    return this.parseNumber()
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1
    const result: Record<string, unknown> = {}
    const seen = new Set<string>()
    this.skipWhitespace()
    if (this.source[this.index] === '}') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      const key = this.parseString()
      if (seen.has(key)) throw new Error(`duplicate JSON object key: ${key}`)
      seen.add(key)
      this.skipWhitespace()
      if (this.source[this.index] !== ':') throw new Error('expected colon')
      this.index += 1
      result[key] = this.parseValue()
      this.skipWhitespace()
      const separator = this.source[this.index]
      if (separator === '}') {
        this.index += 1
        return result
      }
      if (separator !== ',') throw new Error('expected comma or object end')
      this.index += 1
    }
  }

  private parseArray(): unknown[] {
    this.index += 1
    const result: unknown[] = []
    this.skipWhitespace()
    if (this.source[this.index] === ']') {
      this.index += 1
      return result
    }
    for (;;) {
      result.push(this.parseValue())
      this.skipWhitespace()
      const separator = this.source[this.index]
      if (separator === ']') {
        this.index += 1
        return result
      }
      if (separator !== ',') throw new Error('expected comma or array end')
      this.index += 1
    }
  }

  private parseString(): string {
    if (this.source[this.index] !== '"') throw new Error('expected JSON string')
    const start = this.index
    this.index += 1
    let escaped = false
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      if (!escaped && char === '"') {
        this.index += 1
        const value = JSON.parse(this.source.slice(start, this.index)) as string
        assertNoLoneSurrogates(value)
        return value
      }
      if (!escaped && char === '\\') escaped = true
      else escaped = false
      this.index += 1
    }
    throw new Error('unterminated JSON string')
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!match) throw new Error('invalid JSON number')
    this.index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number')
    return value
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) throw new Error(`expected ${literal}`)
    this.index += literal.length
    return value
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1
  }
}
