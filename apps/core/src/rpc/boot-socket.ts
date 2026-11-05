import { CORE_HEALTH_METHOD, CORE_MAINTENANCE_STATUS_METHOD } from '@agentra/protocol'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import type { MaintenanceController } from '../lifecycle/maintenance-controller'
import { coreHealthMethods } from '../services/health'
import type { MethodTable } from './dispatcher'
import { maintenanceStatusMethod } from './methods'
import { startWsServer, type WsServer } from './ws-server'

/**
 * S55-2B-1B：最小 health/status socket。
 *
 * 物理方法表只有 core.health 与 core.maintenance.status —— 不是「全表 + 过滤」。
 * 任何业务方法（含 events.subscribe）在此 socket 上必然是 METHOD_NOT_FOUND，
 * 与授权层无关（纵深防御）。
 *
 * 生命周期：进程最早期 bind（持 BootLock 后），常驻至退出；recovery_locked 时保留，
 * 作为唯一可用的状态/诊断通道。业务 socket 只有在对账完成、core.sock bind 成功、
 * completeBoot 之后才存在。
 */
export function startBootSocket(
  socketPath: string,
  version: string,
  daemonSocketPath: string,
  maintenance: MaintenanceController,
  drain: DrainCoordinator,
): Promise<WsServer> {
  const healthEntry = coreHealthMethods(version, daemonSocketPath)[CORE_HEALTH_METHOD]
  if (!healthEntry) {
    throw new Error('core.health method is missing from health method table')
  }
  const methods: MethodTable = {
    [CORE_HEALTH_METHOD]: healthEntry,
    [CORE_MAINTENANCE_STATUS_METHOD]: maintenanceStatusMethod(maintenance, drain),
  }
  return startWsServer(socketPath, methods, {
    authorize: (requestId, method, access) => maintenance.authorizeRpc(requestId, method, access),
  })
}
