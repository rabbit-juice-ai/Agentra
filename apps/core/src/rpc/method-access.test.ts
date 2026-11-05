import {
  AGENT_LIST_METHOD,
  BACKUP_CREATE_METHOD,
  CORE_HEALTH_METHOD,
  CORE_MAINTENANCE_STATUS_METHOD,
  createDispatcher,
  defineMethod,
  EVENTS_SUBSCRIBE_METHOD,
  PROTOCOL_VERSION,
} from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { MaintenanceController } from '../lifecycle/maintenance-controller'
import { MAINTENANCE_READ_METHODS } from '../lifecycle/rpc-policy'
import { type CoreMethodServices, coreMethods } from './methods'

const request = (method: string, params: unknown = {}): string =>
  JSON.stringify({
    requestId: 'req-00000001',
    protocolVersion: PROTOCOL_VERSION,
    method,
    params,
  })

function fakeServices(): CoreMethodServices {
  return {
    agents: { list: () => [] },
    registry: { list: () => [] },
    executions: {},
    hub: { subscribe: () => () => {} },
    teams: {},
    works: {},
    assignments: {},
    worktrees: {},
    workflows: {},
    workflowRuns: {},
    approvals: {},
    artifacts: {},
    backups: {},
    backupPrecheck: {},
  } as unknown as CoreMethodServices
}

describe('RPC access classification and maintenance gate', () => {
  it('classifies every registered method and marks all read methods explicitly', () => {
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
      maintenance,
      drain,
    })

    let readCount = 0
    let writeCount = 0
    for (const [method, definition] of Object.entries(methods)) {
      expect(['read', 'write']).toContain(definition.access)
      if (definition.access === 'read') {
        readCount += 1
        expect(MAINTENANCE_READ_METHODS.has(method)).toBe(true)
      } else {
        writeCount += 1
        expect(MAINTENANCE_READ_METHODS.has(method)).toBe(false)
      }
    }
    expect(readCount).toBeGreaterThan(0)
    expect(writeCount).toBeGreaterThan(0)
  })

  it('defaults unmarked methods to write', () => {
    const def = defineMethod(z.object({}).strict(), z.object({ ok: z.boolean() }), () => ({
      ok: true,
    }))
    expect(def.access).toBe('write')
    expect(
      defineMethod(
        z.object({}).strict(),
        z.object({ ok: z.boolean() }),
        () => ({ ok: true }),
        'read',
      ).access,
    ).toBe('read')
  })

  it('allows reads and rejects writes in entering_maintenance', async () => {
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
      maintenance,
      drain,
    })
    const dispatch = createDispatcher(methods, {
      authorize: (requestId, method, access) => maintenance.authorizeRpc(requestId, method, access),
    })

    maintenance.beginEnteringMaintenance()
    const read = await dispatch(request(AGENT_LIST_METHOD))
    expect(read.ok).toBe(true)

    const write = await dispatch(request(BACKUP_CREATE_METHOD))
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.code).toBe('MAINTENANCE_ACTIVE')

    const subscribe = await dispatch(request(EVENTS_SUBSCRIBE_METHOD), {
      push: () => {},
      onClose: () => {},
    })
    expect(subscribe.ok).toBe(true)
  })

  it('rejects writes in maintenance and keeps allowed reads working', async () => {
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
      maintenance,
      drain,
    })
    const dispatch = createDispatcher(methods, {
      authorize: (requestId, method, access) => maintenance.authorizeRpc(requestId, method, access),
    })

    maintenance.beginEnteringMaintenance()
    maintenance.confirmMaintenance()
    expect((await dispatch(request(AGENT_LIST_METHOD))).ok).toBe(true)
    const denied = await dispatch(request(BACKUP_CREATE_METHOD))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('MAINTENANCE_ACTIVE')
  })

  it('fails closed in recovery_locked except health/status', async () => {
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
      maintenance,
      drain,
    })
    const dispatch = createDispatcher(methods, {
      authorize: (requestId, method, access) => maintenance.authorizeRpc(requestId, method, access),
    })

    maintenance.enterRecoveryLocked()
    expect((await dispatch(request(CORE_HEALTH_METHOD))).ok).toBe(true)
    expect((await dispatch(request(CORE_MAINTENANCE_STATUS_METHOD))).ok).toBe(true)

    const readDenied = await dispatch(request(AGENT_LIST_METHOD))
    expect(readDenied.ok).toBe(false)
    if (!readDenied.ok) expect(readDenied.error.code).toBe('RECOVERY_LOCKED')

    const subscribeDenied = await dispatch(request(EVENTS_SUBSCRIBE_METHOD), {
      push: () => {},
      onClose: () => {},
    })
    expect(subscribeDenied.ok).toBe(false)
    if (!subscribeDenied.ok) expect(subscribeDenied.error.code).toBe('RECOVERY_LOCKED')
  })

  it('fails closed in booting/recovering with RECOVERY_LOCKED and detail.state', async () => {
    for (const phase of ['booting', 'recovering'] as const) {
      const maintenance = new MaintenanceController()
      const drain = new DrainCoordinator()
      const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
        maintenance,
        drain,
      })
      const dispatch = createDispatcher(methods, {
        authorize: (requestId, method, access) =>
          maintenance.authorizeRpc(requestId, method, access),
      })

      maintenance.enterBooting()
      if (phase === 'recovering') maintenance.beginRecovering()

      expect((await dispatch(request(CORE_HEALTH_METHOD))).ok).toBe(true)
      expect((await dispatch(request(CORE_MAINTENANCE_STATUS_METHOD))).ok).toBe(true)

      for (const method of [AGENT_LIST_METHOD, BACKUP_CREATE_METHOD]) {
        const denied = await dispatch(request(method))
        expect(denied.ok).toBe(false)
        if (!denied.ok) {
          expect(denied.error.code).toBe('RECOVERY_LOCKED')
          expect(denied.error.detail).toMatchObject({ state: phase })
        }
      }
      const subscribeDenied = await dispatch(request(EVENTS_SUBSCRIBE_METHOD), {
        push: () => {},
        onClose: () => {},
      })
      expect(subscribeDenied.ok).toBe(false)
      if (!subscribeDenied.ok) expect(subscribeDenied.error.code).toBe('RECOVERY_LOCKED')
    }
  })

  it('does not change normal-state RPC behavior', async () => {
    const maintenance = new MaintenanceController()
    const drain = new DrainCoordinator()
    const methods = coreMethods('0.1.0', '/tmp/daemon.sock', fakeServices(), {
      maintenance,
      drain,
    })
    const dispatch = createDispatcher(methods, {
      authorize: (requestId, method, access) => maintenance.authorizeRpc(requestId, method, access),
    })
    expect((await dispatch(request(AGENT_LIST_METHOD))).ok).toBe(true)
    expect((await dispatch(request(CORE_HEALTH_METHOD))).ok).toBe(true)
  })
})
