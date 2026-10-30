import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

export const TEAM_STATUSES = ['active', 'archived'] as const
export type TeamStatus = (typeof TEAM_STATUSES)[number]

export type TeamRecord = {
  id: string
  name: string
  description: string
  settings: Record<string, unknown>
  status: TeamStatus
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export type TeamMemberRecord = {
  id: string
  teamId: string
  agentId: string
  teamRole: string
  permissions: Record<string, unknown>
  joinedAt: string
}

const JsonObject = z.record(z.string(), z.unknown())

type TeamRow = {
  id: string
  name: string
  description: string
  settings_json: string
  status: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

type TeamMemberRow = {
  id: string
  team_id: string
  agent_id: string
  team_role: string
  permissions_json: string
  joined_at: string
}

function toTeam(row: TeamRow): TeamRecord {
  if (row.status !== 'active' && row.status !== 'archived') {
    throw new Error(`unexpected teams.status: ${row.status}`)
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    settings: parseJsonColumn(JsonObject, row.settings_json, `teams.settings_json(${row.id})`),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function toMember(row: TeamMemberRow): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id,
    teamRole: row.team_role,
    permissions: parseJsonColumn(
      JsonObject,
      row.permissions_json,
      `team_members.permissions_json(${row.id})`,
    ),
    joinedAt: row.joined_at,
  }
}

/** teams / team_members 的唯一数据访问入口（Core 独占）。 */
export class TeamRepository {
  constructor(private readonly db: Database) {}

  insert(team: TeamRecord): void {
    this.db
      .prepare(
        `INSERT INTO teams (id, name, description, settings_json, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        team.id,
        team.name,
        team.description,
        serializeJsonColumn(JsonObject, team.settings, 'team.settings'),
        team.status,
        team.createdAt,
        team.updatedAt,
        team.archivedAt,
      )
  }

  update(team: TeamRecord): void {
    const result = this.db
      .prepare(
        `UPDATE teams SET name = ?, description = ?, settings_json = ?, status = ?,
          updated_at = ?, archived_at = ? WHERE id = ?`,
      )
      .run(
        team.name,
        team.description,
        serializeJsonColumn(JsonObject, team.settings, 'team.settings'),
        team.status,
        team.updatedAt,
        team.archivedAt,
        team.id,
      )
    if (result.changes === 0) throw new Error(`team not found for update: ${team.id}`)
  }

  get(id: string): TeamRecord | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined
    return row ? toTeam(row) : null
  }

  list(includeArchived = false): TeamRecord[] {
    const rows = (
      includeArchived
        ? this.db.prepare('SELECT * FROM teams ORDER BY created_at ASC, id ASC').all()
        : this.db
            .prepare(
              "SELECT * FROM teams WHERE status != 'archived' ORDER BY created_at ASC, id ASC",
            )
            .all()
    ) as TeamRow[]
    return rows.map(toTeam)
  }

  addMember(member: TeamMemberRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_members (id, team_id, agent_id, team_role, permissions_json, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        member.id,
        member.teamId,
        member.agentId,
        member.teamRole,
        serializeJsonColumn(JsonObject, member.permissions, 'teamMember.permissions'),
        member.joinedAt,
      )
  }

  getMember(teamId: string, agentId: string): TeamMemberRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?')
      .get(teamId, agentId) as TeamMemberRow | undefined
    return row ? toMember(row) : null
  }

  listMembers(teamId: string): TeamMemberRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at ASC, id ASC')
      .all(teamId) as TeamMemberRow[]
    return rows.map(toMember)
  }

  removeMember(teamId: string, agentId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM team_members WHERE team_id = ? AND agent_id = ?')
      .run(teamId, agentId)
    return result.changes > 0
  }

  newMemberId(): string {
    return newId('tmm')
  }
}
