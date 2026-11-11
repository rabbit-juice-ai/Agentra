import type {
  AgentProfile,
  PlanRecord,
  PlanTask,
  PlanTaskAssignmentSource,
  PlanVersion,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  PlanDispatchRepository,
  PlanStartAttemptRepository,
  PlanTaskAssignmentRecord,
  PlanTaskAssignmentRepository,
} from '../db/repositories/plan-dispatch-repository'
import type {
  PlanCommentRepository,
  PlanThreadRepository,
} from '../db/repositories/plan-repository'
import type { TeamRecord, TeamRepository } from '../db/repositories/team-repository'
import { matchesAgentAccess } from './agent-access-matcher'

export type PlanAssignmentErrorCode =
  | 'PLAN_NOT_APPROVED'
  | 'START_IN_PROGRESS'
  | 'DISPATCH_IN_PROGRESS'
  | 'TASK_NOT_FOUND'
  | 'TASK_ALREADY_ASSIGNED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_INACTIVE'
  | 'AGENT_NOT_TEAM_MEMBER'
  | 'LEADER_EXCLUDED'
  | 'ACCESS_MODE_MISMATCH'
  | 'AGENT_TOOLS_NOT_CONFIGURED'
  | 'TEAM_INACTIVE'
  | 'ASSIGNMENT_CONFLICT'

export class PlanAssignmentError extends Error {
  constructor(
    readonly code: PlanAssignmentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PlanAssignmentError'
  }
}

export type LeaderAssignmentInput = {
  taskKey: string
  agentId: string
  reason: string
}

export type PlanAssignmentServiceDeps = {
  db: Database
  assignments: PlanTaskAssignmentRepository
  dispatches: PlanDispatchRepository
  startAttempts: PlanStartAttemptRepository
  teams: TeamRepository
  agents: { get(id: string): AgentProfile | null; list(): AgentProfile[] }
  threads: Pick<PlanThreadRepository, 'getByPlanTask'>
  comments: Pick<PlanCommentRepository, 'create'>
  audit?: AuditRepository
  now?: () => string
}

function requireTask(version: PlanVersion, taskKey: string): PlanTask {
  const task = version.plan.tasks.find((candidate) => candidate.key === taskKey)
  if (!task) {
    throw new PlanAssignmentError('TASK_NOT_FOUND', `task ${taskKey} not found in plan version`)
  }
  return task
}

/**
 * 计划任务权威成员的唯一写入者：
 * - 队长输出必须经此校验后落库；
 * - 老板启动前改派也走这里；
 * - 旧计划启动时由这里 seed。
 * 运行中的 WorkflowDefinition/NodeRun 不受影响。
 */
export class PlanAssignmentService {
  private readonly now: () => string

  constructor(private readonly deps: PlanAssignmentServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  listByVersion(planVersionId: string): PlanTaskAssignmentRecord[] {
    return this.deps.assignments.listByVersion(planVersionId)
  }

  listActiveByVersion(planVersionId: string): PlanTaskAssignmentRecord[] {
    return this.deps.assignments.listActiveByVersion(planVersionId)
  }

  /**
   * 个人任务/旧计划：从 PlanVersion.assignments 生成 active 行。
   * 调用方负责事务（PlanService.approve 或 PlanStartService 的 claim）。
   */
  seedPersonalAssignmentsInTransaction(
    plan: PlanRecord,
    version: PlanVersion,
    source: Extract<PlanTaskAssignmentSource, 'planner' | 'legacy'>,
    now: string,
  ): void {
    for (const task of version.plan.tasks) {
      if (task.teamId !== null) continue
      if (this.deps.assignments.getActive(version.id, task.key)) continue
      const suggestion = version.assignments.find((assignment) => assignment.taskKey === task.key)
      if (!suggestion?.agentId) {
        throw new PlanAssignmentError(
          'AGENT_NOT_FOUND',
          `task ${task.key} has no Planner assignment; cannot seed personal assignment`,
        )
      }
      const agent = this.deps.agents.get(suggestion.agentId)
      this.assertAgentForTask(task, agent, source === 'legacy' ? 'legacy' : 'planner')
      this.deps.assignments.insert({
        id: newId('pta'),
        planId: plan.id,
        planVersionId: version.id,
        taskKey: task.key,
        teamId: null,
        agentId: agent.id,
        source,
        assignedBy: 'agentra',
        reason: source === 'legacy' ? '旧计划启动时沿用 Planner 分配' : '计划批准时固化',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  /**
   * 老板启动前改派：只能改 approved 且尚未开始启动的计划；
   * 同一任务旧 active 行保留为 superseded，历史可追溯。
   */
  assignTask(input: {
    plan: PlanRecord
    version: PlanVersion
    taskKey: string
    agentId: string
    reason: string
    decidedBy: string
  }): PlanTaskAssignmentRecord {
    const { plan, version, taskKey, agentId, reason, decidedBy } = input
    if (plan.status !== 'approved') {
      throw new PlanAssignmentError(
        'PLAN_NOT_APPROVED',
        `plan ${plan.id} is ${plan.status}; only approved plans can reassign tasks`,
      )
    }
    if (this.deps.startAttempts.getActiveByVersion(version.id)) {
      throw new PlanAssignmentError(
        'START_IN_PROGRESS',
        `plan ${plan.id} is already starting; cannot reassign tasks`,
      )
    }
    const task = requireTask(version, taskKey)
    const agent = this.deps.agents.get(agentId)
    if (!agent) throw new PlanAssignmentError('AGENT_NOT_FOUND', `agent ${agentId} not found`)
    this.assertAgentForTask(task, agent, 'user')
    if (task.teamId) {
      const dispatch = this.deps.dispatches.getByVersionTeam(version.id, task.teamId)
      if (dispatch?.status === 'running') {
        throw new PlanAssignmentError(
          'DISPATCH_IN_PROGRESS',
          `team ${task.teamId} dispatch is running; wait or retry after it finishes`,
        )
      }
    }

    const now = this.now()
    const record: PlanTaskAssignmentRecord = {
      id: newId('pta'),
      planId: plan.id,
      planVersionId: version.id,
      taskKey,
      teamId: task.teamId,
      agentId,
      source: 'user',
      assignedBy: decidedBy,
      reason: reason.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    transaction(this.deps.db, () => {
      if (this.deps.startAttempts.getActiveByVersion(version.id)) {
        throw new PlanAssignmentError(
          'START_IN_PROGRESS',
          `plan ${plan.id} is already starting; cannot reassign tasks`,
        )
      }
      const current = this.deps.assignments.getActive(version.id, taskKey)
      if (current?.agentId === agentId) {
        throw new PlanAssignmentError(
          'ASSIGNMENT_CONFLICT',
          `agent ${agentId} is already assigned to task ${taskKey}`,
        )
      }
      this.deps.assignments.supersedeActive(version.id, taskKey, now)
      this.deps.assignments.insert(record)
      this.comment(
        plan.id,
        taskKey,
        `老板将任务「${task.title}」改派给 Agent「${agent.name}」。原因：${record.reason}`,
        now,
      )
      this.deps.audit?.append({
        actorType: 'user',
        actorId: decidedBy,
        action: 'plan.task_assigned',
        targetType: 'plan',
        targetId: plan.id,
        details: {
          taskKey,
          fromAgentId: current?.agentId ?? null,
          toAgentId: agentId,
          reason: record.reason,
        },
        now,
      })
    })
    return record
  }

  /**
   * 队长派工结果落库：调用方先完成输出解析/成员/权限/容量校验；
   * 这里在单个事务内重新确认计划/启动占用/派工状态，并原子写入整队结果。
   */
  applyLeaderResult(input: {
    plan: PlanRecord
    version: PlanVersion
    team: TeamRecord
    leaderAgentId: string
    dispatchId: string
    executionId: string | null
    assignments: LeaderAssignmentInput[]
  }): PlanTaskAssignmentRecord[] {
    const { plan, version, team, leaderAgentId, dispatchId, executionId, assignments } = input
    if (plan.status !== 'approved') {
      throw new PlanAssignmentError(
        'PLAN_NOT_APPROVED',
        `plan ${plan.id} is ${plan.status}; cannot apply leader assignments`,
      )
    }
    const now = this.now()
    const records: PlanTaskAssignmentRecord[] = []
    transaction(this.deps.db, () => {
      if (this.deps.startAttempts.getActiveByVersion(version.id)) {
        throw new PlanAssignmentError(
          'START_IN_PROGRESS',
          `plan ${plan.id} is already starting; refusing late leader assignments`,
        )
      }
      const dispatch = this.deps.dispatches.get(dispatchId)
      if (dispatch?.status !== 'running') {
        throw new PlanAssignmentError(
          'DISPATCH_IN_PROGRESS',
          `dispatch ${dispatchId} is no longer running`,
        )
      }
      for (const assignment of assignments) {
        const task = requireTask(version, assignment.taskKey)
        if (task.teamId !== team.id) {
          throw new PlanAssignmentError(
            'TASK_NOT_FOUND',
            `task ${task.key} does not belong to team ${team.id}`,
          )
        }
        if (this.deps.assignments.getActive(version.id, task.key)) {
          throw new PlanAssignmentError(
            'TASK_ALREADY_ASSIGNED',
            `task ${task.key} already has an active assignment`,
          )
        }
        const agent = this.deps.agents.get(assignment.agentId)
        if (!agent) {
          throw new PlanAssignmentError('AGENT_NOT_FOUND', `agent ${assignment.agentId} not found`)
        }
        if (agent.id === leaderAgentId) {
          throw new PlanAssignmentError(
            'LEADER_EXCLUDED',
            `team leader ${leaderAgentId} cannot be assigned to team tasks`,
          )
        }
        this.assertAgentForTask(task, agent, 'leader', team)
        const record: PlanTaskAssignmentRecord = {
          id: newId('pta'),
          planId: plan.id,
          planVersionId: version.id,
          taskKey: task.key,
          teamId: team.id,
          agentId: agent.id,
          source: 'leader',
          assignedBy: leaderAgentId,
          reason: assignment.reason.trim(),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        }
        this.deps.assignments.insert(record)
        records.push(record)
      }
      if (!this.deps.dispatches.markSucceeded(dispatchId, executionId, now)) {
        throw new PlanAssignmentError(
          'DISPATCH_IN_PROGRESS',
          `dispatch ${dispatchId} changed concurrently`,
        )
      }
      for (const record of records) {
        const agent = this.deps.agents.get(record.agentId)
        this.comment(
          plan.id,
          record.taskKey,
          `队长完成「${team.name}」派工：${record.taskKey} → ${agent?.name ?? record.agentId}。`,
          now,
        )
      }
    })
    return records
  }

  private assertAgentForTask(
    task: PlanTask,
    agent: AgentProfile | null,
    source: PlanTaskAssignmentSource,
    team?: TeamRecord,
  ): asserts agent is AgentProfile {
    if (!agent) throw new PlanAssignmentError('AGENT_NOT_FOUND', 'agent not found')
    if (agent.status !== 'active') {
      throw new PlanAssignmentError(
        'AGENT_INACTIVE',
        `agent ${agent.id} is ${agent.status}, not active`,
      )
    }
    if (task.teamId !== null) {
      const actualTeam = team ?? this.deps.teams.get(task.teamId)
      if (actualTeam?.status !== 'active') {
        throw new PlanAssignmentError(
          'TEAM_INACTIVE',
          `team ${task.teamId} is missing or not active`,
        )
      }
      if (actualTeam.leaderAgentId === agent.id) {
        throw new PlanAssignmentError(
          'LEADER_EXCLUDED',
          `team leader ${agent.id} cannot execute team tasks`,
        )
      }
      if (!this.deps.teams.getMember(actualTeam.id, agent.id)) {
        throw new PlanAssignmentError(
          'AGENT_NOT_TEAM_MEMBER',
          `agent ${agent.id} is not a member of team ${actualTeam.name}`,
        )
      }
    }
    if (!matchesAgentAccess(agent, task.requiredAccessMode)) {
      throw new PlanAssignmentError(
        'ACCESS_MODE_MISMATCH',
        `agent ${agent.id} accessMode ${agent.accessMode} does not match task ${task.key} requirement ${task.requiredAccessMode}`,
      )
    }
    if (agent.toolPermissions.allow.length === 0) {
      throw new PlanAssignmentError(
        'AGENT_TOOLS_NOT_CONFIGURED',
        `agent ${agent.id} has no allowed tools configured`,
      )
    }
    // source 只用于审计语义；保留参数以便未来按来源差异化校验。
    void source
  }

  private comment(planId: string, taskKey: string, content: string, now: string): void {
    const thread = this.deps.threads.getByPlanTask(planId, taskKey)
    if (!thread) return
    this.deps.comments.create({
      id: newId('pcm'),
      threadId: thread.id,
      authorType: 'system',
      authorId: 'agentra',
      content,
      createdAt: now,
      runId: null,
    })
  }
}
