import {
  type AgentAccessMode,
  AgentAvatar,
  type AgentCreateParams,
  type AgentProfile,
  type AgentSystemKind,
  type AgentUpdateParams,
  DEFAULT_AGENT_AVATAR,
  RpcMethodError,
  type ToolPermissions,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { ProviderRepository } from '../db/repositories/provider-repository'
import type { SkillRepository } from '../db/repositories/skill-repository'

/** 工作权限 → 实际工具策略。用户只选权限，不直接编辑工具清单。 */
export const ACCESS_MODE_TOOL_POLICY: Record<AgentAccessMode, ToolPermissions> = {
  analyze: {
    version: 1,
    // 只读分析允许执行命令（例如跑测试/检查），但禁止任何写入或改码工具。
    allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
    deny: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  },
  edit: {
    version: 1,
    allow: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    deny: [],
  },
}

export function toolPermissionsForAccessMode(accessMode: AgentAccessMode): ToolPermissions {
  const policy = ACCESS_MODE_TOOL_POLICY[accessMode]
  return { version: 1, allow: [...policy.allow], deny: [...policy.deny] }
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

function normalizeAvatar(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  const parsed = AgentAvatar.safeParse(trimmed)
  if (!parsed.success) {
    throw new RpcMethodError(
      'INVALID_PARAMS',
      `头像格式非法：${parsed.error.issues[0]?.message ?? 'invalid avatar'}`,
    )
  }
  return parsed.data
}

/** AgentProfile 领域服务：CRUD + 默认 Provider 绑定（归档而非物理删除）。 */
export class AgentService {
  constructor(
    private readonly db: Database,
    private readonly agents: AgentRepository,
    private readonly providers: ProviderRepository,
    private readonly skills: SkillRepository,
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

  create(
    params: AgentCreateParams,
    options: { systemKind?: AgentSystemKind | null } = {},
  ): AgentProfile {
    const now = this.now()
    // Provider 必须显式选择；协议层已必填，这里再拦截直接调用服务层的路径。
    const defaultProviderId = requireText(params.defaultProviderId ?? '', 'defaultProviderId')
    this.assertProviderExists(defaultProviderId)

    const accessMode = params.accessMode ?? 'analyze'
    const skillIds = this.normalizeSkillIds(params.skillIds)
    const agent: AgentProfile = {
      id: newId('agt'),
      name: requireText(params.name, 'name'),
      avatar: normalizeAvatar(params.avatar, DEFAULT_AGENT_AVATAR),
      description: params.description ?? '',
      systemPrompt: params.systemPrompt ?? '',
      skillIds,
      accessMode,
      systemKind: options.systemKind ?? null,
      model: params.model?.trim() || null,
      toolPermissions: toolPermissionsForAccessMode(accessMode),
      defaultProviderId,
      maxConcurrency: params.maxConcurrency ?? 5,
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
    // 历史 Agent 可能没有 Provider；允许它们继续被停用/归档。新建与表单编辑都强制选择。
    if (defaultProviderId !== null) this.assertProviderExists(defaultProviderId)

    const status = params.status ?? existing.status
    const accessMode = params.accessMode ?? existing.accessMode
    if (existing.systemKind !== null && accessMode !== 'analyze') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        '系统 Agent 的工作权限固定为只读分析，不能改为编辑',
      )
    }
    const agent: AgentProfile = {
      ...existing,
      name: params.name === undefined ? existing.name : requireText(params.name, 'name'),
      avatar: normalizeAvatar(params.avatar, existing.avatar),
      description: params.description ?? existing.description,
      systemPrompt: params.systemPrompt ?? existing.systemPrompt,
      skillIds:
        params.skillIds === undefined ? existing.skillIds : this.normalizeSkillIds(params.skillIds),
      accessMode,
      // 权限是工具策略的唯一来源；任何更新都重新派生，避免遗留手工配置漂移。
      toolPermissions: toolPermissionsForAccessMode(accessMode),
      model: params.model === undefined ? existing.model : params.model?.trim() || null,
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

  /** 去重、保序，并拒绝引用了不存在技能的配置。 */
  private normalizeSkillIds(input: string[] | undefined): string[] {
    if (input === undefined) return []
    const ids = [...new Set(input.map((id) => id.trim()).filter((id) => id.length > 0))]
    const missing = ids.filter((id) => !this.skills.get(id))
    if (missing.length > 0) {
      throw new RpcMethodError('SKILL_NOT_FOUND', `技能不存在，无法绑定：${missing.join(', ')}`)
    }
    return ids
  }

  private assertProviderExists(providerId: string): void {
    if (!this.providers.get(providerId)) {
      throw new RpcMethodError('PROVIDER_NOT_FOUND', `provider not found: ${providerId}`)
    }
  }
}
