import { describe, expect, it } from 'vitest'
import {
  CORE_HEALTH_METHOD,
  HealthResult,
  PROTOCOL_VERSION,
  RpcRequest,
  RpcResponse,
  rpcFailure,
  rpcSuccess,
} from './index'

describe('protocol version', () => {
  it('exports a string version', () => {
    expect(typeof PROTOCOL_VERSION).toBe('string')
    expect(PROTOCOL_VERSION.length).toBeGreaterThan(0)
  })
})

describe('RpcRequest envelope', () => {
  const valid = {
    requestId: 'req-12345678',
    protocolVersion: PROTOCOL_VERSION,
    method: CORE_HEALTH_METHOD,
    params: {},
  }

  it('accepts a valid request', () => {
    expect(RpcRequest.parse(valid)).toEqual(valid)
  })

  it('rejects a short requestId', () => {
    expect(RpcRequest.safeParse({ ...valid, requestId: 'short' }).success).toBe(false)
  })

  it('rejects a wrong protocolVersion', () => {
    expect(RpcRequest.safeParse({ ...valid, protocolVersion: '999' }).success).toBe(false)
  })

  it('rejects an empty method', () => {
    expect(RpcRequest.safeParse({ ...valid, method: '' }).success).toBe(false)
  })
})

describe('HealthResult', () => {
  it('accepts a valid health result', () => {
    expect(
      HealthResult.parse({
        status: 'ok',
        service: 'core',
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeSeconds: 1.5,
        version: '0.1.0',
      }).status,
    ).toBe('ok')
  })

  it('rejects an unknown service', () => {
    expect(
      HealthResult.safeParse({
        status: 'ok',
        service: 'other',
        protocolVersion: PROTOCOL_VERSION,
        pid: 1,
        uptimeSeconds: 0,
        version: '0.1.0',
      }).success,
    ).toBe(false)
  })
})

describe('response helpers', () => {
  it('rpcSuccess produces a valid RpcResponse', () => {
    const res = rpcSuccess('req-12345678', { a: 1 })
    expect(RpcResponse.parse(res)).toEqual(res)
  })

  it('rpcFailure produces a valid RpcResponse with a code', () => {
    const res = rpcFailure('req-12345678', 'METHOD_NOT_FOUND', 'unknown method: x')
    expect(RpcResponse.parse(res)).toEqual(res)
  })

  it('rpcFailure rejects an unknown code', () => {
    expect(() => rpcFailure('req-12345678', 'NOPE' as never, 'x')).toThrow()
  })
})
