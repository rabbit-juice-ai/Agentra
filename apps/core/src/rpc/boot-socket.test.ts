import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_CREATE_METHOD,
  CORE_HEALTH_METHOD,
  CORE_MAINTENANCE_STATUS_METHOD,
  EVENTS_SUBSCRIBE_METHOD,
  PROTOCOL_VERSION,
  type RpcResponse,
} from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { MaintenanceController } from '../lifecycle/maintenance-controller'
import { startBootSocket } from './boot-socket'

const dirs: string[] = []
const servers: Array<{ close: () => void }> = []

function tempSocket(): { socketPath: string; daemonSocket: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-boot-'))
  dirs.push(dir)
  return {
    socketPath: path.join(dir, 'boot.sock'),
    daemonSocket: path.join(dir, 'daemon.sock'),
  }
}

function call(socketPath: string, method: string, params: unknown = {}): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:`)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
          protocolVersion: PROTOCOL_VERSION,
          method,
          params,
        }),
      ),
    )
    ws.on('message', (data) => {
      resolve(JSON.parse(String(data)) as RpcResponse)
      ws.close()
    })
    ws.on('error', reject)
  })
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('minimal boot socket (S55-2B-1B)', () => {
  it('serves only health/status and reflects booting/recovering/recovery_locked', async () => {
    const { socketPath, daemonSocket } = tempSocket()
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    maintenance.enterBooting('boot')
    const server = await startBootSocket(socketPath, '0.1.0', daemonSocket, maintenance, drain)
    servers.push(server)

    // booting：status 如实报告，绝不 normal。
    const booting = await call(socketPath, CORE_MAINTENANCE_STATUS_METHOD)
    expect(booting.ok).toBe(true)
    if (booting.ok) expect((booting.result as { state: string }).state).toBe('booting')

    const health = await call(socketPath, CORE_HEALTH_METHOD)
    expect(health.ok).toBe(true)

    // 物理方法表只有两个方法：业务方法（含 events.subscribe）一律 METHOD_NOT_FOUND。
    for (const method of [EVENTS_SUBSCRIBE_METHOD, AGENT_CREATE_METHOD]) {
      const denied = await call(socketPath, method)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.code).toBe('METHOD_NOT_FOUND')
    }

    maintenance.beginRecovering('reconciliation')
    const recovering = await call(socketPath, CORE_MAINTENANCE_STATUS_METHOD)
    expect(recovering.ok).toBe(true)
    if (recovering.ok) expect((recovering.result as { state: string }).state).toBe('recovering')

    maintenance.enterRecoveryLocked('daemon_unavailable')
    const locked = await call(socketPath, CORE_MAINTENANCE_STATUS_METHOD)
    expect(locked.ok).toBe(true)
    if (locked.ok) expect((locked.result as { state: string }).state).toBe('recovery_locked')
    // recovery_locked 下 health 仍可用（诊断通道保留）。
    expect((await call(socketPath, CORE_HEALTH_METHOD)).ok).toBe(true)
  })

  it('reports normal only after completeBoot, and still exposes no business methods', async () => {
    const { socketPath, daemonSocket } = tempSocket()
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    maintenance.enterBooting('boot')
    const server = await startBootSocket(socketPath, '0.1.0', daemonSocket, maintenance, drain)
    servers.push(server)

    maintenance.beginRecovering('reconciliation')
    maintenance.completeBoot()

    const status = await call(socketPath, CORE_MAINTENANCE_STATUS_METHOD)
    expect(status.ok).toBe(true)
    if (status.ok) expect((status.result as { state: string }).state).toBe('normal')

    const denied = await call(socketPath, AGENT_CREATE_METHOD)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('METHOD_NOT_FOUND')
  })
})
