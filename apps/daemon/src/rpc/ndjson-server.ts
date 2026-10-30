import fs from 'node:fs'
import net from 'node:net'
import { createDispatcher, type MethodTable } from './rpc/dispatcher'
import { rpcFailure } from '@agentra/protocol'

export type NdjsonServer = { close: () => void; socketPath: string }

/**
 * 在 Unix Domain Socket 上起 NDJSON RPC 服务。
 * 每行一个 JSON 信封，响应同样按行回写。仅绑定本机 UDS，无 TCP 端口。
 */
export function startNdjsonServer(socketPath: string, methods: MethodTable, onError?: (error: Error) => void): Promise<NdjsonServer> {
  const dispatch = createDispatcher(methods)
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line.length > 0) {
          void dispatch(line)
            .then((response) => {
              socket.write(`${JSON.stringify(response)}\n`)
            })
            .catch((error: unknown) => {
              // 分发器本身不应抛错；兜底转换为 INTERNAL 响应。
              const message = error instanceof Error ? error.message : String(error)
              const fallback = rpcFailure('internal-error', 'INTERNAL', message)
              socket.write(`${JSON.stringify(fallback)}\n`)
            })
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {
      // 单连接错误（如客户端断开）不影响服务；静默清理。
      socket.destroy()
    })
  })

  server.on('error', (error) => {
    onError?.(error)
  })

  return new Promise((resolve, reject) => {
    // 陈旧 socket 文件不随进程死亡自动清理：bind 前显式 unlink。
    try {
      fs.unlinkSync(socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 文件存在但不是我们能删的（比如还是活 socket 的极端竞态）：bind 会报 EADDRINUSE，走 error 分支。
      }
    }
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close: () => {
          server.close()
          try {
            fs.unlinkSync(socketPath)
          } catch {
            // 已被清理则忽略。
          }
        },
      })
    })
    server.once('error', (error) => reject(error))
  })
}
