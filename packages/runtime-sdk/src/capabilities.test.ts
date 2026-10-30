import { describe, expect, it } from 'vitest'
import { CAPABILITY_NAMES, isCapabilityUsable, ProviderCapabilities, RuntimeError } from './index'

const allNative = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'native',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
} as const

describe('ProviderCapabilities', () => {
  it('declares exactly the nine capabilities from ARCHITECTURE §5', () => {
    expect([...CAPABILITY_NAMES]).toEqual([
      'streaming',
      'structuredEvents',
      'interrupt',
      'resume',
      'checkpoint',
      'permissionRequests',
      'sessionPersistence',
      'workingDirectory',
      'toolControl',
    ])
  })

  it('accepts a fully declared capability record', () => {
    expect(ProviderCapabilities.parse(allNative)).toEqual(allNative)
  })

  it('rejects a missing capability (no implicit defaults)', () => {
    const { checkpoint: _omitted, ...partial } = allNative
    expect(ProviderCapabilities.safeParse(partial).success).toBe(false)
  })

  it('rejects an unknown support value', () => {
    expect(ProviderCapabilities.safeParse({ ...allNative, interrupt: 'partial' }).success).toBe(
      false,
    )
  })

  it('treats unsupported as unusable and native/emulated as usable', () => {
    const caps = ProviderCapabilities.parse({
      ...allNative,
      interrupt: 'unsupported',
      resume: 'emulated',
    })
    expect(isCapabilityUsable(caps, 'interrupt')).toBe(false)
    expect(isCapabilityUsable(caps, 'resume')).toBe(true)
    expect(isCapabilityUsable(caps, 'streaming')).toBe(true)
  })
})

describe('RuntimeError', () => {
  it('carries a stable code and message', () => {
    const error = new RuntimeError('CLI_UNAVAILABLE', 'claude not found')
    expect(error.code).toBe('CLI_UNAVAILABLE')
    expect(error.message).toBe('claude not found')
    expect(error).toBeInstanceOf(Error)
  })
})
