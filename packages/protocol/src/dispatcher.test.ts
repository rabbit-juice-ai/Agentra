import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createDispatcher,
  defineMethod,
  type MethodTable,
  PROTOCOL_VERSION,
  RpcMethodError,
} from './index'

const EchoParams = z.object({ text: z.string().min(1) }).strict()
const EchoResult = z.object({ echoed: z.string() })

function table(overrides: Partial<MethodTable> = {}): MethodTable {
  return {
    'test.echo': defineMethod(EchoParams, EchoResult, (params) => ({ echoed: params.text })),
    'test.boom': defineMethod(EchoParams, EchoResult, () => {
      throw new RpcMethodError('CLI_UNAVAILABLE', 'cli missing')
    }),
    'test.detail': defineMethod(EchoParams, EchoResult, () => {
      throw new RpcMethodError('INVALID_PARAMS', 'bad definition', {
        violations: [{ violation: 'cycle', message: 'graph contains a directed cycle' }],
      })
    }),
    ...overrides,
  }
}

function request(method: string, params: unknown, protocolVersion: string = PROTOCOL_VERSION) {
  return JSON.stringify({ requestId: 'req-00000001', protocolVersion, method, params })
}

describe('createDispatcher (B4：params 与 result 双向绑定)', () => {
  it('returns the parsed result for a valid request', async () => {
    const dispatch = createDispatcher(table())
    const response = await dispatch(request('test.echo', { text: 'hi' }))
    expect(response).toEqual({
      requestId: 'req-00000001',
      ok: true,
      result: { echoed: 'hi' },
    })
  })

  it('rejects params that violate the params schema', async () => {
    const dispatch = createDispatcher(table())
    const response = await dispatch(request('test.echo', { text: '' }))
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('INVALID_PARAMS')
  })

  it('rejects a handler result that violates its result schema', async () => {
    const dispatch = createDispatcher(
      table({
        // 故意绕过类型：模拟实现与契约漂移（真实场景里通常是 schema 改了、handler 没跟上）
        'test.drifted': defineMethod(
          EchoParams,
          EchoResult,
          () => ({ wrong: 1 }) as unknown as { echoed: string },
        ),
      }),
    )
    const response = await dispatch(request('test.drifted', { text: 'x' }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL')
      expect(response.error.message).toContain('violates its result schema')
    }
  })

  it('preserves RpcMethodError codes instead of collapsing to INTERNAL', async () => {
    const dispatch = createDispatcher(table())
    const response = await dispatch(request('test.boom', { text: 'x' }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('CLI_UNAVAILABLE')
      expect(response.error.message).toBe('cli missing')
    }
  })

  it('forwards RpcMethodError.detail into the error envelope', async () => {
    const dispatch = createDispatcher(table())
    const response = await dispatch(request('test.detail', { text: 'x' }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_PARAMS')
      expect(response.error.detail).toEqual({
        violations: [{ violation: 'cycle', message: 'graph contains a directed cycle' }],
      })
    }
  })

  it('reports METHOD_NOT_FOUND, VERSION_MISMATCH and PARSE_ERROR', async () => {
    const dispatch = createDispatcher(table())
    const notFound = await dispatch(request('no.such.method', {}))
    expect(notFound.ok).toBe(false)
    if (!notFound.ok) expect(notFound.error.code).toBe('METHOD_NOT_FOUND')

    const mismatch = await dispatch(request('test.echo', { text: 'x' }, '999'))
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('VERSION_MISMATCH')

    const broken = await dispatch('not json')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error.code).toBe('PARSE_ERROR')
  })

  it('passes the per-connection context through to the handler', async () => {
    const pushed: unknown[] = []
    let closed = false
    const dispatch = createDispatcher({
      'test.subscribe': defineMethod(EchoParams, EchoResult, (_params, ctx) => {
        ctx.push({ type: 'event' })
        ctx.onClose(() => {
          closed = true
        })
        return { echoed: 'subscribed' }
      }),
    })
    await dispatch(request('test.subscribe', { text: 'x' }), {
      push: (frame) => pushed.push(frame),
      onClose: (listener) => listener(),
    })
    expect(pushed).toEqual([{ type: 'event' }])
    expect(closed).toBe(true)
  })
})
