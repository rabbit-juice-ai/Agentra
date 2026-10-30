import net from 'node:net'
import {
  EventFrame,
  PROTOCOL_VERSION,
  type RpcResponse,
  type RuntimeEvent,
  rpcFailure,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import WebSocket from 'ws'

/**
 * Desktop → Core 的 WS-over-UDS 客户端：请求 Promise 化 + 事件推送订阅。
 * 连接断开时通知监听者（由主进程决定是否重连）。
 */
export class CoreRpcClient {
  private ws: WebSocket | null = null
  private readonly pending = new Map<string, (response: RpcResponse) => void>()
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>()
  private readonly closeListeners = new Set<() => void>()

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    // 不用 ws+unix:// URL：URL 解析会把路径里的空格等字符百分号编码（macOS 默认数据
    // 目录 "Application Support" 含空格），ws 把编码后的 pathname 直接交给 net.connect
    // 会 ENOENT。这里用 createConnection 直接连接原始 socketPath。
    this.ws = new WebSocket('ws://localhost', {
      createConnection: () => net.connect(this.socketPath),
    })
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws
      if (!ws) return reject(new Error('client closed'))
      ws.once('open', () => resolve())
      ws.once('error', (error) => reject(error))
    })
    const ws = this.ws
    if (!ws) throw new Error('client closed')
    ws.on('message', (data) => {
      this.handleMessage(String(data))
    })
    ws.on('close', () => {
      this.ws = null
      this.failPending()
      for (const listener of this.closeListeners) listener()
    })
    ws.on('error', () => {
      // 错误后通常伴随 close；由 close 统一处理重连。
    })
  }

  async call(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<RpcResponse> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return rpcFailure('client-not-open', 'NOT_READY', 'core connection is not open')
    }
    const requestId = newId('req')
    const response = await new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(rpcFailure(requestId, 'NOT_READY', `request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      ws.send(JSON.stringify({ requestId, protocolVersion: PROTOCOL_VERSION, method, params }))
    })
    return response
  }

  /** 订阅 Core 事件；返回取消订阅函数。 */
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    this.failPending()
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 非 JSON 帧：忽略（协议不允许，但客户端保持健壮）。
      return
    }
    const eventFrame = EventFrame.safeParse(parsed)
    if (eventFrame.success) {
      for (const listener of this.eventListeners) {
        try {
          listener(eventFrame.data.event)
        } catch {
          // 单个监听者异常不影响其他监听者。
        }
      }
      return
    }
    const response = parsed as RpcResponse
    if (typeof response?.requestId !== 'string') return
    const settle = this.pending.get(response.requestId)
    if (settle) {
      this.pending.delete(response.requestId)
      settle(response)
    }
  }

  private failPending(): void {
    for (const [requestId, settle] of this.pending) {
      settle(rpcFailure(requestId, 'NOT_READY', 'core connection closed'))
    }
    this.pending.clear()
  }
}
