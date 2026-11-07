import { type Skill, Skill as SkillSchema } from '@agentra/protocol'
import type { Database } from '../database'

type SkillRow = {
  id: string
  name: string
  description: string
  instructions: string
  created_at: string
  updated_at: string
}

function toSkill(row: SkillRow): Skill {
  return SkillSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

/** 全局技能库的唯一数据访问入口（Core 独占）。 */
export class SkillRepository {
  constructor(private readonly db: Database) {}

  list(): Skill[] {
    const rows = this.db
      .prepare('SELECT * FROM skills ORDER BY name COLLATE NOCASE ASC, id ASC')
      .all() as SkillRow[]
    return rows.map(toSkill)
  }

  get(id: string): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
    return row ? toSkill(row) : null
  }

  findByName(name: string): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as
      | SkillRow
      | undefined
    return row ? toSkill(row) : null
  }

  listByIds(ids: string[]): Skill[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE id IN (${placeholders})`)
      .all(...ids) as SkillRow[]
    const byId = new Map(rows.map((row) => [row.id, toSkill(row)]))
    // 保持 Agent 配置中的顺序；缺失的 id 由调用方在写入时拦截，这里静默跳过。
    return ids.flatMap((id) => {
      const skill = byId.get(id)
      return skill ? [skill] : []
    })
  }

  insert(skill: Skill): void {
    this.db
      .prepare(
        `INSERT INTO skills (id, name, description, instructions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skill.id,
        skill.name,
        skill.description,
        skill.instructions,
        skill.createdAt,
        skill.updatedAt,
      )
  }

  update(skill: Skill): void {
    const result = this.db
      .prepare(
        'UPDATE skills SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?',
      )
      .run(skill.name, skill.description, skill.instructions, skill.updatedAt, skill.id)
    if (result.changes === 0) throw new Error(`skill not found for update: ${skill.id}`)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    return result.changes > 0
  }
}
