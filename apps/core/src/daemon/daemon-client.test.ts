import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from './daemon-client'

type SubscribeRequest = { requestId: string; method: string }

type FakeDaemon = {
  socketPath: string
  connections: net.Socket[]
  close: () => Promise<void>
}

const dirs: string[] = []
const clients: DaemonClient[] = []

function tempSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-daemon-ack-'))
  dirs.push(dir)
  return path.join(dir, 'daemon.sock')
}

function startFakeDaemon(
  socketPath: string,
  onSubscribe: (request: SubscribeRequest, connection: net.Socket, connectionIndex: number) => void,
): Promise<FakeDaemon> {
  const connections: net.Socket[] = []
  const server = net.createServer((socket) => {
    const index = connections.push(socket) - 1
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          const parsed = JSON.parse(line) as SubscribeRequest
          if (parsed.method === 'daemon.subscribe') onSubscribe(parsed, socket, index)
        }
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        connections,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of connections) socket.destroy()
            server.close(() => done())
          }),
      }),
    )
  })
}

function ack(socket: net.Socket, requestId: string): void {
  socket.write(`${JSON.stringify({ requestId, ok: true, result: { subscribed: true } })}\n`)
}

function makeClient(socketPath: string): DaemonClient {
  const client = new DaemonClient(socketPath)
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('DaemonClient subscription ACK (S55-2B-1B)', () => {
  it('resolves waitForConnection only after the subscribe ACK, not on TCP connect', async () => {
    const socketPath = tempSocketPath()
    let connected = 0
    const daemon = await startFakeDaemon(socketPath, (request, socket) => {
      // 延迟 ACK，验证 wait 在 TCP connect 后仍等待。
      setTimeout(() => ack(socket, request.requestId), 30)
    })
    try {
      const client = makeClient(socketPath)
      client.subscribe(
        () => {},
        () => {
          connected += 1
        },
      )
      expect(connected).toBe(0)
      const ok = await client.waitForConnection(2_000)
      expect(ok).toBe(true)
      expect(connected).toBe(1)
    } finally {
      await daemon.close()
    }
  })

  it('ignores an ACK whose requestId does not match the pending subscription', async () => {
    const socketPath = tempSocketPath()
    const daemon = await startFakeDaemon(socketPath, (request, socket, index) => {
      if (index === 0) {
        // 先发一个不属于当前请求的 ACK（模拟旧连接的迟到 ACK），不得解除等待。
        ack(socket, 'sub-stale-request-id')
        setTimeout(() => ack(socket, request.requestId), 40)
      }
    })
    try {
      const client = makeClient(socketPath)
      client.subscribe(() => {})
      const ok = await client.waitForConnection(2_000)
      expect(ok).toBe(true)
    } finally {
      await daemon.close()
    }
  })

  it('settles pending waiters with false when the connection drops before ACK', async () => {
    const socketPath = tempSocketPath()
    const daemon = await startFakeDaemon(socketPath, (_request, socket) => {
      // 不 ACK，直接断开。
      setTimeout(() => socket.destroy(), 20)
    })
    try {
      const client = makeClient(socketPath)
      client.subscribe(() => {})
      const ok = await client.waitForConnection(2_000)
      expect(ok).toBe(false)
    } finally {
      await daemon.close()
    }
  })

  it('times out with false and cleans up; a later ACK does not leak into the next wait', async () => {
    const socketPath = tempSocketPath()
    const daemon = await startFakeDaemon(socketPath, (request, socket, index) => {
      // 第一连接延迟 120ms ACK（超过 40ms 等待）；第二连接立即 ACK。
      setTimeout(() => ack(socket, request.requestId), index === 0 ? 120 : 0)
    })
    try {
      const client = makeClient(socketPath)
      client.subscribe(() => {})
      const first = await client.waitForConnection(40)
      expect(first).toBe(false)
      // 旧 ACK 迟到后连接仍会进入 ready；后续等待立即可用。
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await client.waitForConnection(500)).toBe(true)
    } finally {
      await daemon.close()
    }
  })

  it('rejects the subscription when the daemon answers ok=false and reconnects', async () => {
    const socketPath = tempSocketPath()
    let attempts = 0
    const daemon = await startFakeDaemon(socketPath, (request, socket) => {
      attempts += 1
      if (attempts === 1) {
        socket.write(
          `${JSON.stringify({
            requestId: request.requestId,
            ok: false,
            error: { code: 'INTERNAL', message: 'subscribe rejected' },
          })}\n`,
        )
        return
      }
      ack(socket, request.requestId)
    })
    try {
      const client = makeClient(socketPath)
      client.subscribe(() => {})
      // 第一次被拒 → 客户端销毁连接（等待者以 false 结束）并退避重连；
      // 第二次 ACK 成功后新的等待立即成功。
      const first = await client.waitForConnection(5_000)
      expect(first).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(await client.waitForConnection(2_000)).toBe(true)
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      await daemon.close()
    }
  })
})
