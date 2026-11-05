import type { DaemonClient } from '../daemon/daemon-client'
import type { Database } from '../db/database'
import type { BackupRepository } from '../db/repositories/backup-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import type { MaintenanceController } from '../lifecycle/maintenance-controller'
import type { PersistenceGate } from '../lifecycle/persistence-gate'
import { lstatAnchor } from '../lifecycle/restore-filesystem'
import {
  type RestoreJournal,
  type RestoreJournalPaths,
  RestoreJournalStore,
  RestoreMarkerSchema,
} from '../lifecycle/restore-journal'
import type { BackupRestorePrecheckService } from './backup-restore-precheck-service'
import type { BackupService } from './backup-service'
import { RestoreArchiveService } from './restore-archive-service'

export type RestoreCoordinatorLogger = {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export class RestoreCoordinatorError extends Error {
  constructor(
    readonly code:
      | 'RESTORE_ALREADY_ACTIVE'
      | 'RESTORE_PRECHECK_FAILED'
      | 'RESTORE_DRAIN_TIMEOUT'
      | 'RESTORE_CHECKPOINT_BUSY'
      | 'RESTORE_JOURNAL_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'RestoreCoordinatorError'
  }
}

/**
 * Old-Core orchestration through handed_off. No live DB/Artifact replacement happens here.
 * The new booting Core owns capture/forward/rollback through RestoreExecutor.
 */
export class RestoreCoordinator {
  private readonly store: RestoreJournalStore
  private readonly archive: RestoreArchiveService
  private current: RestoreJournal | null = null
  private running = false

  constructor(
    private readonly journalPaths: RestoreJournalPaths,
    retiredRoot: string,
    private readonly db: Database,
    private readonly maintenance: MaintenanceController,
    private readonly drain: DrainCoordinator,
    private readonly persistence: PersistenceGate,
    private readonly runtime: DaemonClient,
    private readonly executions: { listActive(): unknown[] },
    private readonly backupRepository: BackupRepository,
    private readonly backupService: BackupService,
    private readonly precheck: BackupRestorePrecheckService,
    private readonly requestShutdown: (reason: string) => void,
    private readonly logger?: RestoreCoordinatorLogger,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly drainDeadlineMs = 30_000,
  ) {
    this.store = new RestoreJournalStore(journalPaths)
    this.archive = new RestoreArchiveService(this.store, retiredRoot, this.now)
  }

  request(backupId: string): { journalId: string; state: 'requested' } {
    if (this.running || this.current || this.store.loadActive({ validateScene: () => true })) {
      throw new RestoreCoordinatorError('RESTORE_ALREADY_ACTIVE', 'a Restore transaction is active')
    }
    const target = this.backupService.get(backupId)
    if (target.status !== 'verified' && target.status !== 'completed') {
      throw new RestoreCoordinatorError(
        'RESTORE_PRECHECK_FAILED',
        `backup ${backupId} is ${target.status}; expected verified/completed`,
      )
    }
    const precheck = this.precheck.precheck(backupId)
    if (!precheck.allowedToRestore) {
      throw new RestoreCoordinatorError(
        'RESTORE_PRECHECK_FAILED',
        `backup ${backupId} failed precheck: ${precheck.failure?.code ?? 'unknown'}`,
      )
    }
    let journal = this.store.createInitial({ backupId, now: this.now() })
    journal = this.store.writeNext(
      journal,
      (draft) => {
        draft.targetBackupPath = target.storagePath
      },
      this.now(),
    )
    const marker = RestoreMarkerSchema.parse({
      markerVersion: 1,
      journalId: journal.journalId,
      backupId,
      createdAt: this.now(),
      canonicalForm: 1,
    })
    const parent = lstatAnchor(this.journalPaths.restoreRoot)
    journal = this.store.createActivationIntent(
      journal,
      marker,
      {
        path: parent.path,
        dev: parent.dev as number,
        ino: parent.ino as number,
      },
      this.now(),
    )
    this.store.createActiveMarker(marker)
    journal = this.store.verifyAndConfirmActivation(journal, this.now())
    this.current = journal
    this.running = true
    queueMicrotask(() => {
      void this.run().catch((error) => {
        this.logger?.error('Restore orchestration failed', {
          journalId: this.current?.journalId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
    return { journalId: journal.journalId, state: 'requested' }
  }

  status(): RestoreJournal | null {
    return this.current
  }

  private async run(): Promise<void> {
    if (!this.current)
      throw new RestoreCoordinatorError('RESTORE_JOURNAL_INVALID', 'Journal missing')
    let queryOnly = false
    let ingressPaused = false
    try {
      this.maintenance.beginEnteringMaintenance('restore')
      this.persistence.close()
      const drained = await this.waitForDrain(this.drainDeadlineMs)
      if (!drained)
        throw new RestoreCoordinatorError('RESTORE_DRAIN_TIMEOUT', 'in-flight writes did not drain')
      if (!(await this.waitForExecutionsZero(this.drainDeadlineMs))) {
        throw new RestoreCoordinatorError(
          'RESTORE_DRAIN_TIMEOUT',
          'active Executions did not reach zero',
        )
      }
      if (!(await this.waitForEventHandlersZero(this.drainDeadlineMs))) {
        throw new RestoreCoordinatorError('RESTORE_DRAIN_TIMEOUT', 'event handlers did not drain')
      }
      this.runtime.pauseIngress()
      ingressPaused = true
      // Observe a quiet interval after the explicit pause.
      await sleep(500)
      if (this.drain.snapshot().counts['event-handler'] !== 0 || !this.runtime.isIngressPaused()) {
        throw new RestoreCoordinatorError(
          'RESTORE_DRAIN_TIMEOUT',
          'Daemon ingress pause was not stable',
        )
      }

      const pre = await this.persistence.runInternal('backup-write', 'restore:pre_restore', () =>
        this.backupService.create({ type: 'pre_restore' }),
      )
      const checked = this.precheck.precheck(pre.id)
      const saved = this.backupRepository.get(pre.id)
      if (!checked.allowedToRestore || saved?.status !== 'verified' || !saved.dbSha256) {
        throw new RestoreCoordinatorError(
          'RESTORE_PRECHECK_FAILED',
          `pre_restore ${pre.id} is not verified`,
        )
      }
      this.current = this.store.writeNext(
        this.current,
        (draft) => {
          draft.preRestoreBackupId = saved.id
          draft.preRestoreBackupRecord = {
            manifestVersion: saved.manifestVersion,
            dbSha256: saved.dbSha256 as string,
            files: saved.artifactFiles,
            storagePath: saved.storagePath,
            createdAt: saved.createdAt,
            completedAt: saved.completedAt as string,
            verifiedAt: saved.verifiedAt as string,
          }
          draft.steps.preRestoreVerified = true
          draft.phase = 'prepared'
        },
        this.now(),
      )

      const persistenceClosed = await this.persistence.closeAndDrain(0)
      if (!persistenceClosed.ok) {
        throw new RestoreCoordinatorError(
          'RESTORE_DRAIN_TIMEOUT',
          'persistence writes did not close',
        )
      }
      this.db.exec('PRAGMA query_only = ON')
      queryOnly = true
      const checkpoint = await this.checkpoint()
      this.current = this.store.writeNext(
        this.current,
        (draft) => {
          draft.checkpointEvidence = checkpoint
          draft.steps.drained = true
          draft.steps.ingressPaused = true
          draft.steps.checkpointed = true
          draft.phase = 'drained'
        },
        this.now(),
      )
      this.current = this.store.writeNext(
        this.current,
        (draft) => {
          draft.steps.handedOff = true
          draft.phase = 'handed_off'
        },
        this.now(),
      )
      this.logger?.info('Restore handed off to next Core', {
        journalId: this.current.journalId,
        backupId: this.current.backupId,
      })
      this.requestShutdown('RESTORE_HANDOFF')
    } catch (error) {
      if (queryOnly) {
        try {
          this.db.exec('PRAGMA query_only = OFF')
        } catch {
          // Original error remains primary.
        }
      }
      if (ingressPaused) this.runtime.resumeIngress()
      await this.abortBeforeReplacement(error)
      throw error
    } finally {
      this.running = false
    }
  }

  private async checkpoint(): Promise<Record<string, unknown>> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
          busy?: number
          log?: number
          checkpointed?: number
        }
        if (result.busy === 0) {
          return { attempt, busy: 0, log: result.log ?? 0, checkpointed: result.checkpointed ?? 0 }
        }
      } catch (error) {
        if (attempt === 3) {
          throw new RestoreCoordinatorError(
            'RESTORE_CHECKPOINT_BUSY',
            `checkpoint failed: ${String(error)}`,
          )
        }
      }
      if (attempt < 3) await sleep(1_000)
    }
    throw new RestoreCoordinatorError(
      'RESTORE_CHECKPOINT_BUSY',
      'WAL checkpoint remained busy after 3 attempts',
    )
  }

  private async abortBeforeReplacement(error: unknown): Promise<void> {
    if (this.current) {
      const failure = {
        code: error instanceof RestoreCoordinatorError ? error.code : 'RESTORE_ABORTED',
        message: error instanceof Error ? error.message : String(error),
      }
      try {
        this.current = this.store.writeNext(
          this.current,
          (draft) => {
            draft.lastError = failure
          },
          this.now(),
        )
        // v17：aborted 是正式终态——terminal snapshot → Archive verified A/B →
        // retired manifest → marker 删除 → active Journal 退役；全程不触碰 live。
        this.archive.finalizeTerminal(this.current, 'aborted', {
          abortedBeforeReplacement: true,
          lastErrorCode: failure.code,
        })
        this.current = null
      } catch (journalError) {
        this.maintenance.enterRecoveryLocked('restore_abort_journal_failed')
        this.logger?.error('failed to persist/finalize aborted Restore', {
          error: String(journalError),
        })
        return
      }
    }
    try {
      this.persistence.reopen()
      this.maintenance.abortEnteringMaintenance()
    } catch (resumeError) {
      this.maintenance.enterRecoveryLocked('restore_abort_resume_failed')
      this.logger?.error('failed to resume after Restore abort', { error: String(resumeError) })
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<boolean> {
    const result = await this.drain.drain(timeoutMs)
    return result.ok
  }

  private async waitForExecutionsZero(timeoutMs: number): Promise<boolean> {
    return waitUntil(() => this.executions.listActive().length === 0, timeoutMs)
  }

  private async waitForEventHandlersZero(timeoutMs: number): Promise<boolean> {
    return waitUntil(() => this.drain.snapshot().counts['event-handler'] === 0, timeoutMs)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
