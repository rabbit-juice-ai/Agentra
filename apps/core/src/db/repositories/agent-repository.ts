import {
  type AgentProfile,
  AgentProfile as AgentProfileSchema,
  ToolPermissions,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

const SkillIdsSchema = z.array(z.string())

type AgentRow = {
  id: string
  name: string
  avatar: string
  description: string
  system_prompt: string
  skill_ids_json: string
  access_mode: string
  system_kind: string | null
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
    avatar: row.avatar,
    description: row.description,
    systemPrompt: row.system_prompt,
    skillIds: parseJsonColumn(
      SkillIdsSchema,
      row.skill_ids_json,
      `agent_profiles.skill_ids_json(${row.id})`,
    ),
    accessMode: row.access_mode,
    systemKind: row.system_kind,
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

  /**
   * 技能被删除时，从所有 Agent 的引用列表中移除。
   * 调用方负责事务；返回受影响的 Agent 数量。
   */
  removeSkillReference(skillId: string, now: string): number {
    const rows = this.db.prepare('SELECT * FROM agent_profiles').all() as AgentRow[]
    let changed = 0
    for (const row of rows) {
      const skillIds = parseJsonColumn(
        SkillIdsSchema,
        row.skill_ids_json,
        `agent_profiles.skill_ids_json(${row.id})`,
      )
      if (!skillIds.includes(skillId)) continue
      const next = skillIds.filter((id) => id !== skillId)
      this.db
        .prepare('UPDATE agent_profiles SET skill_ids_json = ?, updated_at = ? WHERE id = ?')
        .run(serializeJsonColumn(SkillIdsSchema, next, 'agent.skillIds'), now, row.id)
      changed += 1
    }
    return changed
  }

  insert(profile: AgentProfile): void {
    const skillIds = serializeJsonColumn(SkillIdsSchema, profile.skillIds, 'agent.skillIds')
    const toolPermissions = serializeJsonColumn(
      ToolPermissions,
      profile.toolPermissions,
      'agent.toolPermissions',
    )
    this.db
      .prepare(
        `INSERT INTO agent_profiles (
          id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
          model, tool_permissions_json, default_provider_id, max_concurrency, status, created_at,
          updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.avatar,
        profile.description,
        profile.systemPrompt,
        skillIds,
        profile.accessMode,
        profile.systemKind,
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
    const skillIds = serializeJsonColumn(SkillIdsSchema, profile.skillIds, 'agent.skillIds')
    const toolPermissions = serializeJsonColumn(
      ToolPermissions,
      profile.toolPermissions,
      'agent.toolPermissions',
    )
    const result = this.db
      .prepare(
        `UPDATE agent_profiles SET
          name = ?, avatar = ?, description = ?, system_prompt = ?, skill_ids_json = ?,
          access_mode = ?, system_kind = ?, model = ?, tool_permissions_json = ?,
          default_provider_id = ?, max_concurrency = ?, status = ?, updated_at = ?, archived_at = ?
        WHERE id = ?`,
      )
      .run(
        profile.name,
        profile.avatar,
        profile.description,
        profile.systemPrompt,
        skillIds,
        profile.accessMode,
        profile.systemKind,
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
