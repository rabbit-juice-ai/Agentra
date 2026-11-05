import fs from 'node:fs'
import path from 'node:path'
import {
  archivePayloadSha256,
  canonicalJson,
  createTerminalSnapshot,
  fsyncDirectory,
  parseJsonNoDuplicateKeys,
  type RestoreArchivePayload,
  RestoreArchivePayloadSchema,
  type RestoreJournal,
  type RestoreJournalStore,
  type RestoreTerminalSnapshot,
  sha256Canonical,
  sha256File,
  terminalSnapshotSha256,
} from '../lifecycle/restore-journal'

/** S55-2C protocol-level immutable Archive lifecycle. */
export class RestoreArchiveService {
  constructor(
    private readonly store: RestoreJournalStore,
    private readonly retiredRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** v17 terminal 收尾序：snapshot → Archive verified A/B → retired manifest → marker → 退役 Journal。 */
  finalizeTerminal(
    journal: RestoreJournal,
    terminalPhase: 'completed' | 'rolled_back' | 'aborted',
    evidence: Record<string, unknown>,
  ): RestoreJournal {
    let next = this.persistTerminal(journal, terminalPhase, evidence)
    next = this.createAndVerify(next)
    next = this.writeRetiredManifest(next)
    this.removeActiveMarker(next)
    this.retireActiveJournals(next)
    return next
  }

  persistTerminal(
    journal: RestoreJournal,
    terminalPhase: 'completed' | 'rolled_back' | 'aborted',
    evidence: Record<string, unknown>,
  ): RestoreJournal {
    if (journal.terminalSnapshot) return journal
    const terminalAt = this.now()
    const snapshot = createTerminalSnapshot(journal, {
      terminalPhase,
      dataVerificationEvidence: evidence,
      terminalAt,
    })
    const hash = terminalSnapshotSha256(snapshot)
    return this.store.writeNext(
      journal,
      (draft) => {
        draft.phase = terminalPhase
        draft.terminalSnapshot = snapshot
        draft.terminalSnapshotSha256 = hash
        draft.terminalSourceGlobalRevision = journal.globalRevision + 1
      },
      terminalAt,
    )
  }

  createAndVerify(journal: RestoreJournal): RestoreJournal {
    const snapshot = this.requireSnapshot(journal)
    const snapshotHash = terminalSnapshotSha256(snapshot)
    if (snapshotHash !== journal.terminalSnapshotSha256 || !journal.terminalSourceGlobalRevision) {
      throw new Error('terminal snapshot hash/revision mismatch')
    }
    const archiveDirectory = path.join(this.store.paths.archiveRoot, journal.journalId)
    const archivePath = path.join(archiveDirectory, 'journal.json')
    if (!journal.archiveIntent) {
      journal = this.store.writeNext(
        journal,
        (draft) => {
          draft.archiveIntent = {
            archiveVersion: 1,
            journalId: journal.journalId,
            terminalSourceGlobalRevision: journal.terminalSourceGlobalRevision as number,
            terminalSnapshotSha256: snapshotHash,
            targetPath: archivePath,
          }
        },
        this.now(),
      )
    }
    const sourceRevision = journal.terminalSourceGlobalRevision as number
    const payload: RestoreArchivePayload = {
      archiveVersion: 1,
      journalId: journal.journalId,
      terminalSourceGlobalRevision: sourceRevision,
      terminalSnapshot: snapshot,
      terminalSnapshotSha256: snapshotHash,
    }
    const expectedPayloadHash = archivePayloadSha256(payload)
    if (!fs.existsSync(archivePath)) durableWrite(archivePath, `${canonicalJson(payload)}\n`)
    else if (archivePayloadSha256(this.readArchive(archivePath)) !== expectedPayloadHash) {
      throw new Error('formal Archive conflicts with fixed terminal snapshot')
    }
    const archiveFileHash = sha256File(archivePath)
    if (journal.archiveRecord?.status === 'verified') {
      this.assertVerifiedArchive(journal, archivePath)
      return journal
    }
    if (!journal.archiveRecord || journal.archiveRecord.status === 'intent') {
      journal = this.store.writeNext(
        journal,
        (draft) => {
          draft.archiveRecord = {
            status: 'recorded',
            path: archivePath,
            sourceGlobalRevision: journal.terminalSourceGlobalRevision as number,
            terminalSnapshotSha256: snapshotHash,
            actualArchiveSha256: archiveFileHash,
            verifiedAt: null,
            retiredManifest: null,
          }
        },
        this.now(),
      )
    }
    const finalPayload = this.readArchive(archivePath)
    if (
      archivePayloadSha256(finalPayload) !== expectedPayloadHash ||
      sha256File(archivePath) !== journal.archiveRecord?.actualArchiveSha256
    ) {
      throw new Error('Archive final readback failed')
    }
    journal = this.store.writeNext(
      journal,
      (draft) => {
        if (!draft.archiveRecord) throw new Error('Archive record missing')
        draft.archiveRecord.status = 'verified'
        draft.archiveRecord.verifiedAt = this.now()
      },
      this.now(),
    )
    this.assertVerifiedArchive(journal, archivePath)
    return journal
  }

  writeRetiredManifest(journal: RestoreJournal): RestoreJournal {
    if (journal.archiveRecord?.status !== 'verified') {
      throw new Error('retirement requires verified Archive')
    }
    if (journal.archiveRecord.retiredManifest) return journal
    const nextRevision = journal.globalRevision + 1
    const projection = structuredClone(journal)
    projection.globalRevision = nextRevision
    projection.updatedAt = this.now()
    if (!projection.archiveRecord) throw new Error('Archive record missing')
    projection.archiveRecord.retiredManifest = null
    const digest = sha256Canonical(projection)
    return this.store.writeNext(
      journal,
      (draft) => {
        if (!draft.archiveRecord) throw new Error('Archive record missing')
        draft.archiveRecord.retiredManifest = {
          canonicalForm: 1,
          journalASha256: digest,
          journalBSha256: digest,
        }
      },
      projection.updatedAt,
    )
  }

  removeActiveMarker(journal: RestoreJournal): void {
    if (journal.archiveRecord?.status !== 'verified' || !journal.archiveRecord.retiredManifest) {
      throw new Error('marker removal requires verified Archive and retirement manifest')
    }
    if (fs.existsSync(this.store.paths.activeMarker)) {
      fs.unlinkSync(this.store.paths.activeMarker)
      fsyncDirectory(path.dirname(this.store.paths.activeMarker))
    }
  }

  retireActiveJournals(journal: RestoreJournal): void {
    const manifest = journal.archiveRecord?.retiredManifest
    if (!manifest) throw new Error('retirement manifest missing')
    const destination = path.join(this.retiredRoot, journal.journalId)
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    this.retireOne(
      this.store.paths.journalA,
      path.join(destination, 'journal.a.json'),
      manifest.journalASha256,
    )
    this.retireOne(
      this.store.paths.journalB,
      path.join(destination, 'journal.b.json'),
      manifest.journalBSha256,
    )
    // 退役副本验证通过并删除后，容器目录仅剩空壳；残留内容说明出现清单外写入。
    try {
      fs.rmdirSync(destination)
    } catch {
      // 非空或不可删不改变退役结果；Archive 已保留全部事实。
    }
  }

  private retireOne(source: string, target: string, expectedProjectionHash: string): void {
    if (fs.existsSync(source)) {
      const parsed = this.parseJournalForRetirement(source)
      if (this.retirementProjectionHash(parsed) !== expectedProjectionHash) {
        throw new Error(`active Journal retirement projection mismatch: ${source}`)
      }
      fs.renameSync(source, target)
      fsyncDirectory(path.dirname(source))
      fsyncDirectory(path.dirname(target))
    }
    if (!fs.existsSync(target)) {
      // 已退役且已删除：Archive 保留全部事实；重放收尾必须幂等。
      if (!fs.existsSync(source)) return
      throw new Error(`retired Journal missing: ${target}`)
    }
    const retired = this.parseJournalForRetirement(target)
    if (this.retirementProjectionHash(retired) !== expectedProjectionHash) {
      throw new Error(`retired Journal projection mismatch: ${target}`)
    }
    fs.unlinkSync(target)
    fsyncDirectory(path.dirname(target))
  }

  private retirementProjectionHash(journal: RestoreJournal): string {
    const projection = structuredClone(journal)
    if (!projection.archiveRecord) throw new Error('Archive record missing')
    projection.archiveRecord.retiredManifest = null
    return sha256Canonical(projection)
  }

  private parseJournalForRetirement(file: string): RestoreJournal {
    const copy = this.store.readCopy(file)
    if (copy.kind !== 'valid') throw new Error(`retirement Journal is invalid: ${file}`)
    return copy.journal
  }

  private requireSnapshot(journal: RestoreJournal): RestoreTerminalSnapshot {
    if (!journal.terminalSnapshot) throw new Error('terminal snapshot missing')
    return journal.terminalSnapshot
  }

  private readArchive(file: string): RestoreArchivePayload {
    return RestoreArchivePayloadSchema.parse(
      parseJsonNoDuplicateKeys(fs.readFileSync(file, 'utf8')),
    )
  }

  private assertVerifiedArchive(journal: RestoreJournal, file: string): void {
    const record = journal.archiveRecord
    if (record?.status !== 'verified' || !record.actualArchiveSha256) {
      throw new Error('Archive is not verified in Journal A/B')
    }
    if (!fs.existsSync(file) || sha256File(file) !== record.actualArchiveSha256) {
      throw new Error('verified Archive changed or disappeared')
    }
    const payload = this.readArchive(file)
    if (
      payload.journalId !== journal.journalId ||
      payload.terminalSourceGlobalRevision !== record.sourceGlobalRevision ||
      payload.terminalSnapshotSha256 !== record.terminalSnapshotSha256 ||
      terminalSnapshotSha256(payload.terminalSnapshot) !== record.terminalSnapshotSha256
    ) {
      throw new Error('verified Archive identity/content mismatch')
    }
  }
}

function durableWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
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
}
