import {
  EXECUTION_STATES,
  PROVIDER_HEALTH_STATUSES,
  ProviderCapabilities,
  type RuntimeInfo as RuntimeInfoShape,
} from '@agentra/runtime-sdk'
import { z } from 'zod'

/**
 * 跨进程 DTO（camelCase）。数据库使用 snake_case，映射在 Core 的 Repository 层完成。
 * 所有外部输入与持久化 JSON 均经 Zod 校验（AGENTS §6）。
 */

export const IsoTimestamp = z.string().min(1)

export const AgentStatus = z.enum(['active', 'disabled', 'archived'])
export type AgentStatus = z.infer<typeof AgentStatus>

export const AgentProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  skills: z.array(z.string()),
  defaultProviderId: z.string().min(1).nullable(),
  maxConcurrency: z.number().int().min(1),
  status: AgentStatus,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  archivedAt: IsoTimestamp.nullable(),
})
export type AgentProfile = z.infer<typeof AgentProfile>

export const ProviderType = z.enum(['cli', 'acp', 'remote'])
export type ProviderType = z.infer<typeof ProviderType>

export const ProviderHealthStatus = z.enum(PROVIDER_HEALTH_STATUSES)
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatus>

export const RuntimeProvider = z.object({
  id: z.string().min(1),
  providerType: ProviderType,
  providerName: z.string().min(1),
  executablePath: z.string().min(1).nullable(),
  version: z.string().min(1).nullable(),
  capabilities: ProviderCapabilities,
  healthStatus: ProviderHealthStatus,
  lastDiscoveredAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type RuntimeProvider = z.infer<typeof RuntimeProvider>

export const ExecutionState = z.enum(EXECUTION_STATES)
export type ExecutionState = z.infer<typeof ExecutionState>

export const Execution = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  providerId: z.string().min(1),
  /** 阶段 1 无 Assignment：Agent 由 session.context_ref 关联，此处为派生字段。 */
  agentId: z.string().min(1).nullable(),
  externalExecutionId: z.string().min(1).nullable(),
  processId: z.number().int().positive().nullable(),
  status: ExecutionState,
  workingDirectory: z.string().min(1),
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
  exitCode: z.number().int().nullable(),
  capabilities: ProviderCapabilities,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type Execution = z.infer<typeof Execution>

export const ExecutionLogStream = z.enum(['stdout', 'stderr', 'system', 'structured'])
export type ExecutionLogStream = z.infer<typeof ExecutionLogStream>

export const ExecutionLog = z.object({
  id: z.string().min(1),
  executionId: z.string().min(1),
  sequenceNo: z.number().int().min(1),
  stream: ExecutionLogStream,
  content: z.string(),
  timestamp: IsoTimestamp,
})
export type ExecutionLog = z.infer<typeof ExecutionLog>

/**
 * Provider 发现结果（Core ↔ Daemon 内部 DTO）。
 * `satisfies` 是编译期护栏：形状必须与 Runtime SDK 的 RuntimeInfo 完全一致，
 * 任一侧改了字段而另一侧没跟上，会在这里直接报错（本次 RuntimeInfo 双定义事故的防复发）。
 */
export const RuntimeInfo = z.object({
  providerId: z.string().min(1),
  providerType: ProviderType,
  providerName: z.string().min(1),
  executablePath: z.string().min(1).nullable(),
  version: z.string().min(1).nullable(),
  capabilities: ProviderCapabilities,
  healthStatus: ProviderHealthStatus,
  healthDetail: z.string(),
  authMethod: z.string().nullable(),
  discoveredAt: IsoTimestamp,
}) satisfies z.ZodType<RuntimeInfoShape>
export type RuntimeInfo = z.infer<typeof RuntimeInfo>
