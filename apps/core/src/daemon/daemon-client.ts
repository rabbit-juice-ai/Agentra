import net from 'node:net'
import {
  DAEMON_DISCOVER_METHOD,
  DAEMON_EXECUTION_CANCEL_METHOD,
  DAEMON_EXECUTION_INTERRUPT_METHOD,
  DAEMON_EXECUTION_LIST_ACTIVE_METHOD,
  DAEMON_EXECUTION_SEND_MESSAGE_METHOD,
  DAEMON_EXECUTION_START_METHOD,
  DAEMON_EXECUTION_STATUS_METHOD,
  DAEMON_SUBSCRIBE_METHOD,
  DaemonDiscoverResult,
  DaemonExecutionListActiveResult,
  type DaemonExecutionStartParams,
  type DaemonExecutionStartResult,
  type DaemonExecutionStatusResult,
  EventFrame,
  PROTOCOL_VERSION,
  RpcMethodError,
  type RpcResponse,
  type RuntimeEvent,
  type RuntimeInfo,
  DaemonExecutionStartResult as StartResultSchema,
  DaemonExecutionStatusResult as StatusResultSchema,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'

export type RuntimeClient = {
  discover(): Promise<RuntimeInfo[]>
  start(params: DaemonExecutionStartParams): Promise<DaemonExecutionStartResult>
  sendMessage(executionId: string, message: string): Promise<void>
  interrupt(executionId: string): Promise<{ interrupted: boolean }>
  cancel(executionId: string): Promise<void>
  status(executionId: string): Promise<DaemonExecutionStatusResult>
  listActive(): Promise<string[]>
  subscribe(listener: (event: RuntimeEvent) => void, onConnected?: () => void): () => void
  /** S55-2B-1B：等待订阅 ACK（仅 DaemonClient 实现；ACK 只证明订阅建立）。 */
  waitForConnection?(timeoutMs: number): Promise<boolean>
  /** S55-2C：Execution=0 且 event-handler 排空后显式暂停/恢复新事件 ingress。 */
  pauseIngress?(): void
  resumeIngress?(): void
  isIngressPaused?(): boolean
  close(): void
}

export type DaemonClientLogger = {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

const CALL_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000
/** S55-2B-1B：单次订阅 ACK 超时；超时销毁连接走既有退避重连。 */
const SUBSCRIBE_ACK_TIMEOUT_MS = 5_000

/**
 * Core → Daemon 的 UDS/NDJSON 客户端。
 * 普通调用一请求一连接（简单、失败可重试）；事件订阅使用一条长连接并在断开后自动重连。
 */
export class DaemonClient implements RuntimeClient {
  private subscription: net.Socket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private closed = false
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private readonly connectedListeners = new Set<() => void>()
  private readonly drain: DrainCoordinator | undefined
  /** S55-2B-1B：连接代际——旧连接的任何帧（含迟到 ACK）按代际丢弃。 */
  private generation = 0
  /** 当前连接待确认的订阅请求；ACK 匹配 requestId 后才算就绪。 */
  private pendingSubscribe: {
    requestId: string
    generation: number
    timer: NodeJS.Timeout
  } | null = null
  /** 当前连接是否已完成订阅 ACK（ACK 只证明订阅建立，不证明任何 Execution 活跃）。 */
  private ready = false
  /** S55-2C：独立于 MaintenanceState 的 Daemon 事件 ingress 门禁。 */
  private ingressPaused = false
  private pausedEventCount = 0
  private readonly connectionWaiters = new Set<{
    resolve: (ok: boolean) => void
    timer: NodeJS.Timeout
  }>()

  constructor(
    private readonly socketPath: string,
    private readonly logger?: DaemonClientLogger,
    drain?: DrainCoordinator,
  ) {
    this.drain = drain
  }

  async discover(): Promise<RuntimeInfo[]> {
    const result = await this.call(DAEMON_DISCOVER_METHOD, {})
    return DaemonDiscoverResult.parse(result).providers
  }

  async start(params: DaemonExecutionStartParams): Promise<DaemonExecutionStartResult> {
    const result = await this.call(DAEMON_EXECUTION_START_METHOD, params)
    return StartResultSchema.parse(result)
  }

  async sendMessage(executionId: string, message: string): Promise<void> {
    await this.call(DAEMON_EXECUTION_SEND_MESSAGE_METHOD, { executionId, message })
  }

  async interrupt(executionId: string): Promise<{ interrupted: boolean }> {
    const result = await this.call(DAEMON_EXECUTION_INTERRUPT_METHOD, { executionId })
    return result as { interrupted: boolean }
  }

  async cancel(executionId: string): Promise<void> {
    await this.call(DAEMON_EXECUTION_CANCEL_METHOD, { executionId })
  }

  async status(executionId: string): Promise<DaemonExecutionStatusResult> {
    const result = await this.call(DAEMON_EXECUTION_STATUS_METHOD, { executionId })
    return StatusResultSchema.parse(result)
  }

  async listActive(): Promise<string[]> {
    const result = await this.call(DAEMON_EXECUTION_LIST_ACTIVE_METHOD, {})
    return DaemonExecutionListActiveResult.parse(result).executionIds
  }

  subscribe(listener: (event: RuntimeEvent) => void, onConnected?: () => void): () => void {
    this.listeners.add(listener)
    if (onConnected) this.connectedListeners.add(onConnected)
    if (!this.subscription && !this.closed) this.openSubscription()
    return () => {
      this.listeners.delete(listener)
      if (onConnected) this.connectedListeners.delete(onConnected)
    }
  }

  /**
   * S55-2B-1B：等待订阅 ACK。已就绪立即 true；断连时等待中的 Promise 以 false
   * 结束（不悬挂）；超时清理自身后 false。ACK 只证明订阅建立。
   */
  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.closed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(
          () => {
            this.connectionWaiters.delete(waiter)
            resolve(false)
          },
          Math.max(0, timeoutMs),
        ),
      }
      this.connectionWaiters.add(waiter)
    })
  }

  pauseIngress(): void {
    this.ingressPaused = true
  }

  resumeIngress(): void {
    this.ingressPaused = false
  }

  isIngressPaused(): boolean {
    return this.ingressPaused
  }

  close(): void {
    this.closed = true
    this.ready = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearPendingSubscribe()
    this.settleConnectionWaiters(false)
    this.subscription?.destroy()
    this.subscription = null
    this.listeners.clear()
    this.connectedListeners.clear()
  }

  private async call(
    method: string,
    params: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const lease = this.drain?.acquire('daemon-call', `daemon:${method}`)
    try {
      return await this.callInternal(method, params, timeoutMs)
    } finally {
      lease?.release()
    }
  }

  private async callInternal(
    method: string,
    params: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const requestId = newId('req')
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath)
      let buffer = ''
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        action()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new RpcMethodError(
              'NOT_READY',
              `daemon call ${method} timed out after ${timeoutMs}ms (${this.socketPath})`,
            ),
          ),
        )
      }, timeoutMs)

      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({ requestId, protocolVersion: PROTOCOL_VERSION, method, params })}\n`,
        )
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index === -1) return
        const line = buffer.slice(0, index)
        finish(() => {
          let response: RpcResponse
          try {
            response = JSON.parse(line) as RpcResponse
          } catch (error) {
            reject(
              new RpcMethodError(
                'INTERNAL',
                `daemon returned non-JSON response for ${method}: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
            return
          }
          if (!('ok' in response)) {
            reject(
              new RpcMethodError('INTERNAL', `daemon returned a non-response frame for ${method}`),
            )
            return
          }
          if (response.ok) resolve(response.result)
          else reject(new RpcMethodError(response.error.code, response.error.message))
        })
      })
      socket.on('error', (error) => {
        finish(() =>
          reject(
            new RpcMethodError('NOT_READY', `daemon unavailable (${method}): ${error.message}`),
          ),
        )
      })
    })
  }

  private openSubscription(): void {
    if (this.closed) return
    this.generation += 1
    const generation = this.generation
    const socket = net.connect(this.socketPath)
    this.subscription = socket
    this.ready = false
    let buffer = ''
    socket.setEncoding('utf8')

    socket.on('connect', () => {
      this.reconnectAttempts = 0
      const requestId = newId('sub')
      // ACK 超时：销毁连接 → close 处理器结算等待者并走退避重连。
      const timer = setTimeout(() => {
        if (this.pendingSubscribe?.requestId !== requestId) return
        this.logger?.warn('daemon subscription ack timed out', {
          requestId,
          timeoutMs: SUBSCRIBE_ACK_TIMEOUT_MS,
        })
        socket.destroy()
      }, SUBSCRIBE_ACK_TIMEOUT_MS)
      this.pendingSubscribe = { requestId, generation, timer }
      socket.write(
        `${JSON.stringify({
          requestId,
          protocolVersion: PROTOCOL_VERSION,
          method: DAEMON_SUBSCRIBE_METHOD,
          params: {},
        })}\n`,
      )
      this.logger?.info('daemon subscription connected; awaiting ack', {
        socketPath: this.socketPath,
      })
    })

    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) this.handleFrame(line, socket, generation)
        index = buffer.indexOf('\n')
      }
    })

    socket.on('error', (error) => {
      this.logger?.warn('daemon subscription error', { error: error.message })
      socket.destroy()
    })

    socket.on('close', () => {
      if (this.subscription === socket) {
        this.subscription = null
        this.ready = false
        this.clearPendingSubscribe()
        this.settleConnectionWaiters(false)
      }
      if (this.closed) return
      this.scheduleReconnect()
    })
  }

  /**
   * S55-2B-1B：帧处理按连接代际隔离——旧连接（或已被替换的连接）的任何帧
   * 直接丢弃，旧 ACK 不可能解除新连接的等待。
   */
  private handleFrame(line: string, socket: net.Socket, generation: number): void {
    if (this.subscription !== socket || generation !== this.generation) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.logger?.warn('daemon sent non-JSON frame', { frame: line.slice(0, 200) })
      return
    }

    // 订阅 ACK：requestId 必须与当前连接待确认请求一致。
    const candidate = parsed as { requestId?: unknown; ok?: unknown }
    if (
      this.pendingSubscribe &&
      this.pendingSubscribe.generation === generation &&
      candidate.requestId === this.pendingSubscribe.requestId
    ) {
      this.clearPendingSubscribe()
      if (candidate.ok === true) {
        this.ready = true
        this.logger?.info('daemon subscription acknowledged', { socketPath: this.socketPath })
        this.settleConnectionWaiters(true)
        for (const listener of this.connectedListeners) {
          try {
            listener()
          } catch (error) {
            this.logger?.error('daemon reconnect handler failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      } else {
        this.logger?.error('daemon subscription rejected', {
          response: line.slice(0, 200),
        })
        socket.destroy()
      }
      return
    }

    const frame = EventFrame.safeParse(parsed)
    if (!frame.success) {
      // 其他非事件帧：忽略（不把未知帧当事件）。
      return
    }
    if (this.ingressPaused) {
      this.pausedEventCount += 1
      this.logger?.warn('daemon event dropped while ingress is paused', {
        eventId: frame.data.event.eventId,
        eventType: frame.data.event.eventType,
        droppedCount: this.pausedEventCount,
      })
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(frame.data.event)
      } catch (error) {
        this.logger?.error('daemon event listener failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private clearPendingSubscribe(): void {
    if (!this.pendingSubscribe) return
    clearTimeout(this.pendingSubscribe.timer)
    this.pendingSubscribe = null
  }

  private settleConnectionWaiters(ok: boolean): void {
    for (const waiter of [...this.connectionWaiters]) {
      this.connectionWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(ok)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSubscription()
    }, delay)
    this.logger?.warn('daemon subscription reconnecting', { delayMs: delay })
  }
}
