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

export const WORK_COLLABORATION_MODES = ['workflow', 'team'] as const
export type WorkCollaborationMode = (typeof WORK_COLLABORATION_MODES)[number]

export const WORK_ISSUE_STATUSES = ['triage', 'backlog', 'in_progress', 'review', 'done'] as const
export type WorkIssueStatus = (typeof WORK_ISSUE_STATUSES)[number]

export type WorkRecord = {
  id: string
  name: string
  description: string
  objective: string
  status: WorkStatus
  priority: string
  rootPath: string
  repositoryPath: string | null
  projectId: string | null
  collaborationMode: WorkCollaborationMode
  ownerTeamId: string | null
  issueStatus: WorkIssueStatus
  assigneeAgentId: string | null
  acceptanceCriteria: string[]
  acceptanceCriteriaVersion: number
  acceptanceCriteriaUpdatedAt: string | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

const JsonObject = z.record(z.string(), z.unknown())
const AcceptanceCriteria = z.array(z.string().min(1).max(500)).max(20)

type WorkRow = {
  id: string
  name: string
  description: string
  objective: string
  status: string
  priority: string
  root_path: string
  repository_path: string | null
  project_id: string | null
  collaboration_mode: string
  owner_team_id: string | null
  issue_status: string
  assignee_agent_id: string | null
  acceptance_criteria_json: string
  acceptance_criteria_version: number
  acceptance_criteria_updated_at: string | null
  settings_json: string
  created_at: string
  updated_at: string
  completed_at: string | null
}

function toWork(row: WorkRow): WorkRecord {
  if (!(WORK_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected works.status: ${row.status}`)
  }
  if (!(WORK_COLLABORATION_MODES as readonly string[]).includes(row.collaboration_mode)) {
    throw new Error(`unexpected works.collaboration_mode: ${row.collaboration_mode}`)
  }
  if (!(WORK_ISSUE_STATUSES as readonly string[]).includes(row.issue_status)) {
    throw new Error(`unexpected works.issue_status: ${row.issue_status}`)
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
    projectId: row.project_id,
    collaborationMode: row.collaboration_mode as WorkCollaborationMode,
    ownerTeamId: row.owner_team_id,
    issueStatus: row.issue_status as WorkIssueStatus,
    assigneeAgentId: row.assignee_agent_id,
    acceptanceCriteria: AcceptanceCriteria.parse(JSON.parse(row.acceptance_criteria_json)),
    acceptanceCriteriaVersion: row.acceptance_criteria_version,
    acceptanceCriteriaUpdatedAt: row.acceptance_criteria_updated_at,
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
          project_id, collaboration_mode, owner_team_id, issue_status, assignee_agent_id,
          acceptance_criteria_json, acceptance_criteria_version, acceptance_criteria_updated_at,
          settings_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        work.projectId,
        work.collaborationMode,
        work.ownerTeamId,
        work.issueStatus,
        work.assigneeAgentId,
        JSON.stringify(work.acceptanceCriteria),
        work.acceptanceCriteriaVersion,
        work.acceptanceCriteriaUpdatedAt,
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
          root_path = ?, repository_path = ?, project_id = ?, collaboration_mode = ?,
          owner_team_id = ?, issue_status = ?, assignee_agent_id = ?,
          settings_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        work.name,
        work.description,
        work.objective,
        work.priority,
        work.rootPath,
        work.repositoryPath,
        work.projectId,
        work.collaborationMode,
        work.ownerTeamId,
        work.issueStatus,
        work.assigneeAgentId,
        serializeJsonColumn(JsonObject, work.settings, 'work.settings'),
        work.updatedAt,
        work.id,
      )
    if (result.changes === 0) throw new Error(`work not found for update: ${work.id}`)
  }

  /** 验收标准更新 + 版本递增，使用当前版本做乐观并发控制。 */
  updateAcceptanceCriteria(
    id: string,
    fromVersion: number,
    criteria: string[],
    toVersion: number,
    updatedAt: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE works SET acceptance_criteria_json = ?, acceptance_criteria_version = ?,
          acceptance_criteria_updated_at = ?, updated_at = ?
         WHERE id = ? AND acceptance_criteria_version = ?`,
      )
      .run(JSON.stringify(criteria), toVersion, updatedAt, now, id, fromVersion)
    return result.changes > 0
  }

  setIssueStatus(
    id: string,
    from: readonly WorkIssueStatus[],
    to: WorkIssueStatus,
    now: string,
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE works SET issue_status = ?, updated_at = ?
         WHERE id = ? AND issue_status IN (${placeholders})`,
      )
      .run(to, now, id, ...from)
    return result.changes > 0
  }

  setAssignee(id: string, agentId: string | null, now: string): boolean {
    const result = this.db
      .prepare('UPDATE works SET assignee_agent_id = ?, updated_at = ? WHERE id = ?')
      .run(agentId, now, id)
    return result.changes > 0
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

  listByProject(projectId: string, includeArchived = false): WorkRecord[] {
    const rows = (
      includeArchived
        ? this.db
            .prepare('SELECT * FROM works WHERE project_id = ? ORDER BY created_at ASC, id ASC')
            .all(projectId)
        : this.db
            .prepare(
              "SELECT * FROM works WHERE project_id = ? AND status != 'archived' ORDER BY created_at ASC, id ASC",
            )
            .all(projectId)
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
