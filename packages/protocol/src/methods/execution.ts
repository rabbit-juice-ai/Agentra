import { z } from 'zod'
import { Execution, ExecutionLog } from '../dto'

export const EXECUTION_START_METHOD = 'execution.start'
export const EXECUTION_GET_METHOD = 'execution.get'
export const EXECUTION_LIST_METHOD = 'execution.list'
export const EXECUTION_LOGS_METHOD = 'execution.logs'
export const EXECUTION_SEND_MESSAGE_METHOD = 'execution.sendMessage'
export const EXECUTION_INTERRUPT_METHOD = 'execution.interrupt'
export const EXECUTION_CANCEL_METHOD = 'execution.cancel'
export const EXECUTION_STATUS_METHOD = 'execution.status'

export const ExecutionStartParams = z
  .object({
    agentId: z.string().min(1),
    prompt: z.string().min(1).max(100_000),
  })
  .strict()
export type ExecutionStartParams = z.infer<typeof ExecutionStartParams>

export const ExecutionResult = z.object({ execution: Execution })
export type ExecutionResult = z.infer<typeof ExecutionResult>

export const ExecutionGetParams = z.object({ executionId: z.string().min(1) }).strict()
export type ExecutionGetParams = z.infer<typeof ExecutionGetParams>

export const ExecutionGetResult = z.object({
  execution: Execution,
  logs: z.array(ExecutionLog),
})
export type ExecutionGetResult = z.infer<typeof ExecutionGetResult>

export const ExecutionListParams = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .strict()
export type ExecutionListParams = z.infer<typeof ExecutionListParams>

export const ExecutionListResult = z.object({ executions: z.array(Execution) })
export type ExecutionListResult = z.infer<typeof ExecutionListResult>

export const ExecutionLogsParams = z
  .object({
    executionId: z.string().min(1),
    afterSequence: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict()
export type ExecutionLogsParams = z.infer<typeof ExecutionLogsParams>

export const ExecutionLogsResult = z.object({ logs: z.array(ExecutionLog) })
export type ExecutionLogsResult = z.infer<typeof ExecutionLogsResult>

export const ExecutionSendMessageParams = z
  .object({
    executionId: z.string().min(1),
    message: z.string().min(1).max(100_000),
  })
  .strict()
export type ExecutionSendMessageParams = z.infer<typeof ExecutionSendMessageParams>

export const ExecutionSendMessageResult = z.object({ sent: z.literal(true) })
export type ExecutionSendMessageResult = z.infer<typeof ExecutionSendMessageResult>

export const ExecutionInterruptParams = z.object({ executionId: z.string().min(1) }).strict()
export type ExecutionInterruptParams = z.infer<typeof ExecutionInterruptParams>

export const ExecutionInterruptResult = z.object({ interrupted: z.boolean() })
export type ExecutionInterruptResult = z.infer<typeof ExecutionInterruptResult>

export const ExecutionCancelParams = z.object({ executionId: z.string().min(1) }).strict()
export type ExecutionCancelParams = z.infer<typeof ExecutionCancelParams>

export const ExecutionStatusParams = z.object({ executionId: z.string().min(1) }).strict()
export type ExecutionStatusParams = z.infer<typeof ExecutionStatusParams>
