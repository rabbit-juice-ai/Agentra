import { z } from 'zod'

export const CORE_HEALTH_METHOD = 'core.health'
export const DAEMON_HEALTH_METHOD = 'daemon.health'

export const HealthParams = z.object({}).strict()
export type HealthParams = z.infer<typeof HealthParams>

export const HealthResult = z.object({
  status: z.literal('ok'),
  service: z.enum(['core', 'daemon']),
  protocolVersion: z.string(),
  pid: z.number().int().positive(),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
})
export type HealthResult = z.infer<typeof HealthResult>
