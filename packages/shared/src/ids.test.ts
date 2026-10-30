import { describe, expect, it } from 'vitest'
import { newId } from './ids'

describe('newId', () => {
  it('generates ids at least 8 chars long with the prefix', () => {
    const id = newId('req')
    expect(id.startsWith('req-')).toBe(true)
    expect(id.length).toBeGreaterThanOrEqual(8)
  })

  it('generates unique ids', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newId()))
    expect(seen.size).toBe(100)
  })
})
