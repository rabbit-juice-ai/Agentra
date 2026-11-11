import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type {
  AssignmentRecord,
  AssignmentRepository,
  AssignmentStatus,
} from '../db/repositories/assignment-repository'
import type { SessionRepository } from '../db/repositories/session-repository'
import type { TeamRepository } from '../db/repositories/team-repository'
import type { WorkRepository } from '../db/repositories/work-repository'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

/**
 * Assignment 状态机（DATABASE §2.3）。
 * completed / removed 是终态，不能回到 active / paused。
 */
const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  active: ['paused', 'completed', 'removed'],
  paused: ['active', 'completed', 'removed'],
  completed: [],
  removed: [],
}

/** Assignment 期间 Work 必须仍可承接工作（终态 Work 不接受新岗位）。 */
const WORK_ACCEPTS_ASSIGNMENTS = new Set(['draft', 'active', 'paused'])

export type CreateAssignmentInput = {
  workId: string
  agentId: string
  teamId?: string | null
  workRole: string
  taskScope?: string
  concurrencyLimit?: number | null
  contextRef?: string | null
}

/** Assignment 领域服务：创建 / 暂停 / 恢复 / 完成 / 移除 + Session 绑定。 */
export class AssignmentService {
  private readonly assignments: AssignmentRepository

  constructor(
    private readonly db: Database,
    assignments: AssignmentRepository,
    private readonly works: WorkRepository,
    private readonly agents: AgentRepository,
    private readonly teams: TeamRepository,
    private readonly sessions: SessionRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.assignments = assignments
  }

  create(input: CreateAssignmentInput): AssignmentRecord {
    const work = this.works.get(input.workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${input.workId}`)
    if (!WORK_ACCEPTS_ASSIGNMENTS.has(work.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${input.workId} is ${work.status}, cannot accept new assignments`,
      )
    }

    const agent = this.agents.get(input.agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${input.agentId}`)
    if (agent.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `agent ${input.agentId} is ${agent.status}, not active`,
      )
    }

    const teamId = input.teamId ?? null
    if (teamId) {
      const team = this.teams.get(teamId)
      if (!team) throw new RpcMethodError('INVALID_PARAMS', `team not found: ${teamId}`)
      if (team.status !== 'active') {
        throw new RpcMethodError('INVALID_PARAMS', `team ${teamId} is ${team.status}`)
      }
    }

    if (this.assignments.findByWorkAndAgent(input.workId, input.agentId)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `agent ${input.agentId} already has an assignment in work ${input.workId}`,
      )
    }

    const now = this.now()
    const assignment: AssignmentRecord = {
      id: newId('asg'),
      workId: input.workId,
      agentId: input.agentId,
      teamId,
      workRole: requireText(input.workRole, 'workRole'),
      taskScope: input.taskScope ?? '',
      status: 'active',
      concurrencyLimit: input.concurrencyLimit ?? null,
      contextRef: input.contextRef ?? null,
      createdAt: now,
      updatedAt: now,
    }
    transaction(this.db, () => {
      this.assignments.insert(assignment)
    })
    return assignment
  }

  /** 只读预览：StartRun claim 时用于编译 DAG，不创建/修改任何行。 */
  previewPlanRoles(workId: string, agentIds: readonly string[]): Map<string, string> {
    const work = this.works.get(workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${workId}`)
    if (!WORK_ACCEPTS_ASSIGNMENTS.has(work.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${workId} is ${work.status}, cannot accept assignments`,
      )
    }
    const roles = new Map<string, string>()
    for (const agentId of new Set(agentIds)) {
      const agent = this.agents.get(agentId)
      if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${agentId}`)
      if (agent.status !== 'active') {
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `agent ${agentId} is ${agent.status}, not active`,
        )
      }
      const existing = this.assignments.findByWorkAndAgent(workId, agentId)
      if (existing) {
        if (existing.status === 'completed' || existing.status === 'removed') {
          throw new RpcMethodError(
            'INVALID_PARAMS',
            `agent ${agentId} has a ${existing.status} assignment in work ${workId}; cannot reuse`,
          )
        }
        roles.set(agentId, existing.workRole)
        continue
      }
      roles.set(agentId, `plan-${agentId.slice(-8)}`)
    }
    return roles
  }

  /**
   * StartRun 专用：在调用方事务内确保每个 Agent 有 active Assignment。
   * 不自己开事务（database.transaction 不支持嵌套）；失败必须让整个启动事务回滚。
   */
  ensureForPlanInTransaction(
    workId: string,
    agentIds: readonly string[],
    teamIdByAgent: ReadonlyMap<string, string | null>,
    now: string,
  ): Map<string, string> {
    const work = this.works.get(workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${workId}`)
    if (!WORK_ACCEPTS_ASSIGNMENTS.has(work.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${workId} is ${work.status}, cannot accept new assignments`,
      )
    }
    const roles = new Map<string, string>()
    for (const agentId of new Set(agentIds)) {
      const agent = this.agents.get(agentId)
      if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${agentId}`)
      if (agent.status !== 'active') {
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `agent ${agentId} is ${agent.status}, not active`,
        )
      }
      const existing = this.assignments.findByWorkAndAgent(workId, agentId)
      if (existing) {
        if (existing.status === 'active') {
          roles.set(agentId, existing.workRole)
          continue
        }
        if (existing.status === 'paused') {
          if (!this.assignments.updateStatus(existing.id, 'paused', 'active', now)) {
            throw new RpcMethodError(
              'INVALID_PARAMS',
              `assignment ${existing.id} changed concurrently while resuming`,
            )
          }
          roles.set(agentId, existing.workRole)
          continue
        }
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `agent ${agentId} has a ${existing.status} assignment in work ${workId}; cannot reuse`,
        )
      }
      const teamId = teamIdByAgent.get(agentId) ?? null
      if (teamId) {
        const team = this.teams.get(teamId)
        if (team?.status !== 'active') {
          throw new RpcMethodError('INVALID_PARAMS', `team ${teamId} is not active`)
        }
      }
      const workRole = `plan-${agentId.slice(-8)}`
      this.assignments.insert({
        id: newId('asg'),
        workId,
        agentId,
        teamId,
        workRole,
        taskScope: '',
        status: 'active',
        concurrencyLimit: null,
        contextRef: null,
        createdAt: now,
        updatedAt: now,
      })
      roles.set(agentId, workRole)
    }
    return roles
  }

  /**
   * 运行中改派到团队新成员：在调用方事务内按现 workRole 建/恢复 Assignment。
   * 目标已有不同 workRole 的 Assignment 时拒绝，避免一 Agent 多角色。
   */
  ensureWithRoleInTransaction(input: {
    workId: string
    agentId: string
    workRole: string
    teamId: string | null
    now: string
    /** 团队协作线程允许在 Work 暂停/完成后继续运行。 */
    allowInactiveWork?: boolean
  }): AssignmentRecord {
    const work = this.works.get(input.workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${input.workId}`)
    if (!input.allowInactiveWork && !WORK_ACCEPTS_ASSIGNMENTS.has(work.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${input.workId} is ${work.status}, cannot accept assignments`,
      )
    }
    const agent = this.agents.get(input.agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${input.agentId}`)
    if (agent.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `agent ${input.agentId} is ${agent.status}, not active`,
      )
    }
    if (input.teamId) {
      const team = this.teams.get(input.teamId)
      if (team?.status !== 'active') {
        throw new RpcMethodError('INVALID_PARAMS', `team ${input.teamId} is not active`)
      }
    }
    const existing = this.assignments.findByWorkAndAgent(input.workId, input.agentId)
    if (existing) {
      if (existing.workRole !== input.workRole) {
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `agent ${input.agentId} already has workRole "${existing.workRole}" in work ${input.workId}; cannot use "${input.workRole}"`,
        )
      }
      if (existing.status === 'active') return existing
      if (existing.status === 'paused') {
        if (!this.assignments.updateStatus(existing.id, 'paused', 'active', input.now)) {
          throw new RpcMethodError(
            'INVALID_PARAMS',
            `assignment ${existing.id} changed concurrently while resuming`,
          )
        }
        return this.get(existing.id)
      }
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `agent ${input.agentId} has a ${existing.status} assignment in work ${input.workId}; cannot reuse`,
      )
    }
    const record: AssignmentRecord = {
      id: newId('asg'),
      workId: input.workId,
      agentId: input.agentId,
      teamId: input.teamId,
      workRole: requireText(input.workRole, 'workRole'),
      taskScope: '',
      status: 'active',
      concurrencyLimit: null,
      contextRef: null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.assignments.insert(record)
    return record
  }

  get(id: string): AssignmentRecord {
    const assignment = this.assignments.get(id)
    if (!assignment) throw new RpcMethodError('INVALID_PARAMS', `assignment not found: ${id}`)
    return assignment
  }

  listByWork(workId: string): AssignmentRecord[] {
    return this.assignments.listByWork(workId)
  }

  listByAgent(agentId: string): AssignmentRecord[] {
    return this.assignments.listByAgent(agentId)
  }

  pause(id: string): AssignmentRecord {
    return this.transition(id, 'paused')
  }

  resume(id: string): AssignmentRecord {
    return this.transition(id, 'active')
  }

  complete(id: string): AssignmentRecord {
    return this.transition(id, 'completed')
  }

  remove(id: string): AssignmentRecord {
    return this.transition(id, 'removed')
  }

  /**
   * 把 Agent Session 绑定到 Assignment（DATABASE §2.4）。
   * 只允许绑定 active 的 Assignment 与 active 的 Session；已绑到别处的 Session 必须显式解绑。
   */
  bindSession(sessionId: string, assignmentId: string): void {
    const assignment = this.get(assignmentId)
    if (assignment.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `assignment ${assignmentId} is ${assignment.status}, cannot bind sessions`,
      )
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new RpcMethodError('INVALID_PARAMS', `session not found: ${sessionId}`)
    if (session.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `session ${sessionId} is ${session.status}, cannot bind`,
      )
    }
    if (session.assignmentId !== null && session.assignmentId !== assignmentId) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `session ${sessionId} is already bound to assignment ${session.assignmentId}`,
      )
    }
    this.sessions.bindAssignment(sessionId, assignmentId, this.now())
  }

  private transition(id: string, to: AssignmentStatus): AssignmentRecord {
    const assignment = this.get(id)
    if (!ASSIGNMENT_TRANSITIONS[assignment.status].includes(to)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `assignment ${id} cannot transition ${assignment.status} → ${to}`,
      )
    }
    const now = this.now()
    const applied = this.assignments.updateStatus(id, assignment.status, to, now)
    if (!applied) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `assignment ${id} changed concurrently (expected ${assignment.status} → ${to})`,
      )
    }
    return this.get(id)
  }
}
