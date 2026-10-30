import http from 'node:http'
import fs from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDispatcher, type MethodTable } from './dispatcher'
import { rpcFailure } from '@agentra/protocol'

export type WsServer = { close: () => void; socketPath: string }

/**
 * WS-over-UDS：HTTP server listen 在 Unix socket 上，ws attach 其上。
 * 不占 TCP 端口，天然只限本机进程访问。
 */
export function startWsServer(socketPath: string, methods: MethodTable): Promise<WsServer> {
  const dispatch = createDispatcher(methods)
  const httpServer = http.createServer((_req, res) => {
    // 非 WS 升级请求一律拒绝（健康探针走 RPC，不做 HTTP 页面）。
    res.writeHead(426).end('websocket only')
  })
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 4 * 1024 * 1024 })

  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => {
      void dispatch(String(data))
        .then((response) => socket.send(JSON.stringify(response)))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          socket.send(JSON.stringify(rpcFailure('internal-error', 'INTERNAL', message)))
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
