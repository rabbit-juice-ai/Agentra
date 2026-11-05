import fs from 'node:fs'
import http from 'node:http'
import { rpcFailure } from '@agentra/protocol'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  createDispatcher,
  type DispatchHooks,
  type MethodTable,
  type RpcContext,
} from './dispatcher'

export type WsServer = { close: () => void; socketPath: string }

/**
 * WS-over-UDS：HTTP server listen 在 Unix socket 上，ws attach 其上。
 * 不占 TCP 端口，天然只限本机进程访问。
 * 订阅连接（events.subscribe）通过 ctx.push 接收服务端事件帧。
 */
export function startWsServer(
  socketPath: string,
  methods: MethodTable,
  hooks: DispatchHooks = {},
): Promise<WsServer> {
  const dispatch = createDispatcher(methods, hooks)
  const httpServer = http.createServer((_req, res) => {
    // 非 WS 升级请求一律拒绝（健康探针走 RPC，不做 HTTP 页面）。
    res.writeHead(426).end('websocket only')
  })
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 4 * 1024 * 1024 })

  wss.on('connection', (socket: WebSocket) => {
    const closeListeners: (() => void)[] = []
    const ctx: RpcContext = {
      push: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
      },
      onClose: (listener) => closeListeners.push(listener),
    }
    socket.on('close', () => {
      for (const listener of closeListeners.splice(0)) {
        try {
          listener()
        } catch {
          // 关闭回调异常不得影响其他订阅者清理。
        }
      }
    })
    socket.on('message', (data) => {
      void dispatch(String(data), ctx)
        .then((response) => ctx.push(response))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          ctx.push(rpcFailure('internal-error', 'INTERNAL', message))
        })
    })
    socket.on('error', () => socket.terminate())
  })

  return new Promise((resolve, reject) => {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // 不存在即目标状态；若被占用，listen 会报错。
    }
    httpServer.listen(socketPath, () => {
      resolve({
        socketPath,
        close: () => {
          wss.close()
          httpServer.close()
          try {
            fs.unlinkSync(socketPath)
          } catch {
            // 忽略。
          }
        },
      })
    })
    httpServer.once('error', (error) => reject(error))
  })
}
