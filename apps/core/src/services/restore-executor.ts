import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentraPaths } from '@agentra/shared'
import { transaction } from '../db/database'
import { type BackupArtifactFile, BackupRepository } from '../db/repositories/backup-repository'
import {
  assertAnchor,
  assertInventoryContent,
  assertPathInside,
  assertSameDevice,
  availableBytes,
  controlledRemoveTree,
  durableCopyFile,
  durableCopyTree,
  durableRename,
  durableRenameDirectory,
  durableUnlink,
  inventoryDirectory,
  lstatAnchor,
  type RenameDirectoryIntent,
  type RenameIntent,
  RestoreFilesystemError,
  RestoreLockedError,
  type UnlinkCompleteEvidence,
  type UnlinkIntent,
  verifyRenameDirectoryReplay,
  verifyRenameReplay,
} from '../lifecycle/restore-filesystem'
import type {
  RestoreFileAnchor,
  RestoreJournal,
  RestoreJournalStore,
  RestoreManifestEntry,
  RestoreOperation,
} from '../lifecycle/restore-journal'
import type { BackupManifest } from './backup-service'

export type RestoreExecutorLogger = {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/** S55-2C 故障注入（①–㊿）：在持久化拍点之间模拟进程崩溃。 */
export type RestoreExecutorFaultPoint =
  | 'after-capture-db-verified'
  | 'after-capture-art-verified'
  | 'after-forward-prepare-db'
  | 'after-forward-prepare-art'
  | 'after-sidecar-wal-op-created'
  | 'after-sidecar-shm-op-created'
  | 'after-sidecar-wal-intent'
  | 'after-sidecar-shm-intent'
  | 'after-sidecar-wal'
  | 'after-sidecar-shm'
  | 'after-f-db-rename'
  | 'after-f-art-remove'
  | 'after-f-art-rename'
  | 'after-self-row'
  | 'after-rb-stage-db'
  | 'after-rb-stage-art'
  | 'after-rb-db-rename'
  | 'after-rb-art-rename'

export class RestoreSimulatedCrash extends Error {
  constructor(readonly point: RestoreExecutorFaultPoint) {
    super(`simulated crash at ${point}`)
    this.name = 'RestoreSimulatedCrash'
  }
}

export type RestoreExecutionResult = {
  journal: RestoreJournal
  restored: boolean
  rolledBack: boolean
}

/**
 * v17 崩溃重放：新 Core 启动时按 Journal phase 从正确步骤继续，不重复已完成的阶段。
 * 只对 forward 链定义序号；rollback/终态由启动编排单独分派。
 */
const FORWARD_PHASE_RANK: Readonly<Partial<Record<RestoreJournal['phase'], number>>> = {
  handed_off: 0,
  capture: 1,
  capture_verified: 2,
  forward_replacement: 3,
  replaced: 4,
  self_row_fixing: 5,
  reconciling: 6,
  verifying: 7,
  verified: 8,
  completed: 9,
}

function forwardRank(phase: RestoreJournal['phase']): number {
  return FORWARD_PHASE_RANK[phase] ?? 99
}

/**
 * S55-2C startup Restore executor.
 *
 * Runs in the new Core while MaintenanceController is booting/recovering and before the
 * business socket becomes normal. capturedRollback is independent and never consumed;
 * rollback always copies RB into rollback-staged before installation.
 */
export class RestoreExecutor {
  private journal: RestoreJournal

  constructor(
    private readonly paths: AgentraPaths,
    private readonly store: RestoreJournalStore,
    journal: RestoreJournal,
    private readonly logger?: RestoreExecutorLogger,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly faultHook?: (point: RestoreExecutorFaultPoint) => void,
  ) {
    this.journal = journal
  }

  private fault(point: RestoreExecutorFaultPoint): void {
    this.faultHook?.(point)
  }

  execute(): RestoreExecutionResult {
    if (!this.journal.targetBackupPath) {
      throw new RestoreFilesystemError('PATH_UNSAFE', 'target backup path missing from Journal')
    }
    if (forwardRank(this.journal.phase) === 99) {
      throw new RestoreFilesystemError(
        'TARGET_CONFLICT',
        `execute() is not valid in phase ${this.journal.phase}`,
      )
    }
    const targetBackupPath = assertPathInside(this.journal.targetBackupPath, this.paths.backups)
    const manifest = this.readManifest(targetBackupPath)
    try {
      this.assertSpace(manifest)
      if (forwardRank(this.journal.phase) <= forwardRank('capture')) this.captureRollback()
      if (forwardRank(this.journal.phase) <= forwardRank('capture_verified')) {
        this.prepareForward(targetBackupPath, manifest)
      }
      if (forwardRank(this.journal.phase) <= forwardRank('forward_replacement')) {
        this.installForward(manifest)
      }
      if (forwardRank(this.journal.phase) <= forwardRank('self_row_fixing')) {
        this.fixRestoredDatabase(manifest)
      }
      return { journal: this.journal, restored: true, rolledBack: false }
    } catch (error) {
      if (error instanceof RestoreSimulatedCrash) throw error
      if (error instanceof RestoreLockedError) {
        // v17 ㊼/㉝：归属或身份不可证明 → 停止一切文件操作，保留现场并锁定。
        this.journal = this.store.writeNext(
          this.journal,
          (draft) => {
            draft.phase = 'recovery_locked'
            draft.lastError = { code: error.code, message: error.message }
          },
          this.now(),
        )
        this.logger?.error('Restore locked: durable evidence cannot prove attribution', {
          journalId: this.journal.journalId,
          code: error.code,
          error: error.message,
        })
        throw error
      }
      this.logger?.error('forward Restore failed; starting rollback', {
        error: error instanceof Error ? error.message : String(error),
      })
      if (!this.journal.steps.captureVerified) throw error
      this.rollback(error)
      return { journal: this.journal, restored: false, rolledBack: true }
    }
  }

  /** v17：新 Core 发现 directionLock=rollback 且 phase=rollback_in_progress 时继续回滚。 */
  resumeRollback(): RestoreJournal {
    if (this.journal.phase !== 'rollback_in_progress') {
      throw new RestoreFilesystemError(
        'TARGET_CONFLICT',
        `resumeRollback() requires rollback_in_progress (got ${this.journal.phase})`,
      )
    }
    this.rollback(new Error('resume rollback after crash'))
    return this.journal
  }

  private captureRollback(): void {
    if (this.journal.steps.captureVerified) {
      this.verifyCapturedRollback()
      return
    }
    this.transition('capture')
    const rollbackDb = path.join(this.paths.restoreCapturedRollback, 'db', 'agentra.db')
    const rollbackArtifacts = path.join(this.paths.restoreCapturedRollback, 'artifacts')

    const capDb = this.operation('cap-db-1')
    if (capDb?.status === 'verified') {
      // v17 ⑨：DB 已捕获并验证——只重验 RB 副本，不重拷。
      const anchor = lstatAnchor(rollbackDb)
      if (anchor.type !== 'regular-file' || anchor.sha256 !== capDb.actualSha256) {
        throw new RestoreFilesystemError('HASH_MISMATCH', 'captured rollback DB changed on replay')
      }
      this.assertDatabaseIntegrity(rollbackDb)
    } else {
      // v17 ⑦/⑩：先重验 live source，再删除协议控制的半成品，然后重拷。
      const liveDbAnchor = lstatAnchor(this.paths.database)
      if (capDb?.sourceAnchor) assertAnchor(liveDbAnchor, capDb.sourceAnchor)
      this.removePartialFile(rollbackDb)
      const opRecord = this.addOperation(
        operation('cap-db-1', 'capture', 'db', 'live', this.paths.database, rollbackDb),
      )
      this.updateOperation(opRecord.operationId, (op) => {
        op.sourceAnchor = liveDbAnchor
        op.intentState = 'capture_intent'
        op.status = 'capturing'
      })
      const dbAnchor = durableCopyFile(this.paths.database, rollbackDb, liveDbAnchor)
      this.updateOperation(opRecord.operationId, (op) => {
        op.targetAnchor = dbAnchor
        op.actualSha256 = dbAnchor.sha256
        op.status = 'verified'
      })
      this.assertDatabaseIntegrity(rollbackDb)
    }
    this.fault('after-capture-db-verified')

    const capArt = this.operation('cap-art-1')
    if (capArt?.status === 'verified') {
      if (!capArt.actualManifest) throw new Error('captured Artifact manifest missing')
      assertInventoryContent(inventoryDirectory(rollbackArtifacts), {
        root: capArt.targetAnchor as never,
        entries: capArt.actualManifest,
      })
    } else {
      // v17 ⑪：live 清单必须与捕获 intent 时一致，半成品目录只允许在 live 复验后清理。
      const liveInventory = inventoryDirectory(this.paths.artifacts)
      if (capArt?.directoryInventory) {
        assertInventoryContent(liveInventory, capArt.directoryInventory, { compareIdentity: true })
      }
      this.removePartialTree(rollbackArtifacts)
      const opRecord = this.addOperation(
        operation(
          'cap-art-1',
          'capture',
          'artifacts',
          'live',
          this.paths.artifacts,
          rollbackArtifacts,
        ),
      )
      this.updateOperation(opRecord.operationId, (op) => {
        op.directoryInventory = liveInventory
        op.expectedManifest = liveInventory.entries
        op.intentState = 'capture_intent'
        op.status = 'capturing'
      })
      const capturedInventory = durableCopyTree(
        this.paths.artifacts,
        rollbackArtifacts,
        liveInventory,
      )
      this.updateOperation(opRecord.operationId, (op) => {
        op.actualManifest = capturedInventory.entries
        op.targetAnchor = capturedInventory.root
        op.status = 'verified'
      })
    }
    this.fault('after-capture-art-verified')

    this.verifyCapturedRollback()
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        draft.phase = 'capture_verified'
        draft.steps.captureVerified = true
      },
      this.now(),
    )
  }

  private removePartialFile(target: string): void {
    const anchor = lstatAnchor(target)
    if (anchor.type === 'absent') return
    if (anchor.type !== 'regular-file') {
      throw new RestoreFilesystemError(
        'TYPE_MISMATCH',
        `partial copy is not a regular file: ${target}`,
      )
    }
    durableUnlink({
      operationId: `partial-clean:${target}`,
      target,
      targetAnchor: anchor,
      parentAnchor: lstatAnchor(path.dirname(target)),
      journalRevision: this.journal.globalRevision,
    })
  }

  private removePartialTree(target: string): void {
    if (lstatAnchor(target).type === 'absent') return
    const inventory = inventoryDirectory(target)
    controlledRemoveTree(target, inventory, {
      ensureIntent: (entry, anchor) => ({
        operationId: `partial-clean:${target}:${entry.relativePath}`,
        target: anchor.path,
        targetAnchor: anchor,
        parentAnchor: lstatAnchor(path.dirname(anchor.path)),
        journalRevision: this.journal.globalRevision,
      }),
      recordComplete: () => {},
    })
  }

  private prepareForward(backupPath: string, manifest: BackupManifest): void {
    const stagedDb = path.join(this.paths.restoreForwardStaged, 'db', 'agentra.db')
    const stagedArtifacts = path.join(this.paths.restoreForwardStaged, 'artifacts')
    if (this.operation('f-prep-db-1')?.status !== 'verified') {
      const sourceDb = path.join(backupPath, manifest.database.file)
      const sourceAnchor = lstatAnchor(sourceDb)
      if (
        sourceAnchor.sha256 !== manifest.database.sha256 ||
        sourceAnchor.bytes !== manifest.database.bytes
      ) {
        throw new RestoreFilesystemError('HASH_MISMATCH', 'target backup database changed')
      }
      const prepDb = this.addOperation(
        operation('f-prep-db-1', 'forward_prepare', 'db', 'backup_package', sourceDb, stagedDb),
      )
      this.updateOperation(prepDb.operationId, (op) => {
        op.sourceAnchor = sourceAnchor
        op.expectedSha256 = manifest.database.sha256
        op.intentState = 'forward_prepare_intent'
        op.status = 'capturing'
      })
      // v17 ⑫：source 已重验；staged 半成品可清理后重拷。
      this.removePartialFile(stagedDb)
      const staged = durableCopyFile(sourceDb, stagedDb, sourceAnchor)
      this.assertDatabaseIntegrity(stagedDb)
      this.updateOperation(prepDb.operationId, (op) => {
        op.targetAnchor = staged
        op.actualSha256 = staged.sha256
        op.status = 'verified'
      })
      this.fault('after-forward-prepare-db')
    }
    if (this.operation('f-prep-art-1')?.status !== 'verified') {
      const sourceArtifacts = path.join(backupPath, 'artifacts')
      fs.mkdirSync(sourceArtifacts, { recursive: true, mode: 0o700 })
      const sourceInventory = inventoryDirectory(sourceArtifacts)
      this.assertManifestMatchesInventory(manifest.artifacts, sourceInventory.entries)
      // v17 ⑫：备份包只读且已在上面重验；staged 半成品可清理后重拷。
      this.removePartialTree(stagedArtifacts)
      const prepArt = this.addOperation(
        operation(
          'f-prep-art-1',
          'forward_prepare',
          'artifacts',
          'backup_package',
          sourceArtifacts,
          stagedArtifacts,
        ),
      )
      this.updateOperation(prepArt.operationId, (op) => {
        op.directoryInventory = sourceInventory
        op.expectedManifest = sourceInventory.entries
        op.intentState = 'forward_prepare_intent'
        op.status = 'capturing'
      })
      const stagedInventory = durableCopyTree(sourceArtifacts, stagedArtifacts, sourceInventory)
      this.updateOperation(prepArt.operationId, (op) => {
        op.actualManifest = stagedInventory.entries
        op.targetAnchor = stagedInventory.root
        op.status = 'verified'
      })
      this.fault('after-forward-prepare-art')
    }
  }

  private installForward(manifest: BackupManifest): void {
    this.transition('forward_replacement')
    this.removeSidecar('f-side-wal-1', `${this.paths.database}-wal`, 'wal')
    this.removeSidecar('f-side-shm-1', `${this.paths.database}-shm`, 'shm')

    if (this.operation('f-db-1')?.status !== 'done') {
      const source = path.join(this.paths.restoreForwardStaged, 'db', 'agentra.db')
      const intent = this.addFileRenameIntent(
        'f-db-1',
        source,
        this.paths.database,
        'forward_staged',
      )
      const installed = this.renameWithReplay(intent)
      this.fault('after-f-db-rename')
      this.updateOperation('f-db-1', (op) => {
        op.targetAnchor = installed
        op.actualSha256 = installed.sha256
        op.status = 'done'
      })
    }

    if (this.operation('f-art-1')?.status !== 'done') {
      const source = path.join(this.paths.restoreForwardStaged, 'artifacts')
      this.installArtifactTree('f-art-1', source, this.paths.artifacts, 'forward_staged')
    }
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        draft.phase = 'replaced'
        draft.steps.filesReplaced = true
      },
      this.now(),
    )
    // Re-verify installed target content against the selected backup manifest.
    const db = lstatAnchor(this.paths.database)
    if (db.sha256 !== manifest.database.sha256 || db.bytes !== manifest.database.bytes) {
      throw new RestoreFilesystemError('HASH_MISMATCH', 'installed database mismatch')
    }
    this.assertManifestMatchesInventory(
      manifest.artifacts,
      inventoryDirectory(this.paths.artifacts).entries,
    )
  }

  private fixRestoredDatabase(manifest: BackupManifest): void {
    this.transition('self_row_fixing')
    const pre = this.journal.preRestoreBackupRecord
    const preId = this.journal.preRestoreBackupId
    if (!pre || !preId || !this.journal.targetBackupPath) {
      throw new Error('Restore Journal is missing pre_restore registration data')
    }
    const db = new DatabaseSync(this.paths.database)
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      if (integrity.integrity_check !== 'ok')
        throw new Error('restored database integrity check failed')
      const backups = new BackupRepository(db)
      transaction(db, () => {
        backups.registerVerified({
          id: preId,
          type: 'pre_restore',
          manifestVersion: pre.manifestVersion,
          dbSha256: pre.dbSha256,
          files: pre.files,
          storagePath: pre.storagePath,
          createdAt: pre.createdAt,
          completedAt: pre.completedAt,
          verifiedAt: pre.verifiedAt,
        })
        const restored = backups.repairRestoredSelfRow(
          {
            id: this.journal.backupId,
            manifestVersion: manifest.manifestVersion,
            dbSha256: manifest.database.sha256,
            files: manifest.artifacts,
            storagePath: this.journal.targetBackupPath as string,
          },
          this.now(),
        )
        if (!restored)
          throw new Error(`backup self-row missing or conflicting: ${this.journal.backupId}`)
      })
    } finally {
      db.close()
    }
    this.fault('after-self-row')
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        draft.steps.selfRowFixed = true
        draft.phase = 'reconciling'
      },
      this.now(),
    )
  }

  private rollback(cause: unknown): void {
    if (this.journal.phase !== 'rollback_in_progress') {
      this.journal = this.store.writeNext(
        this.journal,
        (draft) => {
          draft.phase = 'rollback_in_progress'
          draft.directionLock = 'rollback'
          draft.lastError = {
            code: 'FORWARD_RESTORE_FAILED',
            message: cause instanceof Error ? cause.message : String(cause),
          }
        },
        this.now(),
      )
    }
    try {
      this.verifyCapturedRollback()
      const rollbackDb = path.join(this.paths.restoreCapturedRollback, 'db', 'agentra.db')
      const rollbackArtifacts = path.join(this.paths.restoreCapturedRollback, 'artifacts')
      const stagedDb = path.join(this.paths.restoreRollbackStaged, 'db', 'agentra.db')
      const stagedArtifacts = path.join(this.paths.restoreRollbackStaged, 'artifacts')

      if (this.operation('rb-stg-db-1')?.status !== 'rb_staged') {
        const rbAnchor = lstatAnchor(rollbackDb)
        const opRecord = this.addOperation(
          operation(
            'rb-stg-db-1',
            'rollback_stage',
            'db',
            'captured_rollback',
            rollbackDb,
            stagedDb,
          ),
        )
        this.updateOperation(opRecord.operationId, (op) => {
          op.sourceAnchor = rbAnchor
          op.intentState = 'rb_stage_intent'
          op.status = 'capturing'
        })
        this.removePartialFile(stagedDb)
        const staged = durableCopyFile(rollbackDb, stagedDb, rbAnchor)
        this.updateOperation(opRecord.operationId, (op) => {
          op.targetAnchor = staged
          op.actualSha256 = staged.sha256
          op.status = 'rb_staged'
        })
        this.fault('after-rb-stage-db')
      }
      if (this.operation('rb-stg-art-1')?.status !== 'rb_staged') {
        const rbInventory = inventoryDirectory(rollbackArtifacts)
        const opRecord = this.addOperation(
          operation(
            'rb-stg-art-1',
            'rollback_stage',
            'artifacts',
            'captured_rollback',
            rollbackArtifacts,
            stagedArtifacts,
          ),
        )
        this.updateOperation(opRecord.operationId, (op) => {
          op.directoryInventory = rbInventory
          op.intentState = 'rb_stage_intent'
          op.status = 'capturing'
        })
        this.removePartialTree(stagedArtifacts)
        const stagedInventory = durableCopyTree(rollbackArtifacts, stagedArtifacts, rbInventory)
        this.updateOperation(opRecord.operationId, (op) => {
          op.actualManifest = stagedInventory.entries
          op.targetAnchor = stagedInventory.root
          op.status = 'rb_staged'
        })
        this.fault('after-rb-stage-art')
      }

      this.removeSidecar('rb-side-wal-1', `${this.paths.database}-wal`, 'wal')
      this.removeSidecar('rb-side-shm-1', `${this.paths.database}-shm`, 'shm')
      if (this.operation('rb-db-1')?.status !== 'rb_verified') {
        const intent = this.addFileRenameIntent(
          'rb-db-1',
          stagedDb,
          this.paths.database,
          'rollback_staged',
        )
        const installed = this.renameWithReplay(intent)
        this.fault('after-rb-db-rename')
        this.updateOperation('rb-db-1', (op) => {
          op.targetAnchor = installed
          op.actualSha256 = installed.sha256
          op.status = 'rb_verified'
        })
      }
      if (this.operation('rb-art-1')?.status !== 'rb_verified') {
        this.installArtifactTree(
          'rb-art-1',
          stagedArtifacts,
          this.paths.artifacts,
          'rollback_staged',
        )
        this.updateOperation('rb-art-1', (op) => {
          op.status = 'rb_verified'
        })
      }
      this.verifyCapturedRollbackAgainstLive()
      this.journal = this.store.writeNext(
        this.journal,
        (draft) => {
          draft.phase = 'rolled_back'
        },
        this.now(),
      )
    } catch (error) {
      if (error instanceof RestoreSimulatedCrash) throw error
      this.journal = this.store.writeNext(
        this.journal,
        (draft) => {
          draft.phase = 'rollback_failed'
          draft.lastError = {
            code: 'RESTORE_ROLLBACK_FAILED',
            message: error instanceof Error ? error.message : String(error),
          }
        },
        this.now(),
      )
      throw error
    }
  }

  private installArtifactTree(
    operationId: string,
    source: string,
    target: string,
    sourceRole: RestoreOperation['sourceRole'],
  ): void {
    const existing = this.operation(operationId)
    // v17 ⑭/㉝：目录 rename 已生效但 operation 未记完成——只接受身份连续的 replay 现场。
    if (
      existing?.sourceAnchor &&
      existing.expectedManifest &&
      lstatAnchor(source).type === 'absent'
    ) {
      const replayIntent: RenameDirectoryIntent = {
        operationId,
        source,
        target,
        sourceAnchor: existing.sourceAnchor,
        sourceInventory: { root: existing.sourceAnchor, entries: existing.expectedManifest },
        targetPolicy: 'must_be_absent',
        sourceParentAnchor: existing.sourceParentAnchor ?? lstatAnchor(path.dirname(source)),
        targetParentAnchor: existing.targetParentAnchor ?? lstatAnchor(path.dirname(target)),
      }
      const installed = verifyRenameDirectoryReplay(replayIntent)
      this.updateOperation(operationId, (draft) => {
        draft.targetAnchor = installed.root
        draft.actualManifest = installed.entries
        draft.status = sourceRole === 'rollback_staged' ? 'rb_verified' : 'done'
      })
      return
    }
    const sourceInventory = inventoryDirectory(source)
    if (existing?.sourceAnchor && existing.expectedManifest) {
      // 重放：staged/RS 源在 intent 后必须身份连续。
      assertInventoryContent(
        sourceInventory,
        { root: existing.sourceAnchor, entries: existing.expectedManifest },
        { compareIdentity: true },
      )
    }
    if (!existing) {
      const op = this.addOperation(
        operation(
          operationId,
          sourceRole === 'rollback_staged' ? 'rollback_install' : 'forward_install',
          'artifacts',
          sourceRole,
          source,
          target,
        ),
      )
      const liveInventory =
        lstatAnchor(target).type === 'directory' ? inventoryDirectory(target) : null
      this.updateOperation(op.operationId, (draft) => {
        draft.sourceAnchor = sourceInventory.root
        draft.expectedManifest = sourceInventory.entries
        draft.directoryInventory = liveInventory
        draft.intentState =
          sourceRole === 'rollback_staged' ? 'rb_install_intent' : 'install_intent'
        draft.status = 'intent'
        draft.perFileUnlinks =
          liveInventory?.entries
            .filter((entry) => entry.type === 'file')
            .map((entry) => ({
              relativePath: entry.relativePath,
              targetAnchor: lstatAnchor(path.join(target, ...entry.relativePath.split('/'))),
              unlinkIntentRevision: this.journal.globalRevision + 1,
              completeEvidenceRevision: null,
              status: 'intent' as const,
            })) ?? []
      })
    }
    if (lstatAnchor(target).type === 'directory') {
      const op = this.operation(operationId)
      if (!op?.directoryInventory) throw new Error(`missing live inventory: ${operationId}`)
      const replay = existing
        ? (entry: RestoreManifestEntry): 'complete' | 'pending' | 'unknown' => {
            const file = this.operation(operationId)?.perFileUnlinks.find(
              (item) => item.relativePath === entry.relativePath,
            )
            if (!file) return 'unknown'
            return file.status === 'complete' && file.completeEvidenceRevision !== null
              ? 'complete'
              : 'pending'
          }
        : undefined
      controlledRemoveTree(target, op.directoryInventory, {
        ensureIntent: (entry, anchor) => {
          const file = this.operation(operationId)?.perFileUnlinks.find(
            (item) => item.relativePath === entry.relativePath,
          )
          if (!file) throw new Error(`unlink intent missing: ${entry.relativePath}`)
          return {
            operationId: `${operationId}:unlink:${entry.relativePath}`,
            target: anchor.path,
            targetAnchor: file.targetAnchor,
            parentAnchor: lstatAnchor(path.dirname(anchor.path)),
            journalRevision: file.unlinkIntentRevision,
          }
        },
        recordComplete: (entry) => {
          this.updateOperation(operationId, (draft) => {
            const file = draft.perFileUnlinks.find(
              (item) => item.relativePath === entry.relativePath,
            )
            if (!file) throw new Error(`unlink record missing: ${entry.relativePath}`)
            file.status = 'complete'
            file.completeEvidenceRevision = this.journal.globalRevision + 1
          })
        },
        replay,
      })
    } else if (lstatAnchor(target).type !== 'absent') {
      throw new RestoreFilesystemError('TYPE_MISMATCH', `artifact target has wrong type: ${target}`)
    }
    this.fault('after-f-art-remove')
    const renameIntent: RenameDirectoryIntent = {
      operationId,
      source,
      target,
      sourceAnchor: sourceInventory.root,
      sourceInventory,
      targetPolicy: 'must_be_absent',
      sourceParentAnchor: lstatAnchor(path.dirname(source)),
      targetParentAnchor: lstatAnchor(path.dirname(target)),
    }
    const installed = durableRenameDirectory(renameIntent)
    this.fault(sourceRole === 'rollback_staged' ? 'after-rb-art-rename' : 'after-f-art-rename')
    this.updateOperation(operationId, (draft) => {
      draft.targetAnchor = installed.root
      draft.actualManifest = installed.entries
      draft.status = sourceRole === 'rollback_staged' ? 'rb_verified' : 'done'
    })
  }

  /**
   * v17 ㊼：WAL/SHM 删除归属判定。
   *
   * - 已有可信 completeEvidence（status=done 且 evidenceAnchor 存在）→ 按 Journal 记录确认完成；
   * - 存在 durable intent：
   *   A. target 缺失且无 completeEvidence → 归属不可证明 → recovery_locked，不补 evidence；
   *   B. target 存在但身份与持久 intent 不符 → recovery_locked，不覆盖 intent anchor；
   *   C. target 存在且身份全等 → 按原 intent 完整执行 15 步 unlink；
   * - 无 durable intent → 首次执行：先写 intent，再执行文件操作。
   */
  private removeSidecar(operationId: string, target: string, kind: 'wal' | 'shm'): void {
    const existing = this.operation(operationId)

    // P2-1：blocked 是终态诊断，任何重放都必须继续锁定；不得因 phase 写入失败升级为 done。
    if (existing?.status === 'blocked') {
      const prior =
        typeof existing.failureEvidence?.code === 'string'
          ? existing.failureEvidence.code
          : 'unknown'
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `sidecar operation is blocked (${prior}); replay refused`,
      )
    }

    // P1-1：done 重放必须重新验证 evidence 结构与当前文件系统现场，不得直接信任。
    if (existing?.status === 'done') {
      let doneAnchor: RestoreFileAnchor
      try {
        doneAnchor = lstatAnchor(target)
      } catch (error) {
        this.failSidecarLocked(
          operationId,
          'UNLINK_ATTRIBUTION_UNKNOWN',
          `sidecar scene cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.assertSidecarCompletionEvidence(operationId, target, existing, doneAnchor)
      return
    }

    const anchor = lstatAnchor(target)
    if (existing?.intentState === 'unlink_intent' || existing?.targetAnchor) {
      const intentAnchor = existing.targetAnchor
      if (!intentAnchor) {
        this.failSidecarLocked(
          operationId,
          'UNLINK_ATTRIBUTION_UNKNOWN',
          'sidecar has a durable intent without an anchor',
        )
      }
      if (intentAnchor.type === 'absent') {
        if (anchor.type !== 'absent') {
          this.failSidecarLocked(
            operationId,
            'TARGET_CONFLICT',
            'sidecar reappeared after an absent intent',
          )
        }
        this.updateOperation(operationId, (draft) => {
          draft.status = 'done'
          draft.evidenceAnchor = { targetAbsent: true, intentAnchorAbsent: true }
        })
        return
      }
      if (anchor.type === 'absent') {
        // A：intent 记录的是删除一个存在的文件；现在缺失且无 evidence——不得推断归属。
        this.failSidecarLocked(
          operationId,
          'UNLINK_ATTRIBUTION_UNKNOWN',
          'sidecar is missing without durable completion evidence',
        )
      }
      try {
        // B：与持久 intent anchor 全等才允许继续；永不覆盖原 anchor。
        assertAnchor(anchor, intentAnchor)
      } catch (error) {
        this.failSidecarLocked(
          operationId,
          'IDENTITY_MISMATCH',
          `sidecar identity changed after intent: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (kind === 'wal' && anchor.bytes !== 0) {
        this.failSidecarLocked(operationId, 'TARGET_CONFLICT', 'non-empty WAL after handoff')
      }
      // C：按持久 intent 完整执行 15 步 unlink。
      const intent: UnlinkIntent = {
        operationId,
        target,
        targetAnchor: intentAnchor,
        parentAnchor: lstatAnchor(path.dirname(target)),
        journalRevision: this.journal.globalRevision,
      }
      let evidence: UnlinkCompleteEvidence
      try {
        evidence = durableUnlink(intent)
      } catch (error) {
        if (error instanceof RestoreLockedError) throw error
        this.failSidecarLocked(
          operationId,
          error instanceof RestoreFilesystemError ? error.code : 'UNLINK_ATTRIBUTION_UNKNOWN',
          `sidecar unlink failed on replay: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.updateOperation(operationId, (draft) => {
        draft.status = 'done'
        draft.evidenceAnchor = evidence
      })
      return
    }

    // 首次执行：先持久化 intent，再执行文件操作。
    const op = this.addOperation(operation(operationId, 'sidecar', kind, 'none', null, target))
    this.fault(kind === 'wal' ? 'after-sidecar-wal-op-created' : 'after-sidecar-shm-op-created')
    // v17 §2.4「无 intent + target 缺失 → recovery_locked」：operation 已 durable 但
    // durable intent 尚未写入时，target 缺失无法证明是本协议删除；禁止补造 absent-intent
    // 或凭文件缺失标记 done。target 存在时才允许按首次执行流程建立 intent。
    if (existing && !existing.targetAnchor && anchor.type === 'absent') {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar operation is durable but its intent is missing and the target is absent',
      )
    }
    this.updateOperation(op.operationId, (draft) => {
      draft.targetAnchor = anchor
      draft.intentState = 'unlink_intent'
      draft.status = 'intent'
    })
    this.fault(kind === 'wal' ? 'after-sidecar-wal-intent' : 'after-sidecar-shm-intent')
    if (anchor.type === 'absent') {
      this.updateOperation(op.operationId, (draft) => {
        draft.status = 'done'
        draft.evidenceAnchor = { targetAbsent: true }
      })
      this.fault(kind === 'wal' ? 'after-sidecar-wal' : 'after-sidecar-shm')
      return
    }
    if (anchor.type !== 'regular-file') {
      throw new RestoreFilesystemError('TYPE_MISMATCH', `sidecar has wrong type: ${target}`)
    }
    if (kind === 'wal' && anchor.bytes !== 0) {
      throw new RestoreFilesystemError('TARGET_CONFLICT', 'non-empty WAL after handoff')
    }
    const intent: UnlinkIntent = {
      operationId,
      target,
      targetAnchor: anchor,
      parentAnchor: lstatAnchor(path.dirname(target)),
      journalRevision: this.journal.globalRevision,
    }
    const evidence = durableUnlink(intent)
    this.updateOperation(op.operationId, (draft) => {
      draft.status = 'done'
      draft.evidenceAnchor = evidence
    })
    this.fault(kind === 'wal' ? 'after-sidecar-wal' : 'after-sidecar-shm')
  }

  /** v17 ㊼：把 operation 记为 blocked 并锁定事务；不写任何完成证据。 */
  private failSidecarLocked(
    operationId: string,
    code: RestoreFilesystemError['code'],
    message: string,
  ): never {
    this.updateOperation(operationId, (draft) => {
      draft.status = 'blocked'
      draft.failureEvidence = { code, message }
    })
    throw new RestoreLockedError(code, message)
  }

  /**
   * v17 §2.4/§2.5：done 重放的现场验证。只读验证，不重新 unlink、不覆盖 evidence。
   *
   * 两类完成记录按 durable intent anchor 区分：
   * - intent anchor 为 absent：首次观察即不存在（F-SIDE 允许），只要求 targetAbsent 且现场仍缺失；
   * - intent anchor 为 regular-file：真实 unlink 完成，逐项校验 §2.5 completeEvidence 字段，
   *   并要求当前 target 仍缺失、当前父目录 dev/ino 与 evidence 记录一致。
   */
  private assertSidecarCompletionEvidence(
    operationId: string,
    target: string,
    operation: RestoreOperation,
    anchor: RestoreFileAnchor,
  ): void {
    const evidence = operation.evidenceAnchor
    if (!evidence) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar is done without durable completion evidence',
      )
    }
    const intentAnchor = operation.targetAnchor
    if (!intentAnchor) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar is done without a durable intent anchor',
      )
    }

    if (intentAnchor.type === 'absent') {
      if (evidence.targetAbsent !== true) {
        this.failSidecarLocked(
          operationId,
          'UNLINK_ATTRIBUTION_UNKNOWN',
          'sidecar absence completion evidence is invalid',
        )
      }
      if (anchor.type !== 'absent') {
        this.failSidecarLocked(
          operationId,
          'TARGET_CONFLICT',
          'sidecar reappeared after absence completion',
        )
      }
      return
    }
    if (intentAnchor.type !== 'regular-file') {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion has an invalid intent anchor',
      )
    }

    // v17 §2.5 completeEvidence 必备字段逐项校验（operationId / target anchor / 后验计数 /
    // 父目录身份 / 目录 fsync）。
    if (evidence.operationId !== operationId) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence operationId mismatch',
      )
    }
    if (
      typeof evidence.target !== 'string' ||
      path.resolve(evidence.target) !== path.resolve(target)
    ) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence target mismatch',
      )
    }
    if (evidence.targetAbsent !== true) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence is not marked targetAbsent',
      )
    }
    if (evidence.nlinkBefore !== 1 || evidence.nlinkAfter !== 0) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence has invalid held-fd link counts',
      )
    }
    if (
      typeof evidence.parentDev !== 'number' ||
      !Number.isSafeInteger(evidence.parentDev) ||
      typeof evidence.parentIno !== 'number' ||
      !Number.isSafeInteger(evidence.parentIno)
    ) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence has invalid parent identity',
      )
    }
    if (evidence.directoryFsyncCompleted !== true) {
      this.failSidecarLocked(
        operationId,
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'sidecar completion evidence is missing directory fsync confirmation',
      )
    }

    // 当前 target 必须仍缺失；重新出现（无论内容）即现场冲突。
    if (anchor.type !== 'absent') {
      this.failSidecarLocked(operationId, 'TARGET_CONFLICT', 'completed unlink target reappeared')
    }
    // 当前父目录身份必须与 evidence 记录一致。
    let parent: RestoreFileAnchor
    try {
      parent = lstatAnchor(path.dirname(target))
    } catch (error) {
      this.failSidecarLocked(
        operationId,
        'IDENTITY_MISMATCH',
        `sidecar parent scene cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (
      parent.type !== 'directory' ||
      parent.dev !== evidence.parentDev ||
      parent.ino !== evidence.parentIno
    ) {
      this.failSidecarLocked(
        operationId,
        'IDENTITY_MISMATCH',
        'sidecar parent identity changed after completion',
      )
    }
  }

  private addFileRenameIntent(
    operationId: string,
    source: string,
    target: string,
    sourceRole: RestoreOperation['sourceRole'],
  ): RenameIntent {
    if (!this.operation(operationId)) {
      const op = this.addOperation(
        operation(
          operationId,
          sourceRole === 'rollback_staged' ? 'rollback_install' : 'forward_install',
          'db',
          sourceRole,
          source,
          target,
        ),
      )
      const sourceAnchor = lstatAnchor(source)
      const targetAnchor = lstatAnchor(target)
      this.updateOperation(op.operationId, (draft) => {
        draft.sourceAnchor = sourceAnchor
        draft.targetPolicy =
          targetAnchor.type === 'absent' ? 'must_be_absent' : 'must_exist_and_match'
        draft.targetAnchor = targetAnchor.type === 'absent' ? null : targetAnchor
        draft.sourceParentAnchor = lstatAnchor(path.dirname(source))
        draft.targetParentAnchor = lstatAnchor(path.dirname(target))
        draft.intentState =
          sourceRole === 'rollback_staged' ? 'rb_install_intent' : 'install_intent'
        draft.status = 'intent'
      })
    }
    const op = this.operation(operationId)
    if (
      !op?.source ||
      !op.sourceAnchor ||
      !op.sourceParentAnchor ||
      !op.targetParentAnchor ||
      !op.targetPolicy
    ) {
      throw new Error(`rename operation incomplete: ${operationId}`)
    }
    return {
      operationId,
      source: op.source,
      target: op.target,
      sourceAnchor: op.sourceAnchor,
      targetPolicy: op.targetPolicy,
      expectedTargetAnchor: op.targetAnchor,
      sourceParentAnchor: op.sourceParentAnchor,
      targetParentAnchor: op.targetParentAnchor,
    }
  }

  /** v17 ⑭：rename 已生效但 op 未记完成时，用 verifyRenameReplay 补记；否则正常执行。 */
  private renameWithReplay(intent: RenameIntent): RestoreFileAnchor {
    if (lstatAnchor(intent.source).type === 'absent') {
      return verifyRenameReplay(intent)
    }
    return durableRename(intent)
  }

  private verifyCapturedRollback(): void {
    const capDb = this.operation('cap-db-1')
    const capArt = this.operation('cap-art-1')
    if (capDb?.status !== 'verified' || capArt?.status !== 'verified') {
      throw new Error('captured rollback is not verified')
    }
    const rollbackDb = path.join(this.paths.restoreCapturedRollback, 'db', 'agentra.db')
    const rollbackArtifacts = path.join(this.paths.restoreCapturedRollback, 'artifacts')
    const db = lstatAnchor(rollbackDb)
    if (db.sha256 !== capDb.actualSha256 || db.type !== 'regular-file') {
      throw new RestoreFilesystemError('HASH_MISMATCH', 'captured rollback DB changed')
    }
    const inventory = inventoryDirectory(rollbackArtifacts)
    if (!capArt.actualManifest) throw new Error('captured rollback Artifact manifest missing')
    assertInventoryContent(inventory, {
      root: capArt.targetAnchor as never,
      entries: capArt.actualManifest,
    })
    this.assertDatabaseIntegrity(rollbackDb)
  }

  private verifyCapturedRollbackAgainstLive(): void {
    this.verifyCapturedRollback()
    const capDb = this.operation('cap-db-1') as RestoreOperation
    const capArt = this.operation('cap-art-1') as RestoreOperation
    if (lstatAnchor(this.paths.database).sha256 !== capDb.actualSha256) {
      throw new RestoreFilesystemError('HASH_MISMATCH', 'rolled-back live DB does not match RB')
    }
    if (!capArt.actualManifest) throw new Error('captured Artifact manifest missing')
    assertInventoryContent(inventoryDirectory(this.paths.artifacts), {
      root: inventoryDirectory(this.paths.artifacts).root,
      entries: capArt.actualManifest,
    })
  }

  private assertDatabaseIntegrity(file: string): void {
    const probe = new DatabaseSync(file, { readOnly: true })
    try {
      const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      if (row.integrity_check !== 'ok') {
        throw new RestoreFilesystemError('HASH_MISMATCH', `integrity_check failed: ${file}`)
      }
    } finally {
      probe.close()
    }
  }

  private assertManifestMatchesInventory(
    manifest: BackupArtifactFile[],
    inventory: RestoreManifestEntry[],
  ): void {
    const files = inventory.filter((entry) => entry.type === 'file')
    const expected = [...manifest].sort((a, b) => a.path.localeCompare(b.path))
    const actual = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    if (expected.length !== actual.length) {
      throw new RestoreFilesystemError('MANIFEST_MISMATCH', 'Artifact file count mismatch')
    }
    for (let index = 0; index < expected.length; index += 1) {
      const left = expected[index]
      const right = actual[index]
      if (
        !left ||
        !right ||
        left.path !== right.relativePath ||
        left.bytes !== right.bytes ||
        left.sha256 !== right.sha256
      ) {
        throw new RestoreFilesystemError('MANIFEST_MISMATCH', 'Artifact manifest mismatch', {
          left,
          right,
        })
      }
    }
  }

  private readManifest(backupPath: string): BackupManifest {
    const manifestPath = assertPathInside(path.join(backupPath, 'manifest.json'), backupPath)
    const stat = fs.lstatSync(manifestPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RestoreFilesystemError('TYPE_MISMATCH', 'backup manifest has wrong type')
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest
    if (
      manifest.manifestVersion !== 1 ||
      manifest.database?.file !== 'database.db' ||
      !Array.isArray(manifest.artifacts)
    ) {
      throw new Error('backup manifest is invalid')
    }
    return manifest
  }

  private assertSpace(manifest: BackupManifest): void {
    assertSameDevice(this.paths.home, this.paths.backups, this.paths.restore, this.paths.artifacts)
    const liveDb = fs.statSync(this.paths.database).size
    const liveArtifacts = inventoryDirectory(this.paths.artifacts).entries.reduce(
      (sum, entry) => sum + (entry.bytes ?? 0),
      0,
    )
    const targetSize =
      manifest.database.bytes + manifest.artifacts.reduce((sum, entry) => sum + entry.bytes, 0)
    // Peak: live + captured rollback + forward/rollback staged, with a conservative 20% margin.
    const required = Math.ceil((liveDb + liveArtifacts) * 2 + targetSize * 1.2)
    if (availableBytes(this.paths.home) < required) {
      throw new Error(`RESTORE_INSUFFICIENT_SPACE: need ${required} bytes`)
    }
  }

  private transition(phase: RestoreJournal['phase']): void {
    if (this.journal.phase === phase) return
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        draft.phase = phase
      },
      this.now(),
    )
  }

  private operation(id: string): RestoreOperation | undefined {
    return this.journal.operations.find((entry) => entry.operationId === id)
  }

  private addOperation(operation: RestoreOperation): RestoreOperation {
    const existing = this.operation(operation.operationId)
    if (existing) return existing
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        draft.operations.push({
          ...operation,
          globalRevAtLastWrite: this.journal.globalRevision + 1,
        })
        draft.currentOperationId = operation.operationId
      },
      this.now(),
    )
    return this.operation(operation.operationId) as RestoreOperation
  }

  private updateOperation(id: string, update: (operation: RestoreOperation) => void): void {
    this.journal = this.store.writeNext(
      this.journal,
      (draft) => {
        const operation = draft.operations.find((entry) => entry.operationId === id)
        if (!operation) throw new Error(`Restore operation not found: ${id}`)
        update(operation)
        operation.opRev += 1
        operation.globalRevAtLastWrite = this.journal.globalRevision + 1
        draft.currentOperationId = id
      },
      this.now(),
    )
  }
}

function operation(
  operationId: string,
  operationType: RestoreOperation['operationType'],
  kind: RestoreOperation['kind'],
  sourceRole: RestoreOperation['sourceRole'],
  source: string | null,
  target: string,
): RestoreOperation {
  return {
    operationId,
    operationType,
    kind,
    sourceRole,
    source,
    target,
    expectedType: kind === 'artifacts' ? 'directory' : 'regular-file',
    targetPolicy: null,
    expectedSha256: null,
    actualSha256: null,
    expectedManifest: null,
    actualManifest: null,
    sourceAnchor: null,
    targetAnchor: null,
    sourceParentAnchor: null,
    targetParentAnchor: null,
    directoryInventory: null,
    perFileUnlinks: [],
    intentState: null,
    status: 'not_started',
    opRev: 1,
    globalRevAtLastWrite: 1,
    evidenceAnchor: null,
    failureEvidence: null,
    evidenceDigest: null,
  }
}
