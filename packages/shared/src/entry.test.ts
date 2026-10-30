import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDirectRun } from './entry'

const selfPath = fileURLToPath(import.meta.url)

describe('isDirectRun', () => {
  it('is true when argv entry is this module', () => {
    expect(isDirectRun(import.meta.url, selfPath)).toBe(true)
  })

  it('resolves a relative argv entry against cwd', () => {
    expect(isDirectRun(import.meta.url, path.relative(process.cwd(), selfPath))).toBe(true)
  })

  it('is false when argv entry is a different module', () => {
    expect(isDirectRun(import.meta.url, '/tmp/some-other-entry.js')).toBe(false)
  })

  it('is false when argv entry is missing', () => {
    expect(isDirectRun(import.meta.url, undefined)).toBe(false)
  })
})
