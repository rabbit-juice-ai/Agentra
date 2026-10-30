import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DAEMON_HEALTH_METHOD, PROTOCOL_VERSION, type RpcResponse } from '@agentra/protocol'
import { startNdjsonServer } from './rpc/ndjson-server'
import { daemonHealthMethods } from './services/health'
import { createDispatcher } from './rpc/dispatcher'

const dirs: string[] = []
const servers: { close: () => void }[] = []

function tempSocket(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentra-daemon-'))
  dirs.push(dir)
  return path.join(dir, 'd.sock')
}

afterAll(() => {
  for (const s of servers) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function sendLine(socketPath: string, line: object): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(line)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex !== -1) {
        const response = JSON.parse(buffer.slice(0, newlineIndex)) as RpcResponse
        socket.destroy()
        resolve(response)
      }
    })
    socket.on('error', reject)
  })
}

describe('daemon ndjson server', () => {
  it('answers daemon.health over a real UDS', async () => {
    const socketPath = tempSocket()
    const server = await startNdjsonServer(socketPath, daemonHealthMethods('0.1.0'))
    servers.push(server)

    const res = await sendLine(server.socketPath, {
      requestId: 'req-test-0001',
      protocolVersion: PROTOCOL_VERSION,
      method: DAEMON_HEALTH_METHOD,
      params: {},
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const result = res.result as Record<string, unknown>
      expect(result['service']).toBe('daemon')
      expect(result['protocolVersion']).toBe(PROTOCOL_VERSION)
      expect(typeof result['pid']).toBe('number')
    }
  })

  it('rejects unknown methods with METHOD_NOT_FOUND', async () => {
    const socketPath = tempSocket()
    const server = await startNdjsonServer(socketPath, daemonHealthMethods('0.1.0'))
    servers.push(server)

    const res = await sendLine(server.socketPath, {
      requestId: 'req-test-0002',
      protocolVersion: PROTOCOL_VERSION,
      method: 'no.such.method',
      params: {},
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('METHOD_NOT_FOUND')
  })

  it('rejects a version mismatch with VERSION_MISMATCH', async () => {
    const socketPath = tempSocket()
    const server = await startNdjsonServer(socketPath, daemonHealthMethods('0.1.0'))
    servers.push(server)

    const res = await sendLine(server.socketPath, {
      requestId: 'req-test-0003',
      protocolVersion: '999',
      method: DAEMON_HEALTH_METHOD,
      params: {},
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('VERSION_MISMATCH')
  })

  it('rejects invalid params with INVALID_PARAMS', async () => {
    const socketPath = tempSocket()
    const server = await startNdjsonServer(socketPath, daemonHealthMethods('0.1.0'))
    servers.push(server)

    const res = await sendLine(server.socketPath, {
      requestId: 'req-test-0004',
      protocolVersion: PROTOCOL_VERSION,
      method: DAEMON_HEALTH_METHOD,
      params: { unexpected: true },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INVALID_PARAMS')
  })

  it('dispatcher reports PARSE_ERROR for a non-JSON frame', async () => {
    const dispatch = createDispatcher(daemonHealthMethods('0.1.0'))
    const res = await dispatch('not json at all')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('PARSE_ERROR')
  })
})
