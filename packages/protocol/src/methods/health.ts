import { z } from 'zod'
import { PROTOCOL_VERSION } from '../version'

export const CORE_HEALTH_METHOD = 'core.health'
export const DAEMON_HEALTH_METHOD = 'daemon.health'

export const HealthParams = z.object({}).strict()
export type HealthParams = z.infer<typeof HealthParams>

export const HealthResult = z.object({
  status: z.literal('ok'),
  service: z.enum(['core', 'daemon']),
  // 字面量而非 string：版本不匹配的健康响应必须被校验拒绝，而不是被宽松接受。
  protocolVersion: z.literal(PROTOCOL_VERSION),
  pid: z.number().int().positive(),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
})
export type HealthResult = z.infer<typeof HealthResult>
