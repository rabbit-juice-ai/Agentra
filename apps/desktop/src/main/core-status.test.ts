import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { CORE_MAINTENANCE_STATUS_METHOD, EVENTS_SUBSCRIBE_METHOD } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { waitForCoreNormal } from './core-status'
import { CoreRpcClient } from './rpc-client'

type FakeCore = {
  socketPath: string
  methods: string[]
  close: () => Promise<void>
}

const dirs: string[] = []
const servers: FakeCore[] = []
const clients: CoreRpcClient[] = []

function tempSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-core-status-'))
  dirs.push(dir)
  return path.join(dir, 'core.sock')
}

/**
 * 真实 ws-over-UDS 假 Core：maintenance.status 按脚本序列返回；
 * 记录所有被调用的方法，用于断言 recovering 期零业务 RPC。
 */
function startFakeCore(socketPath: string, states: string[]): Promise<FakeCore> {
  const methods: string[] = []
  let index = 0
  const httpServer = http.createServer((_req, res) => res.writeHead(426).end('ws only'))
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as {
        requestId: string
        method: string
      }
      methods.push(request.method)
      if (request.method === CORE_MAINTENANCE_STATUS_METHOD) {
        const state = states[Math.min(index, states.length - 1)] ?? 'normal'
        index += 1
        socket.send(
          JSON.stringify({
            requestId: request.requestId,
            ok: true,
            result: {
              state,
              since: new Date().toISOString(),
              reason: null,
              writeGate: state === 'normal' ? 'open' : 'closed',
              lastBlockedOperation: null,
              drain: {
                accepting: true,
                counts: {
                  'rpc-mutation': 0,
                  'scheduler-tick': 0,
                  'execution-start': 0,
                  'daemon-call': 0,
                  'artifact-write': 0,
                  'backup-write': 0,
                  'worktree-write': 0,
                  'provider-refresh': 0,
                  'workflow-kick': 0,
                  'event-handler': 0,
                },
                total: 0,
                lastBlockedCategory: null,
                lastBlockedOperation: null,
              },
            },
          }),
        )
        return
      }
      if (request.method === EVENTS_SUBSCRIBE_METHOD) {
        socket.send(
          JSON.stringify({ requestId: request.requestId, ok: true, result: { subscribed: true } }),
        )
        return
      }
      socket.send(
        JSON.stringify({
          requestId: request.requestId,
          ok: false,
          error: { code: 'METHOD_NOT_FOUND', message: 'unknown method' },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    httpServer.listen(socketPath, () => {
      servers.push({
        socketPath,
        methods,
        close: () =>
          new Promise<void>((done) => {
            wss.close()
            httpServer.close(() => done())
          }),
      })
      resolve(servers[servers.length - 1] as FakeCore)
    })
  })
}

async function connect(socketPath: string): Promise<CoreRpcClient> {
  const client = new CoreRpcClient(socketPath)
  await client.connect()
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('waitForCoreNormal (S55-2B-1B R2)', () => {
  it('polls only maintenance.status through booting/recovering, then returns on normal', async () => {
    const socketPath = tempSocketPath()
    const core = await startFakeCore(socketPath, ['booting', 'recovering', 'normal'])
    const client = await connect(socketPath)

    await waitForCoreNormal(client, { budgetMs: 5_000, pollIntervalMs: 10 })

    // 等待期间只允许 maintenance.status；events.subscribe 不得在 normal 前发出。
    expect(core.methods.every((method) => method === CORE_MAINTENANCE_STATUS_METHOD)).toBe(true)
    expect(core.methods.length).toBeGreaterThanOrEqual(3)
  })

  it('fails fast on recovery_locked without issuing business RPCs', async () => {
    const socketPath = tempSocketPath()
    const core = await startFakeCore(socketPath, ['recovering', 'recovery_locked'])
    const client = await connect(socketPath)

    await expect(
      waitForCoreNormal(client, { budgetMs: 5_000, pollIntervalMs: 10 }),
    ).rejects.toThrow(/recovery_locked/)
    expect(core.methods).not.toContain(EVENTS_SUBSCRIBE_METHOD)
  })

  it('fails fast on shutting_down', async () => {
    const socketPath = tempSocketPath()
    await startFakeCore(socketPath, ['shutting_down'])
    const client = await connect(socketPath)
    await expect(
      waitForCoreNormal(client, { budgetMs: 5_000, pollIntervalMs: 10 }),
    ).rejects.toThrow(/shutting_down/)
  })

  it('times out with a bounded budget while core stays in recovering', async () => {
    const socketPath = tempSocketPath()
    const core = await startFakeCore(socketPath, ['recovering'])
    const client = await connect(socketPath)

    await expect(waitForCoreNormal(client, { budgetMs: 200, pollIntervalMs: 20 })).rejects.toThrow(
      /did not reach normal/,
    )
    expect(core.methods.every((method) => method === CORE_MAINTENANCE_STATUS_METHOD)).toBe(true)
  })

  it('returns immediately when the core is already normal', async () => {
    const socketPath = tempSocketPath()
    const core = await startFakeCore(socketPath, ['normal'])
    const client = await connect(socketPath)
    await waitForCoreNormal(client, { budgetMs: 1_000, pollIntervalMs: 10 })
    expect(core.methods).toEqual([CORE_MAINTENANCE_STATUS_METHOD])
  })
})
