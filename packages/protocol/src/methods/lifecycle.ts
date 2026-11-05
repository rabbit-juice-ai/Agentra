import { z } from 'zod'
import { IsoTimestamp } from '../dto'

/** S55-2B：Core 维护模式只读状态查询。 */
export const CORE_MAINTENANCE_STATUS_METHOD = 'core.maintenance.status'

/**
 * S55-2B-1B：新增 booting / recovering 两个启动阶段态。
 * 协议版本不变（增量枚举，旧客户端不消费该接口）；booting/recovering 与
 * recovery_locked 同为 lockdown 级授权（仅 core.health / core.maintenance.status）。
 */
export const MaintenanceStateSchema = z.enum([
  'booting',
  'recovering',
  'normal',
  'entering_maintenance',
  'maintenance',
  'recovery_locked',
  'shutting_down',
])
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>

export const MaintenanceWriteGateSchema = z.enum(['open', 'closing', 'closed'])
export type MaintenanceWriteGate = z.infer<typeof MaintenanceWriteGateSchema>

export const DrainCategorySchema = z.enum([
  'rpc-mutation',
  'scheduler-tick',
  'execution-start',
  'daemon-call',
  'artifact-write',
  'backup-write',
  'worktree-write',
  'provider-refresh',
  'workflow-kick',
  'event-handler',
])
export type DrainCategory = z.infer<typeof DrainCategorySchema>

export const DrainSnapshotSchema = z
  .object({
    accepting: z.boolean(),
    counts: z
      .object({
        'rpc-mutation': z.number().int().nonnegative(),
        'scheduler-tick': z.number().int().nonnegative(),
        'execution-start': z.number().int().nonnegative(),
        'daemon-call': z.number().int().nonnegative(),
        'artifact-write': z.number().int().nonnegative(),
        'backup-write': z.number().int().nonnegative(),
        'worktree-write': z.number().int().nonnegative(),
        'provider-refresh': z.number().int().nonnegative(),
        'workflow-kick': z.number().int().nonnegative(),
        'event-handler': z.number().int().nonnegative(),
      })
      .strict(),
    total: z.number().int().nonnegative(),
    lastBlockedCategory: DrainCategorySchema.nullable(),
    lastBlockedOperation: z.string().nullable(),
  })
  .strict()
export type DrainSnapshot = z.infer<typeof DrainSnapshotSchema>

export const MaintenanceStatusParamsSchema = z.object({}).strict()
export type MaintenanceStatusParams = z.infer<typeof MaintenanceStatusParamsSchema>

export const MaintenanceStatusResultSchema = z
  .object({
    state: MaintenanceStateSchema,
    since: IsoTimestamp,
    reason: z.string().nullable(),
    writeGate: MaintenanceWriteGateSchema,
    lastBlockedOperation: z.string().nullable(),
    drain: DrainSnapshotSchema,
  })
  .strict()
export type MaintenanceStatusResult = z.infer<typeof MaintenanceStatusResultSchema>

export {
  MaintenanceStatusParamsSchema as MaintenanceStatusParamsValue,
  MaintenanceStatusResultSchema as MaintenanceStatusResultValue,
}
