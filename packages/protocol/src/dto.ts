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

/** 未配置时的默认值：空 allow，按 U3 即「拒绝执行」。旧数据兜底，不再由表单产生。 */
export const DEFAULT_TOOL_PERMISSIONS: ToolPermissions = { version: 1, allow: [], deny: [] }

/** 默认头像：Agent 在群聊、列表中的识别符号。 */
export const DEFAULT_AGENT_AVATAR = '🤖'

const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/**
 * Agent 头像：内置 emoji（短字符串）或本地图片的 data URL。
 * 图片由桌面端裁剪为 128×128 后转 data URL；限制长度，避免大文件拖垮 RPC/数据库快照。
 */
export const AgentAvatar = z
  .string()
  .min(1)
  .max(300_000)
  .refine(
    (value) =>
      value.startsWith('data:image/') ? AVATAR_DATA_URL.test(value) : [...value].length <= 32,
    { message: '头像必须是 emoji（≤32 字符）或 png/jpeg/webp/gif 的 data URL' },
  )
export type AgentAvatar = z.infer<typeof AgentAvatar>

/**
 * Agent 的工作权限（唯一的能力维度）：
 * - analyze：只读分析。可以读文件/检索/执行只读命令，但不能写入或修改代码。
 * - edit：编辑。可以修改代码并执行命令。
 * 工具权限由 Core 从该字段派生，用户不能手工扩大。
 */
export const AgentAccessMode = z.enum(['analyze', 'edit'])
export type AgentAccessMode = z.infer<typeof AgentAccessMode>

export const AGENT_ACCESS_MODE_LABEL: Record<AgentAccessMode, string> = {
  analyze: '只读分析',
  edit: '编辑',
}

/** 系统托管 Agent 的用途标记；普通 Agent 为 null。 */
export const AgentSystemKind = z.enum(['planner', 'agent_designer'])
export type AgentSystemKind = z.infer<typeof AgentSystemKind>

/** 全局技能库中的一项；Agent 通过 skillIds 引用，不复制内容。 */
export const Skill = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string().min(1),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type Skill = z.infer<typeof Skill>

export const AgentProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  avatar: AgentAvatar,
  description: z.string(),
  systemPrompt: z.string(),
  /** 引用全局技能库；执行时把技能指令追加到工作指令之后。 */
  skillIds: z.array(z.string().min(1)).default([]),
  accessMode: AgentAccessMode,
  systemKind: AgentSystemKind.nullable().default(null),
  /** 可选模型别名/ID；null 表示使用 Provider 默认模型。 */
  model: z.string().min(1).max(200).nullable().default(null),
  /** 由 accessMode 派生；保留在 DTO 中供执行层原样下发给 Daemon。 */
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

/** Provider 可选的模型候选；来自内置目录（source 标注来源，UI 不把它当作实时保证）。 */
export const RuntimeProviderModel = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
})
export type RuntimeProviderModel = z.infer<typeof RuntimeProviderModel>

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
  /** 团队指引：成员执行关联任务时注入工作指令；不授予权限。 */
  instructions: z.string().max(20_000),
  /** 团队队长：必须由老板显式设置；旧团队保持 null，不自动推断。 */
  leaderAgentId: z.string().min(1).nullable().default(null),
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

export const WorkCollaborationMode = z.enum(['workflow', 'team'])
export type WorkCollaborationMode = z.infer<typeof WorkCollaborationMode>

export const WorkIssueStatus = z.enum(['triage', 'backlog', 'in_progress', 'review', 'done'])
export type WorkIssueStatus = z.infer<typeof WorkIssueStatus>

export const Work = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  objective: z.string(),
  status: WorkStatus,
  priority: z.string().min(1),
  rootPath: z.string().min(1),
  repositoryPath: z.string().min(1).nullable(),
  /** 所属项目；项目是任务的合集。 */
  projectId: z.string().min(1).nullable().default(null),
  /** workflow = Plan/DAG；team = Multica 式队长/成员线程协作。 */
  collaborationMode: WorkCollaborationMode.default('workflow'),
  /** 团队协作任务的唯一归属团队。 */
  ownerTeamId: z.string().min(1).nullable().default(null),
  /** 任务看板状态（与 Work 生命周期 status 分开）。 */
  issueStatus: WorkIssueStatus.default('backlog'),
  /** 当前负责人；团队任务默认为队长。 */
  assigneeAgentId: z.string().min(1).nullable().default(null),
  /** 正式验收标准；版本在 Work 更新时递增。 */
  acceptanceCriteria: z.array(z.string().min(1).max(500)).max(20).default([]),
  acceptanceCriteriaVersion: z.number().int().min(1).default(1),
  acceptanceCriteriaUpdatedAt: IsoTimestamp.nullable().default(null),
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

export const WorktreeStatus = z.enum(['active', 'removed'])
export type WorktreeStatus = z.infer<typeof WorktreeStatus>

export const Worktree = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  assignmentId: z.string().min(1).nullable(),
  repositoryPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  baseCommit: z.string().min(1).nullable(),
  status: WorktreeStatus,
  createdAt: IsoTimestamp,
  removedAt: IsoTimestamp.nullable(),
})
export type Worktree = z.infer<typeof Worktree>
