import { z } from 'zod'
import { AgentAccessMode, AgentAvatar, AgentProfile, AgentStatus } from '../dto'

export const AGENT_LIST_METHOD = 'agent.list'
export const AGENT_GET_METHOD = 'agent.get'
export const AGENT_CREATE_METHOD = 'agent.create'
export const AGENT_UPDATE_METHOD = 'agent.update'
export const AGENT_ARCHIVE_METHOD = 'agent.archive'
export const AGENT_GENERATE_DRAFT_METHOD = 'agent.generateDraft'

export const EmptyParams = z.object({}).strict()
export type EmptyParams = z.infer<typeof EmptyParams>

export const AgentListParams = z.object({ includeArchived: z.boolean().optional() }).strict()
export type AgentListParams = z.infer<typeof AgentListParams>

export const AgentListResult = z.object({ agents: z.array(AgentProfile) })
export type AgentListResult = z.infer<typeof AgentListResult>

export const AgentGetParams = z.object({ id: z.string().min(1) }).strict()
export type AgentGetParams = z.infer<typeof AgentGetParams>

export const AgentResult = z.object({ agent: AgentProfile })
export type AgentResult = z.infer<typeof AgentResult>

const Avatar = AgentAvatar
const SkillIds = z.array(z.string().min(1).max(128)).max(100)

/**
 * 新建 Agent：Provider 必须显式指定（不再自动选择健康 Provider）。
 * 技能从全局技能库引用；工作权限由 accessMode 决定，工具权限由 Core 派生。
 */
export const AgentCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    avatar: Avatar.optional(),
    description: z.string().max(4000).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    skillIds: SkillIds.optional(),
    accessMode: AgentAccessMode.optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    defaultProviderId: z.string().min(1).max(128),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
  })
  .strict()
export type AgentCreateParams = z.infer<typeof AgentCreateParams>

export const AgentUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    avatar: Avatar.optional(),
    description: z.string().max(4000).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    skillIds: SkillIds.optional(),
    accessMode: AgentAccessMode.optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    /** 只能改绑到另一个存在的 Provider，不能清空。 */
    defaultProviderId: z.string().min(1).max(128).optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
    status: AgentStatus.optional(),
  })
  .strict()
export type AgentUpdateParams = z.infer<typeof AgentUpdateParams>

export const AgentArchiveParams = z.object({ id: z.string().min(1) }).strict()
export type AgentArchiveParams = z.infer<typeof AgentArchiveParams>

/**
 * AI 生成的 Agent 草案。只包含可编辑的身份与工作说明；
 * Provider / 模型由用户在表单里显式选择，AI 不替用户决定。
 */
export const AgentDraft = z
  .object({
    name: z.string().min(1).max(200),
    avatar: AgentAvatar,
    description: z.string().min(1).max(4000),
    systemPrompt: z.string().min(1).max(100_000),
    accessMode: AgentAccessMode,
    skillIds: z.array(z.string().min(1).max(128)).max(100).default([]),
    maxConcurrency: z.number().int().min(1).max(64).default(5),
  })
  .strict()
export type AgentDraft = z.infer<typeof AgentDraft>

export const AgentGenerateDraftParams = z.object({ brief: z.string().min(1).max(4000) }).strict()
export type AgentGenerateDraftParams = z.infer<typeof AgentGenerateDraftParams>

export const AgentGenerateDraftResult = z.object({
  draft: AgentDraft,
  source: z.enum(['ai', 'fallback']),
  reason: z.string().nullable().default(null),
  designerExecutionId: z.string().min(1).nullable().default(null),
})
export type AgentGenerateDraftResult = z.infer<typeof AgentGenerateDraftResult>
