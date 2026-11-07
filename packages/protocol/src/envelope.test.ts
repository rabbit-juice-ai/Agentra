import { describe, expect, it } from 'vitest'
import {
  CORE_HEALTH_METHOD,
  HealthResult,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  RpcMethodError,
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

describe('RpcError 与 26 个错误码', () => {
  it('exposes exactly 26 codes including maintenance, recovery, restore and skill codes', () => {
    expect(RpcErrorCode.options).toHaveLength(26)
    expect(RpcErrorCode.options).toContain('SKILL_NOT_FOUND')
    expect(RpcErrorCode.options).toContain('UNKNOWN_NODE_TYPE')
    expect(RpcErrorCode.options).toContain('MAINTENANCE_ACTIVE')
    expect(RpcErrorCode.options).toContain('RECOVERY_LOCKED')
    expect(RpcErrorCode.options).toContain('SHUTTING_DOWN')
    expect(RpcErrorCode.options).toContain('RESTORE_ALREADY_ACTIVE')
    expect(RpcErrorCode.options).toContain('RESTORE_PRECHECK_FAILED')
    expect(RpcErrorCode.options).toContain('RESTORE_DRAIN_TIMEOUT')
    expect(RpcErrorCode.options).toContain('RESTORE_CHECKPOINT_BUSY')
    expect(RpcErrorCode.options).toContain('RESTORE_JOURNAL_INVALID')
    expect(RpcErrorCode.options).toContain('RESTORE_FILESYSTEM_CONFLICT')
    expect(RpcErrorCode.options).toContain('RESTORE_INSUFFICIENT_SPACE')
  })

  it('keeps the envelope without detail backward compatible', () => {
    expect(RpcError.parse({ code: 'INVALID_PARAMS', message: 'bad' })).toEqual({
      code: 'INVALID_PARAMS',
      message: 'bad',
    })
  })

  it('carries structured detail when provided', () => {
    const failure = rpcFailure('req-12345678', 'INVALID_PARAMS', 'bad definition', {
      violations: [{ violation: 'cycle', message: 'has a cycle' }],
    })
    expect(failure.error.detail).toEqual({
      violations: [{ violation: 'cycle', message: 'has a cycle' }],
    })
  })

  it('RpcMethodError keeps code, message and detail', () => {
    const error = new RpcMethodError('UNKNOWN_NODE_TYPE', 'bad type', { nodeKey: 'x' })
    expect(error.code).toBe('UNKNOWN_NODE_TYPE')
    expect(error.detail).toEqual({ nodeKey: 'x' })
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
