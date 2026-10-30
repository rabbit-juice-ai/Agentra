import type { MethodTable } from '../rpc/dispatcher'
import { DAEMON_HEALTH_METHOD, HealthParams, PROTOCOL_VERSION } from '@agentra/protocol'

const startedAt = Date.now()

/** daemon.health：进程级健康信息。 */
export function daemonHealthMethods(version: string): MethodTable {
  return {
    [DAEMON_HEALTH_METHOD]: {
      paramsSchema: HealthParams,
      handler: () => ({
        status: 'ok',
        service: 'daemon',
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        version,
      }),
    },
  }
}
