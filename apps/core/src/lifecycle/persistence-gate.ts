import type { DrainCategory, DrainSnapshot } from '@agentra/protocol'
import type { DrainCoordinator, DrainLease, DrainResult } from './drain-coordinator'

export type PersistenceGateState = 'open' | 'closing' | 'closed'

export class PersistenceGateClosedError extends Error {
  readonly code = 'PERSISTENCE_GATE_CLOSED'
  constructor(
    readonly state: PersistenceGateState,
    readonly category: DrainCategory,
  ) {
    super(`persistence gate is ${state}; refused new ${category} write lease`)
    this.name = 'PersistenceGateClosedError'
  }
}

/**
 * S55-2B-1A：Artifact / Backup / Worktree 文件写入的统一 lease 门禁接口。
 *
 * 本轮只建立接口和测试，尚未接入实际写入路径；接入模块必须在后续阶段逐个声明。
 * `runInternal` 是 Core 内部恢复流程的受控能力，不接受 RPC 参数或用户输入；
 * 本轮不调用它创建 pre_restore。
 */
export class PersistenceGate {
  private stateValue: PersistenceGateState = 'open'

  constructor(private readonly drain: DrainCoordinator) {}

  get state(): PersistenceGateState {
    return this.stateValue
  }

  acquire(category: DrainCategory, operation: string): DrainLease {
    if (this.stateValue !== 'open') {
      throw new PersistenceGateClosedError(this.stateValue, category)
    }
    return this.drain.acquire(category, operation)
  }

  /**
   * 受控内部写入：仅限 Core 恢复流程直接调用，不接受 RPC 参数。
   * closing 阶段允许已规划的 pre_restore 完成；closed 后拒绝。
   */
  async runInternal<T>(
    category: DrainCategory,
    operation: string,
    action: () => Promise<T> | T,
  ): Promise<T> {
    if (this.stateValue === 'closed') {
      throw new PersistenceGateClosedError(this.stateValue, category)
    }
    const lease = this.drain.acquire(category, operation, { internal: true })
    try {
      return await action()
    } finally {
      lease.release()
    }
  }

  /** 停止接收新的普通写入 lease；已持有 lease 可继续。 */
  close(): void {
    if (this.stateValue === 'open') this.stateValue = 'closing'
    this.drain.close()
  }

  /** 等待所有写入 lease 释放；成功后进入 closed。 */
  async closeAndDrain(deadlineMs: number): Promise<DrainResult> {
    this.close()
    const result = await this.drain.drain(deadlineMs)
    if (result.ok) this.stateValue = 'closed'
    return result
  }

  /** 仅在没有任何在途 lease 时恢复 open；用于安全中止。 */
  reopen(): void {
    this.drain.reopen()
    this.stateValue = 'open'
  }

  snapshot(): { state: PersistenceGateState; drain: DrainSnapshot } {
    return { state: this.stateValue, drain: this.drain.snapshot() }
  }
}
