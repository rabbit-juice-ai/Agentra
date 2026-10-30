import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CORE_HEALTH_METHOD,
  DAEMON_HEALTH_METHOD,
  PROTOCOL_VERSION,
  type RpcResponse,
} from '@agentra/protocol'
import { type AgentraPaths, agentraPaths, ensureDirs } from '@agentra/shared'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { pidAlive, probeSocket } from './daemon-launcher'

const dirs: string[] = []

function tempHome(): AgentraPaths {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentra-core-'))
  dirs.push(dir)
  // runtime/ 目录必须存在，UDS 才能 bind；生产路径由 ensureDirs 保证。
  const paths = agentraPaths(dir)
  ensureDirs(paths)
  return paths
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('probeSocket', () => {
  it('reports absent for a non-existent socket', async () => {
    const p = tempHome()
    expect(await probeSocket(p.daemonSocket)).toBe('absent')
  })

  it('reports live when a server is listening', async () => {
    const p = tempHome()
    const server = net.createServer(() => {})
    await new Promise<void>((resolve) => server.listen(p.daemonSocket, resolve))
    try {
      expect(await probeSocket(p.daemonSocket)).toBe('live')
    } finally {
      server.close()
    }
  })
})

describe('pidAlive', () => {
  it('returns false when the pid file is missing or garbage', () => {
    const p = tempHome()
    expect(pidAlive(p.corePid)).toBe(false)
    writeFileSync(p.corePid, 'not json')
    expect(pidAlive(p.corePid)).toBe(false)
  })

  it('returns false for a dead pid, true for a live one', () => {
    const p = tempHome()
    // pid 1 在 macOS 上恒存在（launchd），不依赖随机进程。
    writeFileSync(p.corePid, JSON.stringify({ pid: 1 }))
    expect(pidAlive(p.corePid)).toBe(true)
    // 一个几乎不可能复用的 pid：手动搜索残留进程会极慢，直接断言一个已退出子进程。
    const child = spawnSync('true')
    if (child.pid) {
      writeFileSync(p.corePid, JSON.stringify({ pid: child.pid }))
      expect(pidAlive(p.corePid)).toBe(false)
    }
  })
})

describe('core ws server round trip (real components, no Electron)', () => {
  it('answers core.health over WS-on-UDS', async () => {
    const { startWsServer } = await import('./rpc/ws-server')
    const { coreHealthMethods } = await import('./services/health')
    const p = tempHome()
    const server = await startWsServer(p.coreSocket, coreHealthMethods('0.1.0', p.daemonSocket))

    try {
      const res = await new Promise<RpcResponse>((resolve, reject) => {
        const ws = new WebSocket(`ws+unix://${p.coreSocket}:`)
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              requestId: 'req-ws-00001',
              protocolVersion: PROTOCOL_VERSION,
              method: CORE_HEALTH_METHOD,
              params: {},
            }),
          ),
        )
        ws.on('message', (data) => {
          resolve(JSON.parse(String(data)) as RpcResponse)
          ws.close()
        })
        ws.on('error', reject)
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        const result = res.result as Record<string, unknown>
        expect(result.service).toBe('core')
        expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
      }
    } finally {
      server.close()
    }
  })

  it('core.health responds even when daemon is absent (proxy error surfaces as failure)', async () => {
    const { startWsServer } = await import('./rpc/ws-server')
    const { coreHealthMethods } = await import('./services/health')
    const p = tempHome()
    const server = await startWsServer(p.coreSocket, coreHealthMethods('0.1.0', p.daemonSocket))
    try {
      const res = await new Promise<RpcResponse>((resolve, reject) => {
        const ws = new WebSocket(`ws+unix://${p.coreSocket}:`)
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              requestId: 'req-ws-00002',
              protocolVersion: PROTOCOL_VERSION,
              method: DAEMON_HEALTH_METHOD,
              params: {},
            }),
          ),
        )
        ws.on('message', (data) => {
          resolve(JSON.parse(String(data)) as RpcResponse)
          ws.close()
        })
        ws.on('error', reject)
      })
      // daemon 未启动：代理失败应回结构化 INTERNAL 错误，而不是挂死或崩溃。
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.code).toBe('INTERNAL')
    } finally {
      server.close()
    }
  })
})
