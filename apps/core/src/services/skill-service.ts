import {
  RpcMethodError,
  type Skill,
  type SkillCreateParams,
  type SkillUpdateParams,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { SkillRepository } from '../db/repositories/skill-repository'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

/**
 * 全局技能库：技能本身不归 Agent 所有，Agent 只保存引用。
 * 删除技能时同步从所有 Agent 的引用列表中移除，避免悬空引用。
 */
export class SkillService {
  constructor(
    private readonly db: Database,
    private readonly skills: SkillRepository,
    private readonly agents: AgentRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Skill[] {
    return this.skills.list()
  }

  get(id: string): Skill {
    const skill = this.skills.get(id)
    if (!skill) throw new RpcMethodError('SKILL_NOT_FOUND', `skill not found: ${id}`)
    return skill
  }

  create(params: SkillCreateParams): Skill {
    const name = requireText(params.name, 'name')
    this.assertNameAvailable(name, null)
    const now = this.now()
    const skill: Skill = {
      id: newId('skl'),
      name,
      description: params.description?.trim() ?? '',
      instructions: requireText(params.instructions, 'instructions'),
      createdAt: now,
      updatedAt: now,
    }
    this.skills.insert(skill)
    return skill
  }

  update(params: SkillUpdateParams): Skill {
    const existing = this.get(params.id)
    const name = params.name === undefined ? existing.name : requireText(params.name, 'name')
    if (name !== existing.name) this.assertNameAvailable(name, existing.id)
    const updated: Skill = {
      ...existing,
      name,
      description:
        params.description === undefined ? existing.description : params.description.trim(),
      instructions:
        params.instructions === undefined
          ? existing.instructions
          : requireText(params.instructions, 'instructions'),
      updatedAt: this.now(),
    }
    this.skills.update(updated)
    return updated
  }

  delete(id: string): { deleted: boolean } {
    const existing = this.skills.get(id)
    if (!existing) throw new RpcMethodError('SKILL_NOT_FOUND', `skill not found: ${id}`)
    const now = this.now()
    transaction(this.db, () => {
      this.agents.removeSkillReference(id, now)
      this.skills.delete(id)
    })
    return { deleted: true }
  }

  private assertNameAvailable(name: string, excludeId: string | null): void {
    const conflict = this.skills.findByName(name)
    if (conflict && conflict.id !== excludeId) {
      throw new RpcMethodError('INVALID_PARAMS', `技能名称已存在：${name}`)
    }
  }
}
