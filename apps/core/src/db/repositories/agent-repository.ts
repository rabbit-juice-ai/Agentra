import {
  AgentCapabilities,
  type AgentProfile,
  AgentProfile as AgentProfileSchema,
  ToolPermissions,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

const SkillsSchema = z.array(z.string())

type AgentRow = {
  id: string
  name: string
  role: string
  description: string
  system_prompt: string
  skills_json: string
  capabilities_json: string
  model: string | null
  tool_permissions_json: string
  default_provider_id: string | null
  max_concurrency: number
  status: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

function toProfile(row: AgentRow): AgentProfile {
  return AgentProfileSchema.parse({
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    systemPrompt: row.system_prompt,
    skills: parseJsonColumn(SkillsSchema, row.skills_json, `agent_profiles.skills_json(${row.id})`),
    capabilities: parseJsonColumn(
      AgentCapabilities,
      row.capabilities_json,
      `agent_profiles.capabilities_json(${row.id})`,
    ),
    model: row.model,
    toolPermissions: parseJsonColumn(
      ToolPermissions,
      row.tool_permissions_json,
      `agent_profiles.tool_permissions_json(${row.id})`,
    ),
    defaultProviderId: row.default_provider_id,
    maxConcurrency: row.max_concurrency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  })
}

/** AgentProfile 与 agent_runtime_bindings 的唯一数据访问入口（Core 独占）。 */
export class AgentRepository {
  constructor(private readonly db: Database) {}

  list(includeArchived = false): AgentProfile[] {
    const rows = (
      includeArchived
        ? this.db.prepare('SELECT * FROM agent_profiles ORDER BY created_at ASC, id ASC').all()
        : this.db
            .prepare(
              "SELECT * FROM agent_profiles WHERE status != 'archived' ORDER BY created_at ASC, id ASC",
            )
            .all()
    ) as AgentRow[]
    return rows.map(toProfile)
  }

  get(id: string): AgentProfile | null {
    const row = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as
      | AgentRow
      | undefined
    return row ? toProfile(row) : null
  }

  insert(profile: AgentProfile): void {
    const skills = serializeJsonColumn(SkillsSchema, profile.skills, 'agent.skills')
    const capabilities = serializeJsonColumn(
      AgentCapabilities,
      profile.capabilities,
      'agent.capabilities',
    )
    const toolPermissions = serializeJsonColumn(
      ToolPermissions,
      profile.toolPermissions,
      'agent.toolPermissions',
    )
    this.db
      .prepare(
        `INSERT INTO agent_profiles (
          id, name, role, description, system_prompt, skills_json, capabilities_json,
          model, tool_permissions_json, default_provider_id, max_concurrency, status, created_at,
          updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.role,
        profile.description,
        profile.systemPrompt,
        skills,
        capabilities,
        profile.model,
        toolPermissions,
        profile.defaultProviderId,
        profile.maxConcurrency,
        profile.status,
        profile.createdAt,
        profile.updatedAt,
        profile.archivedAt,
      )
  }

  update(profile: AgentProfile): void {
    const skills = serializeJsonColumn(SkillsSchema, profile.skills, 'agent.skills')
    const capabilities = serializeJsonColumn(
      AgentCapabilities,
      profile.capabilities,
      'agent.capabilities',
    )
    const toolPermissions = serializeJsonColumn(
      ToolPermissions,
      profile.toolPermissions,
      'agent.toolPermissions',
    )
    const result = this.db
      .prepare(
        `UPDATE agent_profiles SET
          name = ?, role = ?, description = ?, system_prompt = ?, skills_json = ?,
          capabilities_json = ?, model = ?, tool_permissions_json = ?, default_provider_id = ?,
          max_concurrency = ?, status = ?, updated_at = ?, archived_at = ?
        WHERE id = ?`,
      )
      .run(
        profile.name,
        profile.role,
        profile.description,
        profile.systemPrompt,
        skills,
        capabilities,
        profile.model,
        toolPermissions,
        profile.defaultProviderId,
        profile.maxConcurrency,
        profile.status,
        profile.updatedAt,
        profile.archivedAt,
        profile.id,
      )
    if (result.changes === 0) throw new Error(`agent not found for update: ${profile.id}`)
  }

  /**
   * 维护默认绑定：同一 Agent 只有一个 is_default=1 的绑定。
   * 调用方负责事务（与 agent_profiles.default_provider_id 同事务）。
   */
  syncDefaultBinding(agentId: string, providerId: string | null, now: string): void {
    this.db
      .prepare(
        'UPDATE agent_runtime_bindings SET is_default = 0, updated_at = ? WHERE agent_id = ?',
      )
      .run(now, agentId)
    if (!providerId) return
    this.db
      .prepare(
        `INSERT INTO agent_runtime_bindings (
          id, agent_id, provider_id, config_json, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, '{}', 1, ?, ?)
        ON CONFLICT(agent_id, provider_id) DO UPDATE SET is_default = 1, updated_at = excluded.updated_at`,
      )
      .run(newId('arb'), agentId, providerId, now, now)
  }

  defaultProviderId(agentId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT provider_id FROM agent_runtime_bindings WHERE agent_id = ? AND is_default = 1 LIMIT 1',
      )
      .get(agentId) as { provider_id: string } | undefined
    return row?.provider_id ?? null
  }
}
