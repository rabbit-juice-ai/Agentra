import type { DrainCategory, DrainSnapshot } from '@agentra/protocol'

export const DRAIN_CATEGORIES: readonly DrainCategory[] = [
  'rpc-mutation',
  'scheduler-tick',
  'execution-start',
  'daemon-call',
  'artifact-write',
  'backup-write',
  'worktree-write',
  'provider-refresh',
  'workflow-kick',
  'event-handler',
]

export class DrainClosedError extends Error {
  readonly code = 'DRAIN_CLOSED'
  constructor(readonly category: DrainCategory) {
    super(`drain is closed; refused new ${category} lease`)
    this.name = 'DrainClosedError'
  }
}

export class DrainNotIdleError extends Error {
  readonly code = 'DRAIN_NOT_IDLE'
  constructor(readonly snapshot: DrainSnapshot) {
    super(`cannot reopen drain: ${snapshot.total} lease(s) still active`)
    this.name = 'DrainNotIdleError'
  }
}

export type DrainResult = {
  ok: boolean
  timedOut: boolean
  snapshot: DrainSnapshot
}

type AcquireOptions = {
  /**
   * 仅限 Core 内部恢复流程使用的受控 lease。普通调用方不能通过 RPC 参数获得该能力；
   * S55-2B-1A 只建立接口，不接入 pre_restore。
   */
  internal?: boolean
}

/** 单个在途操作 lease；重复 release 是幂等的，不会造成负计数。 */
export class DrainLease {
  private released = false

  constructor(
    private readonly coordinator: DrainCoordinator,
    readonly category: DrainCategory,
    readonly operation: string,
  ) {}

  get isReleased(): boolean {
    return this.released
  }

  release(): boolean {
    if (this.released) return false
    this.released = true
    this.coordinator.releaseLease(this.category)
    return true
  }
}

/**
 * S55-2B：在途操作计数与排空。
 *
 * 关闭接收后，新的普通 lease 被拒绝；已持有的 lease 仍可完成并释放。
 * deadline 到达时返回 timedOut=true 和完整 snapshot，调用方不得把它当成成功。
 */
export class DrainCoordinator {
  private accepting = true
  private readonly counts: Record<DrainCategory, number> = Object.fromEntries(
    DRAIN_CATEGORIES.map((category) => [category, 0]),
  ) as Record<DrainCategory, number>
  private lastBlockedCategory: DrainCategory | null = null
  private lastBlockedOperation: string | null = null
  private readonly waiters = new Set<() => void>()

  acquire(category: DrainCategory, operation: string, options: AcquireOptions = {}): DrainLease {
    if (!this.accepting && !options.internal) {
      this.lastBlockedCategory = category
      this.lastBlockedOperation = operation
      throw new DrainClosedError(category)
    }
    this.counts[category] += 1
    return new DrainLease(this, category, operation)
  }

  run<T>(category: DrainCategory, operation: string, action: () => T): T {
    const lease = this.acquire(category, operation)
    try {
      return action()
    } finally {
      lease.release()
    }
  }

  async runAsync<T>(
    category: DrainCategory,
    operation: string,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const lease = this.acquire(category, operation)
    try {
      return await action()
    } finally {
      lease.release()
    }
  }

  /** 关闭接收；已有 lease 不受影响。 */
  close(): void {
    this.accepting = false
    this.notifyWaiters()
  }

  /** 仅在完全没有在途 lease 时恢复接收；用于 entering_maintenance 的安全中止。 */
  reopen(): void {
    const snapshot = this.snapshot()
    if (snapshot.total > 0) throw new DrainNotIdleError(snapshot)
    this.accepting = true
  }

  snapshot(): DrainSnapshot {
    const counts = { ...this.counts }
    const total = DRAIN_CATEGORIES.reduce((sum, category) => sum + counts[category], 0)
    return {
      accepting: this.accepting,
      counts,
      total,
      lastBlockedCategory: this.lastBlockedCategory,
      lastBlockedOperation: this.lastBlockedOperation,
    }
  }

  /** 关闭接收并等待所有 lease 释放；deadline 到达返回 timedOut=true。 */
  async drain(deadlineMs: number): Promise<DrainResult> {
    this.close()
    const idle = await this.waitForIdle(deadlineMs)
    const snapshot = this.snapshot()
    return { ok: idle && snapshot.total === 0, timedOut: !idle, snapshot }
  }

  async waitForIdle(deadlineMs: number): Promise<boolean> {
    if (this.snapshot().total === 0) return true
    return await new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | null = null
      const check = (): void => {
        if (this.snapshot().total !== 0) return
        cleanup()
        resolve(true)
      }
      const cleanup = (): void => {
        this.waiters.delete(check)
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      this.waiters.add(check)
      timer = setTimeout(
        () => {
          cleanup()
          resolve(this.snapshot().total === 0)
        },
        Math.max(0, deadlineMs),
      )
    })
  }

  /** 仅供 DrainLease 调用；不对外暴露。 */
  releaseLease(category: DrainCategory): void {
    this.counts[category] = Math.max(0, this.counts[category] - 1)
    this.notifyWaiters()
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}
