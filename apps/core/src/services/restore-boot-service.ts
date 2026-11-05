import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inventoryDirectory } from '../lifecycle/restore-filesystem'
import {
  chooseJournal,
  fsyncDirectory,
  parseRestoreMarker,
  type RestoreJournal,
  type RestoreJournalStore,
  type RestoreMarker,
  sha256Canonical,
} from '../lifecycle/restore-journal'
import type { RestoreArchiveService } from './restore-archive-service'

export type RestoreBootLogger = {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export type RestoreBootScene =
  | { kind: 'none' }
  | { kind: 'locked'; reason: string }
  | { kind: 'abandoned'; journal: RestoreJournal }
  | { kind: 'aborted'; journal: RestoreJournal }
  | { kind: 'forward'; journal: RestoreJournal }
  | { kind: 'rollback'; journal: RestoreJournal }
  | { kind: 'reconcile'; journal: RestoreJournal }
  | {
      kind: 'terminal'
      journal: RestoreJournal
      phase: 'completed' | 'rolled_back' | 'aborted'
    }

const TERMINAL_PHASES = new Set(['completed', 'rolled_back', 'aborted'])

const FORWARD_PHASES = new Set([
  'handed_off',
  'capture',
  'capture_verified',
  'forward_replacement',
  'replaced',
  'self_row_fixing',
])

const RECONCILE_PHASES = new Set(['reconciling', 'verifying', 'verified'])

const POST_HANDOFF_PHASES = new Set([
  ...FORWARD_PHASES,
  ...RECONCILE_PHASES,
  'completed',
  'rollback_in_progress',
  'rolled_back',
  'rollback_failed',
])

/**
 * S55-2C 新 Core 启动恢复模式（v17 §2 激活矩阵 A0–A10）。
 *
 * 只读判定 + 允许的最小写动作（A3 补写 confirmed、A0 未激活归档、终态收尾）。
 * 任何无法证明的现场一律 recovery_locked；不重建 marker、不重做文件替换。
 */
export class RestoreBootService {
  constructor(
    private readonly store: RestoreJournalStore,
    private readonly archive: RestoreArchiveService,
    private readonly archiveRoot: string,
    private readonly logger?: RestoreBootLogger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  detect(): RestoreBootScene {
    const a = this.store.readCopy(this.store.paths.journalA)
    const b = this.store.readCopy(this.store.paths.journalB)
    const markerExists = fs.existsSync(this.store.paths.activeMarker)
    const anyJournal = a.kind !== 'missing' || b.kind !== 'missing'
    if (!anyJournal && !markerExists) return { kind: 'none' }
    if (!anyJournal) {
      // A10：marker 在而 Journal 缺失——事务依据不存在。
      return this.locked('marker_without_journal')
    }

    let journal: RestoreJournal
    try {
      const chosen = chooseJournal(a, b, (candidate) => this.validateScene(candidate))
      journal = chosen.journal
      if (chosen.degraded) {
        this.logger?.warn('restore journal degraded; repairing lower copy', {
          journalId: journal.journalId,
          globalRevision: journal.globalRevision,
        })
        this.store.writeNext(
          journal,
          () => {
            // 只触发双副本重写；内容不变，revision 单调 +1。
          },
          this.now(),
        )
      }
    } catch (error) {
      this.logger?.error('restore journal arbitration failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return this.locked('journal_arbitration_failed')
    }

    let marker: RestoreMarker | null = null
    if (markerExists) {
      try {
        marker = parseRestoreMarker(fs.readFileSync(this.store.paths.activeMarker, 'utf8'))
      } catch (error) {
        this.logger?.error('active marker is invalid', { error: String(error) })
        return this.locked('marker_invalid')
      }
      if (marker.journalId !== journal.journalId || marker.backupId !== journal.backupId) {
        return this.locked('marker_identity_mismatch')
      }
    }

    const intent = journal.activationIntent
    const confirmed = journal.activationConfirmed
    if (!intent && !confirmed) {
      if (journal.phase === 'requested' && !marker) {
        return { kind: 'abandoned', journal }
      }
      return this.locked('activation_missing')
    }
    if (intent && !confirmed) {
      if (!marker) return this.locked('activation_intent_without_marker') // A2
      // A3：marker 与 intent 逐项验证通过后才补写 confirmed；绝不重建 marker。
      try {
        journal = this.store.verifyAndConfirmActivation(journal, this.now())
      } catch (error) {
        this.logger?.error('activation confirmation failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return this.locked('activation_confirm_failed')
      }
    }

    if (!marker) {
      if (!TERMINAL_PHASES.has(journal.phase)) {
        return this.locked('confirmed_without_marker') // A6
      }
      // A8：终态收尾，不重复 forward/rollback。
      return {
        kind: 'terminal',
        journal,
        phase: journal.phase as 'completed' | 'rolled_back' | 'aborted',
      }
    }

    if (TERMINAL_PHASES.has(journal.phase)) {
      // A7：终态收尾。
      return {
        kind: 'terminal',
        journal,
        phase: journal.phase as 'completed' | 'rolled_back' | 'aborted',
      }
    }
    if (FORWARD_PHASES.has(journal.phase)) return { kind: 'forward', journal }
    if (RECONCILE_PHASES.has(journal.phase)) return { kind: 'reconcile', journal }
    if (journal.phase === 'rollback_in_progress') return { kind: 'rollback', journal }
    if (journal.phase === 'rollback_failed' || journal.phase === 'recovery_locked') {
      return this.locked(`journal_${journal.phase}`)
    }
    // requested / prepared / drained：老 Core 未完成 handoff，live 未被替换 → aborted 收尾。
    return { kind: 'aborted', journal }
  }

  /** A0 未激活 Journal：无激活证据，不能生成 TerminalSnapshotV1；归档到 abandoned。 */
  archiveAbandoned(journal: RestoreJournal): RestoreJournal {
    const aborted = this.store.writeNext(
      journal,
      (draft) => {
        draft.phase = 'aborted'
        draft.lastError = {
          code: 'RESTORE_ABANDONED_UNACTIVATED',
          message: 'restore journal was never activated',
        }
      },
      this.now(),
    )
    const destination = path.join(this.archiveRoot, 'abandoned', journal.journalId)
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const [source, name] of [
      [this.store.paths.journalA, 'journal.a.json'],
      [this.store.paths.journalB, 'journal.b.json'],
    ] as const) {
      if (!fs.existsSync(source)) continue
      const target = path.join(destination, name)
      fs.renameSync(source, target)
      fsyncDirectory(path.dirname(source))
      fsyncDirectory(destination)
    }
    if (fs.existsSync(this.store.paths.activeMarker)) {
      fs.unlinkSync(this.store.paths.activeMarker)
      fsyncDirectory(path.dirname(this.store.paths.activeMarker))
    }
    this.logger?.warn('unactivated restore journal archived as abandoned', {
      journalId: journal.journalId,
      path: destination,
    })
    return aborted
  }

  /** 老 Core 未 handoff / 启动期崩溃：正式 aborted 终态（snapshot+Archive+退役）。 */
  abortBeforeReplacement(journal: RestoreJournal): RestoreJournal {
    return this.archive.finalizeTerminal(journal, 'aborted', {
      abortedAtBoot: true,
      previousPhase: journal.phase,
    })
  }

  /** A7/A8 终态收尾：验证/补建 Archive，删除 marker，退役 active Journal；不重复替换。 */
  finalizeTerminal(journal: RestoreJournal): RestoreJournal {
    if (!journal.terminalSnapshot) {
      throw new Error('terminal journal is missing TerminalSnapshotV1')
    }
    return this.archive.finalizeTerminal(
      journal,
      journal.phase as 'completed' | 'rolled_back' | 'aborted',
      journal.terminalSnapshot.dataVerificationEvidence,
    )
  }

  /** 记录 reconciliation 完成（reconciling → verifying）。 */
  markReconciled(journal: RestoreJournal): RestoreJournal {
    if (journal.phase === 'verifying' || journal.phase === 'verified') return journal
    return this.store.writeNext(
      journal,
      (draft) => {
        draft.steps.reconciled = true
        draft.phase = 'verifying'
      },
      this.now(),
    )
  }

  /** 记录数据验证完成（verifying → verified）。证据随 completed 的 TerminalSnapshot 固化。 */
  markVerified(journal: RestoreJournal): RestoreJournal {
    if (journal.phase === 'verified') return journal
    return this.store.writeNext(
      journal,
      (draft) => {
        draft.steps.verified = true
        draft.phase = 'verified'
      },
      this.now(),
    )
  }

  /** 写入 verified 之后的固定终态数据证据并完成 completed 收尾。 */
  completeRestore(journal: RestoreJournal, evidence: Record<string, unknown>): RestoreJournal {
    const verified = journal.phase === 'verified' ? journal : this.markVerified(journal)
    return this.archive.finalizeTerminal(verified, 'completed', evidence)
  }

  /**
   * completed 前的数据验证（v17 verifying）：DB integrity_check、self-row/pre_restore 登记、
   * Artifact 树与备份 manifest 全等。任一失败 → 由调用方 recovery_locked。
   */
  verifyRestoredData(
    journal: RestoreJournal,
    databaseFile: string,
    artifactsRoot: string,
  ): Record<string, unknown> {
    if (!journal.preRestoreBackupId) throw new Error('pre_restore backup id missing')
    if (!journal.targetBackupPath) throw new Error('target backup path missing')
    const db = new DatabaseSync(databaseFile, { readOnly: true })
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      if (integrity.integrity_check !== 'ok') {
        throw new Error('restored database integrity_check failed')
      }
      const restored = db
        .prepare('SELECT status FROM backups WHERE id = ?')
        .get(journal.backupId) as { status?: string } | undefined
      if (restored?.status !== 'restored') {
        throw new Error('restored self-row is not in restored state')
      }
      const pre = db
        .prepare('SELECT status FROM backups WHERE id = ?')
        .get(journal.preRestoreBackupId) as { status?: string } | undefined
      if (pre?.status !== 'verified') {
        throw new Error('pre_restore row is not verified in restored database')
      }
    } finally {
      db.close()
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(journal.targetBackupPath, 'manifest.json'), 'utf8'),
    ) as { artifacts: Array<{ path: string; sha256: string; bytes: number }> }
    const inventory = inventoryDirectory(artifactsRoot)
    const actual = inventory.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.relativePath, sha256: entry.sha256, bytes: entry.bytes }))
      .sort((left, right) => left.path.localeCompare(right.path))
    const expected = [...manifest.artifacts].sort((left, right) =>
      left.path.localeCompare(right.path),
    )
    if (expected.length !== actual.length) throw new Error('restored Artifact count mismatch')
    for (let index = 0; index < expected.length; index += 1) {
      const left = expected[index]
      const right = actual[index]
      if (
        !left ||
        !right ||
        left.path !== right.path ||
        left.sha256 !== right.sha256 ||
        left.bytes !== right.bytes
      ) {
        throw new Error('restored Artifact manifest mismatch')
      }
    }
    return {
      databaseIntegrity: 'ok',
      selfRowStatus: 'restored',
      preRestoreStatus: 'verified',
      artifactFiles: actual.length,
      artifactsManifestSha256: sha256Canonical(actual),
      verifiedAt: this.now(),
    }
  }

  private validateScene(journal: RestoreJournal): boolean {
    if (journal.activationConfirmed && !journal.activationIntent) return false
    if (POST_HANDOFF_PHASES.has(journal.phase)) {
      if (!journal.steps.preRestoreVerified || !journal.preRestoreBackupId) return false
      if (!journal.steps.drained || !journal.steps.handedOff) return false
    }
    if (journal.phase === 'rollback_in_progress' || TERMINAL_PHASES.has(journal.phase)) {
      if (!journal.steps.captureVerified && journal.phase !== 'aborted') return false
    }
    if (journal.phase === 'completed' && !journal.steps.verified) return false
    if (TERMINAL_PHASES.has(journal.phase) && !journal.terminalSnapshot) return false
    return true
  }

  private locked(reason: string): RestoreBootScene {
    this.logger?.error('restore boot scene is not provable; entering recovery_locked', { reason })
    return { kind: 'locked', reason }
  }
}
