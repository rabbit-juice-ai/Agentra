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

export type RuntimeClient = {
  discover(): Promise<RuntimeInfo[]>
  start(params: DaemonExecutionStartParams): Promise<DaemonExecutionStartResult>
  sendMessage(executionId: string, message: string): Promise<void>
  interrupt(executionId: string): Promise<{ interrupted: boolean }>
  cancel(executionId: string): Promise<void>
  status(executionId: string): Promise<DaemonExecutionStatusResult>
  listActive(): Promise<string[]>
  subscribe(listener: (event: RuntimeEvent) => void, onConnected?: () => void): () => void
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

  constructor(
    private readonly socketPath: string,
    private readonly logger?: DaemonClientLogger,
  ) {}

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

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
    const socket = net.connect(this.socketPath)
    this.subscription = socket
    let buffer = ''
    socket.setEncoding('utf8')

    socket.on('connect', () => {
      this.reconnectAttempts = 0
      socket.write(
        `${JSON.stringify({
          requestId: newId('sub'),
          protocolVersion: PROTOCOL_VERSION,
          method: DAEMON_SUBSCRIBE_METHOD,
          params: {},
        })}\n`,
      )
      this.logger?.info('daemon subscription connected', { socketPath: this.socketPath })
      for (const listener of this.connectedListeners) {
        try {
          listener()
        } catch (error) {
          this.logger?.error('daemon reconnect handler failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })

    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) this.handleFrame(line)
        index = buffer.indexOf('\n')
      }
    })

    socket.on('error', (error) => {
      this.logger?.warn('daemon subscription error', { error: error.message })
      socket.destroy()
    })

    socket.on('close', () => {
      if (this.subscription === socket) this.subscription = null
      if (this.closed) return
      this.scheduleReconnect()
    })
  }

  private handleFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.logger?.warn('daemon sent non-JSON frame', { frame: line.slice(0, 200) })
      return
    }
    const frame = EventFrame.safeParse(parsed)
    if (!frame.success) {
      // 订阅响应等非事件帧：忽略（不把未知帧当事件）。
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
