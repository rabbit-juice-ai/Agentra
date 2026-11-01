import { describe, expect, it } from 'vitest'
import { assertCoreSocketAvailable } from './core-instance-guard'

describe('assertCoreSocketAvailable', () => {
  it('refuses to start when another Core is live', async () => {
    await expect(assertCoreSocketAvailable('/tmp/core.sock', async () => 'live')).rejects.toThrow(
      /another Core instance is already listening/,
    )
  })

  it('allows startup when the socket is absent or unknown', async () => {
    await expect(assertCoreSocketAvailable('/tmp/core.sock', async () => 'absent')).resolves.toBe(
      undefined,
    )
    await expect(assertCoreSocketAvailable('/tmp/core.sock', async () => 'unknown')).resolves.toBe(
      undefined,
    )
  })
})
