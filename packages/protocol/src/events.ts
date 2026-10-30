import { z } from 'zod'
import { ExecutionLogStream, ExecutionState, IsoTimestamp } from './dto'
import { ProtocolVersionSchema } from './version'

/**
 * 事件信封（ARCHITECTURE §7）：eventId / protocolVersion / eventType / occurredAt /
 * aggregateType / aggregateId / payload / correlationId / causationId(可选)。
 * 阶段 1 只实现执行相关事件；workflow/approval 事件在后续阶段加入。
 */
export const RuntimeEventType = z.enum(['execution.output', 'execution.state', 'execution.exited'])
export type RuntimeEventType = z.infer<typeof RuntimeEventType>

export const RuntimeEvent = z.object({
  eventId: z.string().min(8),
  protocolVersion: ProtocolVersionSchema,
  eventType: RuntimeEventType,
  occurredAt: IsoTimestamp,
  aggregateType: z.literal('execution'),
  aggregateId: z.string().min(1),
  payload: z.unknown(),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable().optional(),
})
export type RuntimeEvent = z.infer<typeof RuntimeEvent>

/** 推送帧：与 RPC 响应区分（响应有 requestId/ok，事件帧有 type:'event'）。 */
export const EventFrame = z.object({
  type: z.literal('event'),
  event: RuntimeEvent,
})
export type EventFrame = z.infer<typeof EventFrame>

export const ExecutionOutputPayload = z.object({
  executionId: z.string().min(1),
  /** Daemon 事件序号（同一 execution 内单调递增，用于事件流排序/诊断）。 */
  sequenceNo: z.number().int().min(1),
  stream: ExecutionLogStream,
  content: z.string(),
  timestamp: IsoTimestamp,
  /** Core 持久化后的 execution_logs.sequence_no（Core 转发 Desktop 时补充，用于去重）。 */
  logSequenceNo: z.number().int().min(1).optional(),
})
export type ExecutionOutputPayload = z.infer<typeof ExecutionOutputPayload>

export const ExecutionStatePayload = z.object({
  executionId: z.string().min(1),
  /** Daemon 事件从 1 递增；0 表示 Core 合成的状态事件（如取消/对账）。 */
  sequenceNo: z.number().int().min(0),
  status: ExecutionState,
  previousStatus: ExecutionState.nullable(),
  detail: z.string().optional(),
  timestamp: IsoTimestamp,
})
export type ExecutionStatePayload = z.infer<typeof ExecutionStatePayload>

export const ExecutionExitedPayload = z.object({
  executionId: z.string().min(1),
  sequenceNo: z.number().int().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  reason: z.enum(['exited', 'crashed', 'cancelled']),
  timestamp: IsoTimestamp,
})
export type ExecutionExitedPayload = z.infer<typeof ExecutionExitedPayload>
