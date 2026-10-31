import { describe, expect, it } from 'vitest'
import { ApiError, unwrap } from './api'

describe('ApiError detail 透传', () => {
  it('carries detail from the RPC failure into ApiError', async () => {
    const detail = {
      violations: [{ violation: 'start_invalid', message: 'expected exactly one start node' }],
    }
    try {
      await unwrap(
        Promise.resolve({
          ok: false as const,
          error: { code: 'INVALID_PARAMS', message: 'workflow definition is invalid', detail },
        }),
      )
      throw new Error('expected unwrap to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INVALID_PARAMS')
      expect(apiError.message).toBe('workflow definition is invalid')
      expect(apiError.detail).toEqual(detail)
    }
  })

  it('leaves detail undefined when the failure has none', async () => {
    try {
      await unwrap(
        Promise.resolve({
          ok: false as const,
          error: { code: 'INTERNAL', message: 'boom' },
        }),
      )
    } catch (error) {
      expect((error as ApiError).detail).toBeUndefined()
    }
  })

  it('returns the result on success', async () => {
    await expect(
      unwrap(Promise.resolve({ ok: true as const, result: { value: 1 } })),
    ).resolves.toEqual({
      value: 1,
    })
  })
})
