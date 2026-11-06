import type { ProjectStatus } from '@agentra/protocol'
import type { Database } from '../database'

export type ProjectRecord = {
  id: string
  name: string
  description: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

type ProjectRow = {
  id: string
  name: string
  description: string
  status: string
  created_at: string
  updated_at: string
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 项目 = 任务的合集；只做分组与状态，不承载执行语义。 */
export class ProjectRepository {
  constructor(private readonly db: Database) {}

  create(record: ProjectRecord): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.description,
        record.status,
        record.createdAt,
        record.updatedAt,
      )
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ? toRecord(row) : null
  }

  list(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC')
      .all() as ProjectRow[]
    return rows.map(toRecord)
  }

  update(
    id: string,
    patch: { name?: string; description?: string; status?: ProjectStatus },
    now: string,
  ): ProjectRecord | null {
    const current = this.get(id)
    if (!current) return null
    this.db
      .prepare(
        'UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.status ?? current.status,
        now,
        id,
      )
    return this.get(id)
  }
}
