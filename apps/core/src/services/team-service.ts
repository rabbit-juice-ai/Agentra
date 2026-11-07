import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type {
  TeamMemberRecord,
  TeamRecord,
  TeamRepository,
} from '../db/repositories/team-repository'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

export type CreateTeamInput = {
  name: string
  description?: string
  instructions?: string
}

export type UpdateTeamInput = {
  name?: string
  description?: string
  instructions?: string
}

/** Team 领域服务：CRUD + 成员管理（归档而非物理删除，DATABASE §5）。 */
export class TeamService {
  private readonly teams: TeamRepository

  constructor(
    private readonly db: Database,
    teams: TeamRepository,
    private readonly agents: AgentRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.teams = teams
  }

  create(input: CreateTeamInput): TeamRecord {
    const now = this.now()
    const team: TeamRecord = {
      id: newId('team'),
      name: requireText(input.name, 'name'),
      description: input.description ?? '',
      instructions: input.instructions?.trim() ?? '',
      settings: {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    transaction(this.db, () => {
      this.teams.insert(team)
    })
    return team
  }

  get(id: string): TeamRecord {
    const team = this.teams.get(id)
    if (!team) throw new RpcMethodError('INVALID_PARAMS', `team not found: ${id}`)
    return team
  }

  list(includeArchived = false): TeamRecord[] {
    return this.teams.list(includeArchived)
  }

  update(id: string, input: UpdateTeamInput): TeamRecord {
    const team = this.get(id)
    if (team.status === 'archived') {
      throw new RpcMethodError('INVALID_PARAMS', `team ${id} is archived and cannot be updated`)
    }
    const updated: TeamRecord = {
      ...team,
      name: input.name === undefined ? team.name : requireText(input.name, 'name'),
      description: input.description ?? team.description,
      instructions:
        input.instructions === undefined ? team.instructions : input.instructions.trim(),
      updatedAt: this.now(),
    }
    this.teams.update(updated)
    return updated
  }

  archive(id: string): TeamRecord {
    const team = this.get(id)
    if (team.status === 'archived') return team
    const now = this.now()
    const archived: TeamRecord = {
      ...team,
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    }
    this.teams.update(archived)
    return archived
  }

  addMember(teamId: string, agentId: string): TeamMemberRecord {
    const team = this.get(teamId)
    if (team.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `team ${teamId} is ${team.status}, cannot add members`,
      )
    }
    if (!this.agents.get(agentId)) {
      throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${agentId}`)
    }
    if (this.teams.getMember(teamId, agentId)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `agent ${agentId} is already a member of team ${teamId}`,
      )
    }
    const member: TeamMemberRecord = {
      id: this.teams.newMemberId(),
      teamId,
      agentId,
      permissions: {},
      joinedAt: this.now(),
    }
    this.teams.addMember(member)
    return member
  }

  removeMember(teamId: string, agentId: string): void {
    this.get(teamId)
    if (!this.teams.removeMember(teamId, agentId)) {
      throw new RpcMethodError('INVALID_PARAMS', `agent ${agentId} is not a member of ${teamId}`)
    }
  }

  listMembers(teamId: string): TeamMemberRecord[] {
    this.get(teamId)
    return this.teams.listMembers(teamId)
  }
}
