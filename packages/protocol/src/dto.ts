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
 * - deny 优先于 allow；同一工具不得同时出现在两个清单里；
 * - 单项 1–200 字符、各清单 ≤100 项；
 * - 重复项与 allow/deny 冲突一律在写入时拒绝（INVALID_PARAMS），不做静默去重。
 *
 * 判定口径：先去除首尾空白再比较——`[" Read", "Read"]` 视为重复，`allow:["Read"]` 与
 * `deny:[" Read"]` 视为冲突。只含空白的项不参与重复判定（它们会被 Core 归一化时过滤掉）。
 */
const normalizeToolList = (tools: readonly string[]): string[] =>
  tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0)

export const ToolPermissions = z
  .object({
    version: z.literal(1),
    allow: z.array(z.string().min(1).max(200)).max(100),
    deny: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allow = normalizeToolList(value.allow)
    const deny = normalizeToolList(value.deny)

    if (new Set(allow).size !== allow.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'allow 中存在重复工具（比较前先去除首尾空白）',
        path: ['allow'],
      })
    }
    if (new Set(deny).size !== deny.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'deny 中存在重复工具（比较前先去除首尾空白）',
        path: ['deny'],
      })
    }
    const overlap = allow.filter((tool) => deny.includes(tool))
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `allow 与 deny 不能包含同一工具（deny 优先，冲突必须在写入时拒绝）：${overlap.join(', ')}`,
        path: ['allow'],
      })
    }
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

// ---------------------------------------------------------------------------
// 阶段 2：Team / Work / Assignment（DATABASE §2.2 / §2.3）
// ---------------------------------------------------------------------------

export const TeamStatus = z.enum(['active', 'archived'])
export type TeamStatus = z.infer<typeof TeamStatus>

export const Team = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  status: TeamStatus,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  archivedAt: IsoTimestamp.nullable(),
})
export type Team = z.infer<typeof Team>

export const TeamMember = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  agentId: z.string().min(1),
  teamRole: z.string().min(1),
  joinedAt: IsoTimestamp,
})
export type TeamMember = z.infer<typeof TeamMember>

export const WorkStatus = z.enum([
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
])
export type WorkStatus = z.infer<typeof WorkStatus>

export const Work = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  objective: z.string(),
  status: WorkStatus,
  priority: z.string().min(1),
  rootPath: z.string().min(1),
  repositoryPath: z.string().min(1).nullable(),
  /** 关联的 Team（来自 work_teams），只读派生字段。 */
  teamIds: z.array(z.string().min(1)),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  completedAt: IsoTimestamp.nullable(),
})
export type Work = z.infer<typeof Work>

export const AssignmentStatus = z.enum(['active', 'paused', 'completed', 'removed'])
export type AssignmentStatus = z.infer<typeof AssignmentStatus>

export const Assignment = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  agentId: z.string().min(1),
  teamId: z.string().min(1).nullable(),
  workRole: z.string().min(1),
  taskScope: z.string(),
  status: AssignmentStatus,
  concurrencyLimit: z.number().int().min(1).nullable(),
  contextRef: z.string().nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type Assignment = z.infer<typeof Assignment>
