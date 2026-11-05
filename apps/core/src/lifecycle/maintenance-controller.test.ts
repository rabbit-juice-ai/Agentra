import {
  AGENT_LIST_METHOD,
  BACKUP_CREATE_METHOD,
  CORE_HEALTH_METHOD,
  CORE_MAINTENANCE_STATUS_METHOD,
  EVENTS_SUBSCRIBE_METHOD,
} from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import {
  MaintenanceBlockedError,
  MaintenanceController,
  MaintenanceTransitionError,
} from './maintenance-controller'

const NOW = '2026-11-03T00:00:00.000Z'

function controller(): MaintenanceController {
  return new MaintenanceController(() => NOW)
}

describe('MaintenanceController', () => {
  it('starts normal with open write gate', () => {
    const c = controller()
    expect(c.state).toBe('normal')
    expect(c.snapshot()).toEqual({
      state: 'normal',
      since: NOW,
      reason: null,
      writeGate: 'open',
      lastBlockedOperation: null,
    })
    expect(c.isWriteAllowed()).toBe(true)
    expect(c.isSchedulerAllowed()).toBe(true)
    expect(c.isExecutionStartAllowed()).toBe(true)
    expect(c.isEventIngressAllowed()).toBe(true)
  })

  it('supports normal -> entering_maintenance -> maintenance', () => {
    const c = controller()
    c.beginEnteringMaintenance('restore')
    expect(c.snapshot()).toMatchObject({
      state: 'entering_maintenance',
      reason: 'restore',
      writeGate: 'closing',
    })
    expect(c.isWriteAllowed()).toBe(false)
    expect(c.isSchedulerAllowed()).toBe(false)
    expect(c.isExecutionStartAllowed()).toBe(false)
    expect(c.isEventIngressAllowed()).toBe(true)

    c.confirmMaintenance()
    expect(c.snapshot()).toMatchObject({ state: 'maintenance', writeGate: 'closed' })
    expect(c.isWriteAllowed()).toBe(false)
    expect(c.isEventIngressAllowed()).toBe(false)
  })

  it('aborts entering_maintenance back to normal', () => {
    const c = controller()
    c.beginEnteringMaintenance()
    c.abortEnteringMaintenance()
    expect(c.snapshot()).toMatchObject({
      state: 'normal',
      reason: null,
      writeGate: 'open',
    })
    expect(c.isWriteAllowed()).toBe(true)
  })

  it('rejects illegal transitions', () => {
    expect(() => controller().confirmMaintenance()).toThrow(MaintenanceTransitionError)
    expect(() => controller().abortEnteringMaintenance()).toThrow(MaintenanceTransitionError)
    expect(() => controller().completeRecovery()).toThrow(MaintenanceTransitionError)

    const entering = controller()
    entering.beginEnteringMaintenance()
    expect(() => entering.beginEnteringMaintenance()).toThrow(MaintenanceTransitionError)

    const maintenance = controller()
    maintenance.beginEnteringMaintenance()
    maintenance.confirmMaintenance()
    expect(() => maintenance.abortEnteringMaintenance()).toThrow(MaintenanceTransitionError)

    const locked = controller()
    locked.enterRecoveryLocked()
    expect(() => locked.beginEnteringMaintenance()).toThrow(MaintenanceTransitionError)
  })

  it('enters recovery_locked and only completes through explicit recovery completion', () => {
    const c = controller()
    c.enterRecoveryLocked('journal')
    expect(c.snapshot()).toMatchObject({
      state: 'recovery_locked',
      reason: 'journal',
      writeGate: 'closed',
    })
    expect(c.isWriteAllowed()).toBe(false)
    expect(c.isSchedulerAllowed()).toBe(false)
    expect(c.isExecutionStartAllowed()).toBe(false)
    expect(c.isEventIngressAllowed()).toBe(false)

    c.completeRecovery()
    expect(c.state).toBe('normal')
    expect(c.isWriteAllowed()).toBe(true)
  })

  it('enters shutting_down from all non-terminal states and is idempotent', () => {
    const normal = controller()
    normal.beginShuttingDown('SIGTERM')
    expect(normal.state).toBe('shutting_down')
    normal.beginShuttingDown('again')
    expect(normal.state).toBe('shutting_down')

    const entering = controller()
    entering.beginEnteringMaintenance()
    entering.beginShuttingDown()
    expect(entering.state).toBe('shutting_down')

    const maintenance = controller()
    maintenance.beginEnteringMaintenance()
    maintenance.confirmMaintenance()
    maintenance.beginShuttingDown()
    expect(maintenance.state).toBe('shutting_down')

    const locked = controller()
    locked.enterRecoveryLocked()
    locked.beginShuttingDown()
    expect(locked.state).toBe('shutting_down')
  })

  it('blocks external writes with the correct code', () => {
    const c = controller()
    c.beginEnteringMaintenance()
    expect(() => c.assertExternalWriteAllowed('artifact-write')).toThrow(MaintenanceBlockedError)
    try {
      c.assertExternalWriteAllowed('artifact-write')
    } catch (error) {
      expect((error as MaintenanceBlockedError).code).toBe('MAINTENANCE_ACTIVE')
    }

    c.confirmMaintenance()
    try {
      c.assertExternalWriteAllowed('backup-write')
    } catch (error) {
      expect((error as MaintenanceBlockedError).code).toBe('MAINTENANCE_ACTIVE')
    }

    c.enterRecoveryLocked()
    try {
      c.assertExternalWriteAllowed('worktree-write')
    } catch (error) {
      expect((error as MaintenanceBlockedError).code).toBe('RECOVERY_LOCKED')
    }

    c.beginShuttingDown()
    try {
      c.assertExternalWriteAllowed('artifact-write')
    } catch (error) {
      expect((error as MaintenanceBlockedError).code).toBe('SHUTTING_DOWN')
    }
  })

  it('allows normal writes but rejects writes in entering_maintenance', () => {
    const c = controller()
    expect(c.authorizeRpc('req-00000001', BACKUP_CREATE_METHOD, 'write')).toBeNull()

    c.beginEnteringMaintenance()
    const denied = c.authorizeRpc('req-00000001', BACKUP_CREATE_METHOD, 'write')
    expect(denied?.ok).toBe(false)
    if (denied && !denied.ok) {
      expect(denied.error.code).toBe('MAINTENANCE_ACTIVE')
      expect(denied.error.detail).toMatchObject({ method: BACKUP_CREATE_METHOD })
    }
    expect(c.snapshot().lastBlockedOperation).toBe(`rpc:${BACKUP_CREATE_METHOD}`)
  })

  it('allows explicit read-only RPCs during entering/maintenance', () => {
    const c = controller()
    c.beginEnteringMaintenance()
    expect(c.authorizeRpc('req-00000001', AGENT_LIST_METHOD, 'read')).toBeNull()
    expect(c.authorizeRpc('req-00000001', EVENTS_SUBSCRIBE_METHOD, 'read')).toBeNull()
    expect(c.authorizeRpc('req-00000001', CORE_MAINTENANCE_STATUS_METHOD, 'read')).toBeNull()

    c.confirmMaintenance()
    expect(c.authorizeRpc('req-00000001', AGENT_LIST_METHOD, 'read')).toBeNull()
    expect(c.authorizeRpc('req-00000001', EVENTS_SUBSCRIBE_METHOD, 'read')).toBeNull()
  })

  it('denies read methods not on the explicit maintenance allowlist', () => {
    const c = controller()
    c.beginEnteringMaintenance()
    const denied = c.authorizeRpc('req-00000001', 'unknown.read', 'read')
    expect(denied?.ok).toBe(false)
    if (denied && !denied.ok) expect(denied.error.code).toBe('MAINTENANCE_ACTIVE')
  })

  it('allows only health/status in recovery_locked and shutting_down', () => {
    const c = controller()
    c.enterRecoveryLocked()
    expect(c.authorizeRpc('req-00000001', CORE_HEALTH_METHOD, 'read')).toBeNull()
    expect(c.authorizeRpc('req-00000001', CORE_MAINTENANCE_STATUS_METHOD, 'read')).toBeNull()
    for (const method of [AGENT_LIST_METHOD, EVENTS_SUBSCRIBE_METHOD]) {
      const denied = c.authorizeRpc('req-00000001', method, 'read')
      expect(denied?.ok).toBe(false)
      if (denied && !denied.ok) expect(denied.error.code).toBe('RECOVERY_LOCKED')
    }
    const writeDenied = c.authorizeRpc('req-00000001', BACKUP_CREATE_METHOD, 'write')
    expect(writeDenied?.ok).toBe(false)
    if (writeDenied && !writeDenied.ok) expect(writeDenied.error.code).toBe('RECOVERY_LOCKED')

    c.beginShuttingDown()
    expect(c.authorizeRpc('req-00000001', CORE_HEALTH_METHOD, 'read')).toBeNull()
    const shutdownDenied = c.authorizeRpc('req-00000001', AGENT_LIST_METHOD, 'read')
    expect(shutdownDenied?.ok).toBe(false)
    if (shutdownDenied && !shutdownDenied.ok) {
      expect(shutdownDenied.error.code).toBe('SHUTTING_DOWN')
    }
  })

  describe('S55-2B-1B boot states', () => {
    it('supports normal -> booting -> recovering -> normal', () => {
      const c = controller()
      c.enterBooting('boot')
      expect(c.snapshot()).toMatchObject({
        state: 'booting',
        reason: 'boot',
        writeGate: 'closed',
      })
      expect(c.isSchedulerAllowed()).toBe(false)
      expect(c.isExecutionStartAllowed()).toBe(false)
      expect(c.isEventIngressAllowed()).toBe(true)

      c.beginRecovering('reconciliation')
      expect(c.snapshot()).toMatchObject({ state: 'recovering', writeGate: 'closed' })

      c.completeBoot()
      expect(c.snapshot()).toMatchObject({ state: 'normal', reason: null, writeGate: 'open' })
      expect(c.isSchedulerAllowed()).toBe(true)
    })

    it('rejects illegal boot transitions', () => {
      const c = controller()
      expect(() => c.beginRecovering()).toThrow(MaintenanceTransitionError)
      expect(() => c.completeBoot()).toThrow(MaintenanceTransitionError)
      c.enterBooting()
      expect(() => c.enterBooting()).toThrow(MaintenanceTransitionError)
      expect(() => c.completeBoot()).toThrow(MaintenanceTransitionError)
      c.beginRecovering()
      expect(() => c.beginRecovering()).toThrow(MaintenanceTransitionError)
      expect(() => c.beginEnteringMaintenance()).toThrow(MaintenanceTransitionError)
    })

    it('treats booting/recovering as lockdown: only health/status, events.subscribe denied', () => {
      for (const enter of [
        (c: MaintenanceController) => c.enterBooting(),
        (c: MaintenanceController) => {
          c.enterBooting()
          c.beginRecovering()
        },
      ]) {
        const c = controller()
        enter(c)
        expect(c.authorizeRpc('req-00000001', CORE_HEALTH_METHOD, 'read')).toBeNull()
        expect(c.authorizeRpc('req-00000001', CORE_MAINTENANCE_STATUS_METHOD, 'read')).toBeNull()
        for (const method of [AGENT_LIST_METHOD, EVENTS_SUBSCRIBE_METHOD]) {
          const denied = c.authorizeRpc('req-00000001', method, 'read')
          expect(denied?.ok).toBe(false)
          if (denied && !denied.ok) {
            expect(denied.error.code).toBe('RECOVERY_LOCKED')
            expect(denied.error.detail).toMatchObject({ state: c.state })
          }
        }
        const writeDenied = c.authorizeRpc('req-00000001', BACKUP_CREATE_METHOD, 'write')
        expect(writeDenied?.ok).toBe(false)
      }
    })

    it('enters recovery_locked from booting/recovering', () => {
      const booting = controller()
      booting.enterBooting()
      booting.enterRecoveryLocked('daemon_unavailable')
      expect(booting.state).toBe('recovery_locked')

      const recovering = controller()
      recovering.enterBooting()
      recovering.beginRecovering()
      recovering.enterRecoveryLocked('terminal_compensation_failed')
      expect(recovering.state).toBe('recovery_locked')

      // completeBoot 只允许从 recovering 进入；recovery_locked 不能直接 normal。
      expect(() => recovering.completeBoot()).toThrow(MaintenanceTransitionError)
    })

    it('never reports normal before completeBoot', () => {
      const c = controller()
      expect(c.state).toBe('normal')
      c.enterBooting()
      expect(c.state).not.toBe('normal')
      c.beginRecovering()
      expect(c.state).not.toBe('normal')
      c.completeBoot()
      expect(c.state).toBe('normal')
    })
  })
})
