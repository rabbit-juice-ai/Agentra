import { describe, expect, it } from 'vitest'
import { DrainCoordinator } from './drain-coordinator'
import { PersistenceGate, PersistenceGateClosedError } from './persistence-gate'

describe('PersistenceGate', () => {
  it('allows normal leases while open', () => {
    const drain = new DrainCoordinator()
    const gate = new PersistenceGate(drain)
    const lease = gate.acquire('artifact-write', 'artifact:1')
    expect(gate.state).toBe('open')
    expect(gate.snapshot().drain.counts['artifact-write']).toBe(1)
    lease.release()
    expect(gate.snapshot().drain.total).toBe(0)
  })

  it('rejects new ordinary leases while closing and lets existing leases finish', async () => {
    const drain = new DrainCoordinator()
    const gate = new PersistenceGate(drain)
    const lease = gate.acquire('worktree-write', 'worktree:1')
    gate.close()
    expect(gate.state).toBe('closing')
    expect(() => gate.acquire('worktree-write', 'worktree:2')).toThrow(PersistenceGateClosedError)

    const pending = gate.closeAndDrain(1_000)
    setTimeout(() => lease.release(), 5)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(gate.state).toBe('closed')
    expect(() => gate.acquire('backup-write', 'backup:1')).toThrow(PersistenceGateClosedError)
  })

  it('returns a timeout and stays closing when leases remain', async () => {
    const drain = new DrainCoordinator()
    const gate = new PersistenceGate(drain)
    const lease = gate.acquire('backup-write', 'backup:1')
    const result = await gate.closeAndDrain(5)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(gate.state).toBe('closing')
    lease.release()
  })

  it('supports controlled internal writes without accepting RPC-shaped input', async () => {
    const drain = new DrainCoordinator()
    const gate = new PersistenceGate(drain)
    gate.close()

    const result = await gate.runInternal('backup-write', 'internal:pre-restore', async () => {
      expect(gate.snapshot().drain.counts['backup-write']).toBe(1)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(gate.snapshot().drain.total).toBe(0)
  })

  it('rejects internal writes after closed and reopens only when idle', async () => {
    const drain = new DrainCoordinator()
    const gate = new PersistenceGate(drain)
    await gate.closeAndDrain(1_000)
    expect(gate.state).toBe('closed')
    await expect(
      gate.runInternal('artifact-write', 'internal:late', async () => 'no'),
    ).rejects.toThrow(PersistenceGateClosedError)

    gate.reopen()
    expect(gate.state).toBe('open')
    expect(gate.snapshot().drain.accepting).toBe(true)
  })
})
