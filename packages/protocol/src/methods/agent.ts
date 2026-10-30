import { z } from 'zod'
import { AgentProfile, AgentStatus } from '../dto'

export const AGENT_LIST_METHOD = 'agent.list'
export const AGENT_GET_METHOD = 'agent.get'
export const AGENT_CREATE_METHOD = 'agent.create'
export const AGENT_UPDATE_METHOD = 'agent.update'
export const AGENT_ARCHIVE_METHOD = 'agent.archive'

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

const Skills = z.array(z.string().min(1).max(200)).max(100)

export const AgentCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    skills: Skills.optional(),
    defaultProviderId: z.string().min(1).nullable().optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
  })
  .strict()
export type AgentCreateParams = z.infer<typeof AgentCreateParams>

export const AgentUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    role: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    skills: Skills.optional(),
    defaultProviderId: z.string().min(1).nullable().optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
    status: AgentStatus.optional(),
  })
  .strict()
export type AgentUpdateParams = z.infer<typeof AgentUpdateParams>

export const AgentArchiveParams = z.object({ id: z.string().min(1) }).strict()
export type AgentArchiveParams = z.infer<typeof AgentArchiveParams>
