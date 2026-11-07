import { ProviderCapabilities } from '@agentra/runtime-sdk'
import { z } from 'zod'
import { ExecutionState, IsoTimestamp, RuntimeInfo, RuntimeProviderModel } from '../dto'

/**
 * Core → Daemon 内部方法（UDS NDJSON）。Desktop 不直连 Daemon。
 * Daemon 只报告执行事实；工作流/业务状态由 Core 决定。
 */
export const DAEMON_DISCOVER_METHOD = 'runtime.discover'
export const DAEMON_PROVIDER_MODELS_METHOD = 'runtime.provider.models'
export const DAEMON_EXECUTION_START_METHOD = 'runtime.execution.start'
export const DAEMON_EXECUTION_SEND_MESSAGE_METHOD = 'runtime.execution.sendMessage'
export const DAEMON_EXECUTION_INTERRUPT_METHOD = 'runtime.execution.interrupt'
export const DAEMON_EXECUTION_CANCEL_METHOD = 'runtime.execution.cancel'
export const DAEMON_EXECUTION_STATUS_METHOD = 'runtime.execution.status'
export const DAEMON_EXECUTION_LIST_ACTIVE_METHOD = 'runtime.execution.listActive'
export const DAEMON_SUBSCRIBE_METHOD = 'daemon.subscribe'

export const DaemonDiscoverParams = z.object({}).strict()
export type DaemonDiscoverParams = z.infer<typeof DaemonDiscoverParams>

export const DaemonEmptyParams = z.object({}).strict()
export type DaemonEmptyParams = z.infer<typeof DaemonEmptyParams>

export const DaemonDiscoverResult = z.object({ providers: z.array(RuntimeInfo) })
export type DaemonDiscoverResult = z.infer<typeof DaemonDiscoverResult>

export const DaemonProviderModelsParams = z.object({ providerId: z.string().min(1) }).strict()
export type DaemonProviderModelsParams = z.infer<typeof DaemonProviderModelsParams>

export const DaemonProviderModelsResult = z.object({
  models: z.array(RuntimeProviderModel),
})
export type DaemonProviderModelsResult = z.infer<typeof DaemonProviderModelsResult>

export const DaemonExecutionStartParams = z
  .object({
    executionId: z.string().min(1),
    providerId: z.string().min(1),
    executablePath: z.string().min(1).nullable(),
    capabilities: ProviderCapabilities,
    prompt: z.string().min(1).max(100_000),
    workingDirectory: z.string().min(1),
    sessionId: z.string().min(1),
    systemPrompt: z.string().max(100_000).optional(),
    model: z.string().min(1).max(200).optional(),
    permissionMode: z.string().min(1).max(100).optional(),
    allowedTools: z.array(z.string().min(1)).max(100).optional(),
    disallowedTools: z.array(z.string().min(1)).max(100).optional(),
    /**
     * 阶段 2：Core 声明本次执行允许的工作目录根（scratch、worktrees 根、Work.rootPath）。
     * Daemon 仍做边界校验：实际目录必须落在 scratch 根或这些根之内。
     */
    allowedRoots: z.array(z.string().min(1).max(4096)).max(8).optional(),
  })
  .strict()
export type DaemonExecutionStartParams = z.infer<typeof DaemonExecutionStartParams>

export const DaemonExecutionStartResult = z.object({
  processId: z.number().int().positive().nullable(),
  startedAt: IsoTimestamp,
})
export type DaemonExecutionStartResult = z.infer<typeof DaemonExecutionStartResult>

export const DaemonExecutionSendMessageParams = z
  .object({
    executionId: z.string().min(1),
    message: z.string().min(1).max(100_000),
  })
  .strict()
export type DaemonExecutionSendMessageParams = z.infer<typeof DaemonExecutionSendMessageParams>

export const DaemonExecutionIdParams = z.object({ executionId: z.string().min(1) }).strict()
export type DaemonExecutionIdParams = z.infer<typeof DaemonExecutionIdParams>

export const DaemonExecutionSendMessageResult = z.object({ sent: z.literal(true) })
export type DaemonExecutionSendMessageResult = z.infer<typeof DaemonExecutionSendMessageResult>

export const DaemonExecutionInterruptResult = z.object({ interrupted: z.boolean() })
export type DaemonExecutionInterruptResult = z.infer<typeof DaemonExecutionInterruptResult>

export const DaemonExecutionCancelResult = z.object({ cancelled: z.literal(true) })
export type DaemonExecutionCancelResult = z.infer<typeof DaemonExecutionCancelResult>

export const DaemonExecutionStatusResult = z.object({
  executionId: z.string().min(1),
  status: ExecutionState,
  processId: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
})
export type DaemonExecutionStatusResult = z.infer<typeof DaemonExecutionStatusResult>

export const DaemonExecutionListActiveResult = z.object({
  executionIds: z.array(z.string().min(1)),
})
export type DaemonExecutionListActiveResult = z.infer<typeof DaemonExecutionListActiveResult>

export const DaemonSubscribeParams = z.object({}).strict()
export type DaemonSubscribeParams = z.infer<typeof DaemonSubscribeParams>

export const DaemonSubscribeResult = z.object({ subscribed: z.literal(true) })
export type DaemonSubscribeResult = z.infer<typeof DaemonSubscribeResult>
