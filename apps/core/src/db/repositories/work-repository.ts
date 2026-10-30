import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

export const WORK_STATUSES = [
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

export type WorkRecord = {
  id: string
  name: string
  description: string
  objective: string
  status: WorkStatus
  priority: string
  rootPath: string
  repositoryPath: string | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

const JsonObject = z.record(z.string(), z.unknown())

type WorkRow = {
  id: string
  name: string
  description: string
  objective: string
  status: string
  priority: string
  root_path: string
  repository_path: string | null
  settings_json: string
  created_at: string
  updated_at: string
  completed_at: string | null
}

function toWork(row: WorkRow): WorkRecord {
  if (!(WORK_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected works.status: ${row.status}`)
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    objective: row.objective,
    status: row.status as WorkStatus,
    priority: row.priority,
    rootPath: row.root_path,
    repositoryPath: row.repository_path,
    settings: parseJsonColumn(JsonObject, row.settings_json, `works.settings_json(${row.id})`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

/** works / work_teams 的唯一数据访问入口（Core 独占）。 */
export class WorkRepository {
  constructor(private readonly db: Database) {}

  insert(work: WorkRecord): void {
    this.db
      .prepare(
        `INSERT INTO works (
          id, name, description, objective, status, priority, root_path, repository_path,
          settings_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        work.id,
        work.name,
        work.description,
        work.objective,
        work.status,
        work.priority,
        work.rootPath,
        work.repositoryPath,
        serializeJsonColumn(JsonObject, work.settings, 'work.settings'),
        work.createdAt,
        work.updatedAt,
        work.completedAt,
      )
  }

  /** 状态迁移：带「当前状态」条件，避免并发覆盖（乐观锁语义）。 */
  updateStatus(
    id: string,
    from: WorkStatus,
    to: WorkStatus,
    now: string,
    completedAt: string | null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE works SET status = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(to, now, completedAt, id, from)
    return result.changes > 0
  }

  updateDetails(work: WorkRecord): void {
    const result = this.db
      .prepare(
        `UPDATE works SET name = ?, description = ?, objective = ?, priority = ?,
          root_path = ?, repository_path = ?, settings_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        work.name,
        work.description,
        work.objective,
        work.priority,
        work.rootPath,
        work.repositoryPath,
        serializeJsonColumn(JsonObject, work.settings, 'work.settings'),
        work.updatedAt,
        work.id,
      )
    if (result.changes === 0) throw new Error(`work not found for update: ${work.id}`)
  }

  get(id: string): WorkRecord | null {
    const row = this.db.prepare('SELECT * FROM works WHERE id = ?').get(id) as WorkRow | undefined
    return row ? toWork(row) : null
  }

  list(includeArchived = false): WorkRecord[] {
    const rows = (
      includeArchived
        ? this.db.prepare('SELECT * FROM works ORDER BY created_at ASC, id ASC').all()
        : this.db
            .prepare(
              "SELECT * FROM works WHERE status != 'archived' ORDER BY created_at ASC, id ASC",
            )
            .all()
    ) as WorkRow[]
    return rows.map(toWork)
  }

  linkTeam(workId: string, teamId: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO work_teams (work_id, team_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(work_id, team_id) DO NOTHING`,
      )
      .run(workId, teamId, now)
  }

  unlinkTeam(workId: string, teamId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM work_teams WHERE work_id = ? AND team_id = ?')
      .run(workId, teamId)
    return result.changes > 0
  }

  listTeamIds(workId: string): string[] {
    const rows = this.db
      .prepare('SELECT team_id FROM work_teams WHERE work_id = ? ORDER BY created_at ASC')
      .all(workId) as { team_id: string }[]
    return rows.map((row) => row.team_id)
  }

  listWorkIdsForTeam(teamId: string): string[] {
    const rows = this.db
      .prepare('SELECT work_id FROM work_teams WHERE team_id = ? ORDER BY created_at ASC')
      .all(teamId) as { work_id: string }[]
    return rows.map((row) => row.work_id)
  }
}
