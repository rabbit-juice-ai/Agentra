import {
  type MaintenanceState,
  type MaintenanceWriteGate,
  type RpcFailure,
  type RpcMethodAccess,
  rpcFailure,
} from '@agentra/protocol'
import { isLockdownReadMethod, isMaintenanceReadMethod } from './rpc-policy'

export class MaintenanceTransitionError extends Error {
  readonly code = 'ILLEGAL_MAINTENANCE_TRANSITION'
  constructor(
    readonly from: MaintenanceState,
    readonly to: MaintenanceState,
  ) {
    super(`illegal maintenance transition: ${from} -> ${to}`)
    this.name = 'MaintenanceTransitionError'
  }
}

export class MaintenanceBlockedError extends Error {
  readonly code: 'MAINTENANCE_ACTIVE' | 'RECOVERY_LOCKED' | 'SHUTTING_DOWN'
  constructor(
    code: 'MAINTENANCE_ACTIVE' | 'RECOVERY_LOCKED' | 'SHUTTING_DOWN',
    readonly operation: string,
  ) {
    super(`${operation} is blocked while maintenance state is ${code}`)
    this.name = 'MaintenanceBlockedError'
    this.code = code
  }
}

export type MaintenanceSnapshot = {
  state: MaintenanceState
  since: string
  reason: string | null
  writeGate: MaintenanceWriteGate
  lastBlockedOperation: string | null
}

/**
 * S55-2B：Core 维护状态机。
 *
 * 只负责状态、写入门禁和 RPC 授权；不负责 DrainCoordinator 计数、Journal、
 * Restore lock 或文件替换。调用方必须在进入 maintenance 前完成排空和受控内部写入。
 */
export class MaintenanceController {
  private stateValue: MaintenanceState = 'normal'
  private sinceValue: string
  private reasonValue: string | null = null
  private writeGateValue: MaintenanceWriteGate = 'open'
  private lastBlockedOperationValue: string | null = null

  constructor(private readonly now: () => string = () => new Date().toISOString()) {
    this.sinceValue = this.now()
  }

  get state(): MaintenanceState {
    return this.stateValue
  }

  snapshot(): MaintenanceSnapshot {
    return {
      state: this.stateValue,
      since: this.sinceValue,
      reason: this.reasonValue,
      writeGate: this.writeGateValue,
      lastBlockedOperation: this.lastBlockedOperationValue,
    }
  }

  /** S55-2B-1B：Core 启动最早期进入 booting；业务 RPC 一律 fail closed。 */
  enterBooting(reason = 'boot'): void {
    this.transition('booting', ['normal'])
    this.reasonValue = reason
    this.writeGateValue = 'closed'
  }

  /** S55-2B-1B：Daemon/DB/装配完成后进入 recovering（对账阶段）。 */
  beginRecovering(reason = 'reconciliation'): void {
    this.transition('recovering', ['booting'])
    this.reasonValue = reason
    this.writeGateValue = 'closed'
  }

  /** S55-2B-1B：对账与收敛完成后进入 normal（业务 RPC 唯一放行态）。 */
  completeBoot(): void {
    this.transition('normal', ['recovering'])
    this.reasonValue = null
    this.writeGateValue = 'open'
  }

  /** normal -> entering_maintenance；新外部写入立即拒绝，已有 lease 允许完成。 */
  beginEnteringMaintenance(reason = 'restore'): void {
    this.transition('entering_maintenance', ['normal'])
    this.reasonValue = reason
    this.writeGateValue = 'closing'
  }

  /** entering_maintenance -> maintenance；只有调用方完成排空/内部写入后才能调用。 */
  confirmMaintenance(): void {
    this.transition('maintenance', ['entering_maintenance'])
    this.writeGateValue = 'closed'
  }

  /** entering_maintenance -> normal；仅在尚未关闭 DB/文件门禁时允许。 */
  abortEnteringMaintenance(): void {
    this.transition('normal', ['entering_maintenance'])
    this.reasonValue = null
    this.writeGateValue = 'open'
  }

  /** 进入恢复锁定：fail closed，只允许 health/status。 */
  enterRecoveryLocked(reason = 'recovery'): void {
    this.transition('recovery_locked', [
      'booting',
      'recovering',
      'normal',
      'entering_maintenance',
      'maintenance',
    ])
    this.reasonValue = reason
    this.writeGateValue = 'closed'
  }

  /** 仅限后续 S55-2D 在恢复/回滚验证成功后调用。 */
  completeRecovery(): void {
    this.transition('normal', ['recovery_locked'])
    this.reasonValue = null
    this.writeGateValue = 'open'
  }

  /** 正常关闭或恢复重启前的关闭状态。 */
  beginShuttingDown(reason = 'shutdown'): void {
    if (this.stateValue === 'shutting_down') return
    this.transition('shutting_down', [
      'booting',
      'recovering',
      'normal',
      'entering_maintenance',
      'maintenance',
      'recovery_locked',
    ])
    this.reasonValue = reason
    this.writeGateValue = 'closed'
  }

  isWriteAllowed(): boolean {
    return this.stateValue === 'normal'
  }

  isSchedulerAllowed(): boolean {
    return this.stateValue === 'normal'
  }

  isExecutionStartAllowed(): boolean {
    return this.stateValue === 'normal'
  }

  /**
   * booting/recovering 期间 Daemon 事件必须照常接收（恢复对账依赖终态事件）；
   * maintenance 阶段返回 false，表示不应再接收新的业务事件。
   */
  isEventIngressAllowed(): boolean {
    return (
      this.stateValue === 'normal' ||
      this.stateValue === 'booting' ||
      this.stateValue === 'recovering' ||
      this.stateValue === 'entering_maintenance'
    )
  }

  assertExternalWriteAllowed(operation: string): void {
    if (this.isWriteAllowed()) return
    throw new MaintenanceBlockedError(this.blockedCode(), operation)
  }

  /**
   * RPC 授权：normal 全部允许；entering/maintenance 仅只读白名单；
   * booting/recovering/recovery_locked/shutting_down 仅 health/status（lockdown）。
   * booting/recovering 复用 RECOVERY_LOCKED 错误码，detail.state 区分启动阶段（CTO R4）。
   */
  authorizeRpc(requestId: string, method: string, access: RpcMethodAccess): RpcFailure | null {
    if (this.stateValue === 'normal') return null

    if (this.isLockdownState()) {
      if (access === 'read' && isLockdownReadMethod(method)) return null
      this.lastBlockedOperationValue = `rpc:${method}`
      return rpcFailure(
        requestId,
        this.stateValue === 'shutting_down' ? 'SHUTTING_DOWN' : 'RECOVERY_LOCKED',
        `method ${method} is not available while core is ${this.stateValue}`,
        { state: this.stateValue, method },
      )
    }

    if (access === 'write' || !isMaintenanceReadMethod(method)) {
      this.lastBlockedOperationValue = `rpc:${method}`
      return rpcFailure(
        requestId,
        'MAINTENANCE_ACTIVE',
        `method ${method} is blocked while core is ${this.stateValue}`,
        { state: this.stateValue, method, access },
      )
    }

    return null
  }

  private isLockdownState(): boolean {
    return (
      this.stateValue === 'booting' ||
      this.stateValue === 'recovering' ||
      this.stateValue === 'recovery_locked' ||
      this.stateValue === 'shutting_down'
    )
  }

  private blockedCode(): MaintenanceBlockedError['code'] {
    if (this.isLockdownState() && this.stateValue !== 'shutting_down') return 'RECOVERY_LOCKED'
    if (this.stateValue === 'shutting_down') return 'SHUTTING_DOWN'
    return 'MAINTENANCE_ACTIVE'
  }

  private transition(to: MaintenanceState, from: readonly MaintenanceState[]): void {
    if (!from.includes(this.stateValue)) {
      throw new MaintenanceTransitionError(this.stateValue, to)
    }
    this.stateValue = to
    this.sinceValue = this.now()
  }
}
