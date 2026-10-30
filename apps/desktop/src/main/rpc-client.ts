import net from 'node:net'
import { PROTOCOL_VERSION, type RpcResponse, rpcFailure } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import WebSocket from 'ws'

/** Desktop → Core 的 WS-over-UDS 客户端：请求 Promise 化。 */
export class CoreRpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, (response: RpcResponse) => void>()

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
    this.ws.on('message', (data) => {
      try {
        const response = JSON.parse(String(data)) as RpcResponse
        const settle = this.pending.get(response.requestId)
        if (settle) {
          this.pending.delete(response.requestId)
          settle(response)
        }
      } catch {
        // 非 JSON 帧：忽略（协议不允许，但客户端保持健壮）。
      }
    })
  }

  async call(method: string, params: unknown = {}, timeoutMs = 5000): Promise<RpcResponse> {
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

  close(): void {
    this.ws?.close()
    this.ws = null
    this.pending.clear()
  }
}
