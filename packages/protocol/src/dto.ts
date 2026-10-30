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

/**
 * 工具权限最小模型（U3）。
 * - allow 为空 = 未配置 = 拒绝执行（不默认全开）；
 * - deny 优先于 allow；同一工具不得同时出现在两个清单里，冲突在写入时拒绝；
 * - 单项 1–200 字符、各清单 ≤100 项；重复项由 Core 在归一化时去重。
 */
export const ToolPermissions = z
  .object({
    version: z.literal(1),
    allow: z.array(z.string().min(1).max(200)).max(100),
    deny: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict()
  .refine((value) => value.allow.every((tool) => !value.deny.includes(tool)), {
    message: 'allow 与 deny 不能包含同一工具（deny 优先，冲突必须在写入时拒绝）',
    path: ['allow'],
  })
export type ToolPermissions = z.infer<typeof ToolPermissions>

/** 未配置时的默认值：空 allow，按 U3 即「拒绝执行」。 */
export const DEFAULT_TOOL_PERMISSIONS: ToolPermissions = { version: 1, allow: [], deny: [] }

export const AgentProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  skills: z.array(z.string()),
  toolPermissions: ToolPermissions,
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

export const RuntimeProviderRecord = z.object({
  id: z.string().min(1),
  providerType: ProviderType,
  providerName: z.string().min(1),
  executablePath: z.string().min(1).nullable(),
  version: z.string().min(1).nullable(),
  capabilities: ProviderCapabilities,
  healthStatus: ProviderHealthStatus,
  /** 认证方式描述（oauth_token / api_key / none），不含凭据本身。 */
  authMethod: z.string().nullable(),
  /** 面向用户的可执行提示（安装/登录命令），不含任何凭据。 */
  healthDetail: z.string().nullable(),
  lastDiscoveredAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type RuntimeProviderRecord = z.infer<typeof RuntimeProviderRecord>

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
