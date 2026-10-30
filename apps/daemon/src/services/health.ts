import {
  DAEMON_HEALTH_METHOD,
  defineMethod,
  HealthParams,
  HealthResult,
  PROTOCOL_VERSION,
} from '@agentra/protocol'
import type { MethodTable } from '../rpc/dispatcher'

const startedAt = Date.now()

/** daemon.health：进程级健康信息。 */
export function daemonHealthMethods(version: string): MethodTable {
  return {
    [DAEMON_HEALTH_METHOD]: defineMethod(HealthParams, HealthResult, () => ({
      status: 'ok' as const,
      service: 'daemon' as const,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
      version,
    })),
  }
}
