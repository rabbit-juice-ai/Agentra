import {
  type AgentCreateParams,
  type AgentProfile,
  type AgentUpdateParams,
  DEFAULT_TOOL_PERMISSIONS,
  RpcMethodError,
  ToolPermissions,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { ProviderRepository } from '../db/repositories/provider-repository'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

/**
 * 工具权限归一化：只做「去空白 + 过滤空白项 + 保持顺序」，不去重。
 * 重复项与 allow/deny 冲突由 protocol 的 ToolPermissions schema 拒绝（RPC 边界返回 INVALID_PARAMS）；
 * 这里再 parse 一次，保证直接调用服务层（绕过 RPC）时同样拒绝，而不是把非法配置落库。
 */
function normalizeToolPermissions(input: ToolPermissions): ToolPermissions {
  const parsed = ToolPermissions.safeParse(input)
  if (!parsed.success) {
    throw new RpcMethodError('INVALID_PARAMS', `工具权限配置非法：${parsed.error.message}`)
  }
  const clean = (tools: string[]): string[] =>
    tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0)
  return { version: 1, allow: clean(parsed.data.allow), deny: clean(parsed.data.deny) }
}

/** AgentProfile 领域服务：CRUD + 默认 Provider 绑定（归档而非物理删除）。 */
export class AgentService {
  constructor(
    private readonly db: Database,
    private readonly agents: AgentRepository,
    private readonly providers: ProviderRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(includeArchived = false): AgentProfile[] {
    return this.agents.list(includeArchived)
  }

  get(id: string): AgentProfile {
    const agent = this.agents.get(id)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${id}`)
    return agent
  }

  create(params: AgentCreateParams): AgentProfile {
    const now = this.now()
    const defaultProviderId = params.defaultProviderId ?? null
    if (defaultProviderId) this.assertProviderExists(defaultProviderId)

    const agent: AgentProfile = {
      id: newId('agt'),
      name: requireText(params.name, 'name'),
      role: requireText(params.role, 'role'),
      description: params.description ?? '',
      systemPrompt: params.systemPrompt ?? '',
      skills: params.skills ?? [],
      toolPermissions:
        params.toolPermissions === undefined
          ? DEFAULT_TOOL_PERMISSIONS
          : normalizeToolPermissions(params.toolPermissions),
      defaultProviderId,
      maxConcurrency: params.maxConcurrency ?? 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }

    transaction(this.db, () => {
      this.agents.insert(agent)
      this.agents.syncDefaultBinding(agent.id, defaultProviderId, now)
    })
    return agent
  }

  update(params: AgentUpdateParams): AgentProfile {
    const existing = this.get(params.id)
    const now = this.now()
    const defaultProviderId =
      params.defaultProviderId === undefined ? existing.defaultProviderId : params.defaultProviderId
    if (defaultProviderId) this.assertProviderExists(defaultProviderId)

    const status = params.status ?? existing.status
    const agent: AgentProfile = {
      ...existing,
      name: params.name === undefined ? existing.name : requireText(params.name, 'name'),
      role: params.role === undefined ? existing.role : requireText(params.role, 'role'),
      description: params.description ?? existing.description,
      systemPrompt: params.systemPrompt ?? existing.systemPrompt,
      skills: params.skills ?? existing.skills,
      toolPermissions:
        params.toolPermissions === undefined
          ? existing.toolPermissions
          : normalizeToolPermissions(params.toolPermissions),
      defaultProviderId,
      maxConcurrency: params.maxConcurrency ?? existing.maxConcurrency,
      status,
      updatedAt: now,
      archivedAt: status === 'archived' ? (existing.archivedAt ?? now) : null,
    }

    transaction(this.db, () => {
      this.agents.update(agent)
      if (defaultProviderId !== existing.defaultProviderId) {
        this.agents.syncDefaultBinding(agent.id, defaultProviderId, now)
      }
    })
    return agent
  }

  archive(id: string): AgentProfile {
    const existing = this.get(id)
    if (existing.status === 'archived') return existing
    return this.update({ id, status: 'archived' })
  }

  private assertProviderExists(providerId: string): void {
    if (!this.providers.get(providerId)) {
      throw new RpcMethodError('PROVIDER_NOT_FOUND', `provider not found: ${providerId}`)
    }
  }
}
