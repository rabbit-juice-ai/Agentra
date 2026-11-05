import { describe, expect, it } from 'vitest'
import {
  DRAIN_CATEGORIES,
  DrainClosedError,
  DrainCoordinator,
  DrainNotIdleError,
} from './drain-coordinator'

describe('DrainCoordinator', () => {
  it('tracks sync leases and releases exactly once', () => {
    const drain = new DrainCoordinator()
    const lease = drain.acquire('artifact-write', 'artifact:1')
    expect(drain.snapshot()).toMatchObject({
      accepting: true,
      total: 1,
      counts: { 'artifact-write': 1 },
    })
    expect(lease.release()).toBe(true)
    expect(lease.release()).toBe(false)
    expect(drain.snapshot()).toMatchObject({
      total: 0,
      counts: { 'artifact-write': 0 },
    })
  })

  it('tracks async leases and releases on success and failure', async () => {
    const drain = new DrainCoordinator()
    await drain.runAsync('scheduler-tick', 'tick:1', async () => {
      expect(drain.snapshot().counts['scheduler-tick']).toBe(1)
    })
    expect(drain.snapshot().counts['scheduler-tick']).toBe(0)

    await expect(
      drain.runAsync('workflow-kick', 'kick:1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(drain.snapshot().counts['workflow-kick']).toBe(0)
  })

  it('tracks every category without losing counts', () => {
    const drain = new DrainCoordinator()
    const leases = DRAIN_CATEGORIES.map((category) => drain.acquire(category, `test:${category}`))
    expect(drain.snapshot().total).toBe(DRAIN_CATEGORIES.length)
    for (const category of DRAIN_CATEGORIES) {
      expect(drain.snapshot().counts[category]).toBe(1)
    }
    for (const lease of leases) lease.release()
    expect(drain.snapshot().total).toBe(0)
  })

  it('rejects new ordinary leases after close, but allows existing leases to finish', async () => {
    const drain = new DrainCoordinator()
    const lease = drain.acquire('rpc-mutation', 'rpc:create')
    drain.close()
    expect(() => drain.acquire('rpc-mutation', 'rpc:other')).toThrow(DrainClosedError)
    expect(drain.snapshot()).toMatchObject({
      accepting: false,
      total: 1,
      lastBlockedCategory: 'rpc-mutation',
      lastBlockedOperation: 'rpc:other',
    })
    lease.release()
    expect(drain.snapshot().total).toBe(0)
  })

  it('waits for all leases and reports success', async () => {
    const drain = new DrainCoordinator()
    const lease = drain.acquire('execution-start', 'execution:1')
    const pending = drain.drain(1_000)
    setTimeout(() => lease.release(), 5)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.snapshot.total).toBe(0)
  })

  it('returns a diagnostic timeout instead of pretending success', async () => {
    const drain = new DrainCoordinator()
    const lease = drain.acquire('event-handler', 'event:output')
    const result = await drain.drain(5)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.snapshot).toMatchObject({
      accepting: false,
      total: 1,
      counts: { 'event-handler': 1 },
    })
    lease.release()
  })

  it('does not allow reopen while leases are active', () => {
    const drain = new DrainCoordinator()
    const lease = drain.acquire('backup-write', 'backup:1')
    drain.close()
    expect(() => drain.reopen()).toThrow(DrainNotIdleError)
    lease.release()
    drain.reopen()
    expect(drain.snapshot().accepting).toBe(true)
  })

  it('allows controlled internal leases after close', () => {
    const drain = new DrainCoordinator()
    drain.close()
    const lease = drain.acquire('backup-write', 'internal:pre-restore', { internal: true })
    expect(drain.snapshot().total).toBe(1)
    lease.release()
    expect(drain.snapshot().total).toBe(0)
  })
})
