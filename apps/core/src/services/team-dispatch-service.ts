import {
  type AgentProfile,
  type Execution,
  type ExecutionStartParams,
  type PlanRecord,
  type PlanTask,
  type PlanVersion,
  RpcMethodError,
  type RuntimeProviderRecord,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  PlanDispatchRecord,
  PlanDispatchRepository,
  PlanStartAttemptRepository,
  PlanTaskAssignmentRecord,
} from '../db/repositories/plan-dispatch-repository'
import type { PlanRepository, PlanVersionRepository } from '../db/repositories/plan-repository'
import type { TeamRecord, TeamRepository } from '../db/repositories/team-repository'
import { matchesAgentAccess } from './agent-access-matcher'
import type { SystemExecutionOptions } from './execution-service'
import type { PlanAssignmentService } from './plan-assignment-service'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'crashed'])

const TaskKey = z.string().regex(/^[a-z0-9_-]{1,64}$/)

const LeaderOutput = z
  .object({
    assignments: z
      .array(
        z
          .object({
            taskKey: TaskKey,
            agentId: z.string().min(1).max(128),
            reason: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()

export type LeaderOutput = z.infer<typeof LeaderOutput>

export type TeamDispatchErrorCode =
  | 'PLAN_NOT_APPROVED'
  | 'PLAN_CHANGED'
  | 'DISPATCH_IN_PROGRESS'
  | 'START_IN_PROGRESS'
  | 'LEADER_NOT_SET'
  | 'LEADER_NOT_FOUND'
  | 'LEADER_INACTIVE'
  | 'LEADER_NOT_MEMBER'
  | 'LEADER_NOT_ANALYZE'
  | 'LEADER_PROVIDER_UNAVAILABLE'
  | 'LEADER_TOOL_CONTROL_UNSUPPORTED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'UNKNOWN_TASK'
  | 'MISSING_TASK'
  | 'DUPLICATE_TASK'
  | 'AGENT_NOT_MEMBER'
  | 'AGENT_INACTIVE'
  | 'AGENT_NOT_FOUND'
  | 'ACCESS_MODE_MISMATCH'
  | 'AGENT_TOOLS_NOT_CONFIGURED'
  | 'CAPACITY_EXCEEDED'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_INACTIVE'
  | 'INTERRUPTED'

export class TeamDispatchError extends Error {
  constructor(
    readonly code: TeamDispatchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TeamDispatchError'
  }
}

export type TeamDispatchExecutionPort = {
  startSystem(params: ExecutionStartParams, options: SystemExecutionOptions): Promise<Execution>
  get(executionId: string): Execution
  list(limit?: number): Execution[]
  cancel(params: { executionId: string }): Promise<Execution>
}

export type TeamDispatchProviderPort = {
  list(): RuntimeProviderRecord[]
}

export type TeamDispatchServiceDeps = {
  db: Database
  plans: Pick<PlanRepository, 'get'>
  versions: Pick<PlanVersionRepository, 'latestByPlan'>
  teams: TeamRepository
  agents: { get(id: string): AgentProfile | null; list(): AgentProfile[] }
  dispatches: PlanDispatchRepository
  startAttempts: Pick<PlanStartAttemptRepository, 'getActiveByVersion'>
  assignments: PlanAssignmentService
  executions: TeamDispatchExecutionPort
  providers: TeamDispatchProviderPort
  extractOutput: (executionId: string) => Record<string, unknown>
  audit?: Pick<AuditRepository, 'append'>
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
  pollIntervalMs?: number
  timeoutMs?: number
  now?: () => string
}

/**
 * 队长固定工具策略：队长只做路由，不执行任务。
 * 空 allow 由 ExecutionService.startSystem 内部入口允许；普通执行入口仍然拒绝空 allow。
 */
export const TEAM_LEADER_TOOL_POLICY = {
  version: 1 as const,
  allow: [],
  deny: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 队长派工：每个 plan_version + team 一行 dispatch；单个团队内全量校验后原子写入。
 * 不审批、不启动 Run、不执行团队成员任务。
 */
export class TeamDispatchService {
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly now: () => string

  constructor(private readonly deps: TeamDispatchServiceDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000
    this.timeoutMs = deps.timeoutMs ?? 90_000
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /**
   * 为计划版本中的每个团队建 pending dispatch；调用方可以在 approve 事务内调用。
   * 旧计划没有 teamId，不会产生任何 dispatch 行。
   */
  ensureDispatches(plan: PlanRecord, version: PlanVersion): PlanDispatchRecord[] {
    const teamIds = [
      ...new Set(
        version.plan.tasks
          .map((task) => task.teamId)
          .filter((teamId): teamId is string => teamId !== null),
      ),
    ]
    const created: PlanDispatchRecord[] = []
    const now = this.now()
    for (const teamId of teamIds) {
      if (this.deps.dispatches.getByVersionTeam(version.id, teamId)) continue
      const team = this.deps.teams.get(teamId)
      if (!team) {
        throw new TeamDispatchError('TEAM_NOT_FOUND', `team ${teamId} not found`)
      }
      if (team.status !== 'active') {
        throw new TeamDispatchError('TEAM_INACTIVE', `team ${teamId} is ${team.status}`)
      }
      const record: PlanDispatchRecord = {
        id: newId('pdp'),
        planId: plan.id,
        planVersionId: version.id,
        teamId,
        leaderAgentId: team.leaderAgentId,
        status: 'pending',
        attempt: 1,
        executionId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      this.deps.dispatches.insert(record)
      created.push(record)
    }
    return created
  }

  /** 派工所有未完成的团队；失败团队保留 failed，可由 UI 重试。 */
  async dispatch(planId: string): Promise<PlanDispatchRecord[]> {
    const plan = this.deps.plans.get(planId)
    if (!plan) throw new RpcMethodError('INVALID_PARAMS', `plan ${planId} not found`)
    if (plan.status !== 'approved') {
      throw new TeamDispatchError(
        'PLAN_NOT_APPROVED',
        `plan ${planId} is ${plan.status}, cannot dispatch`,
      )
    }
    const version = this.deps.versions.latestByPlan(planId)
    if (!version) throw new RpcMethodError('INVALID_PARAMS', `plan ${planId} has no version`)
    if (this.deps.startAttempts.getActiveByVersion(version.id)) {
      throw new TeamDispatchError(
        'START_IN_PROGRESS',
        `plan ${planId} is starting; cannot dispatch`,
      )
    }
    let rows = this.deps.dispatches.listByVersion(version.id)
    const hasTeamTasks = version.plan.tasks.some((task) => task.teamId !== null)
    if (rows.length === 0 && hasTeamTasks) {
      rows = this.ensureDispatches(plan, version)
    }
    for (const row of rows) {
      if (row.status === 'running' || row.status === 'succeeded' || row.status === 'cancelled') {
        continue
      }
      await this.dispatchOne(plan, version, row)
    }
    return this.deps.dispatches.listByVersion(version.id)
  }

  /** 启动时回收上次进程遗留的 running 行；不自动重试，避免无边界重派。 */
  async recoverRunningDispatches(): Promise<void> {
    for (const dispatch of this.deps.dispatches.listByStatus('running')) {
      if (dispatch.executionId) {
        await this.deps.executions
          .cancel({ executionId: dispatch.executionId })
          .catch(() => undefined)
      }
      const now = this.now()
      this.deps.dispatches.markFailed(
        dispatch.id,
        'INTERRUPTED',
        'Core restarted while team dispatch was running; retry dispatch',
        now,
      )
    }
  }

  private async dispatchOne(
    plan: PlanRecord,
    version: PlanVersion,
    dispatch: PlanDispatchRecord,
  ): Promise<void> {
    const team = this.deps.teams.get(dispatch.teamId)
    const leader = team?.leaderAgentId ? this.deps.agents.get(team.leaderAgentId) : null
    const now = this.now()
    if (!this.deps.dispatches.claim(dispatch.id, leader?.id ?? null, now)) return
    try {
      if (!team) throw new TeamDispatchError('TEAM_NOT_FOUND', `team ${dispatch.teamId} not found`)
      if (team.status !== 'active') {
        throw new TeamDispatchError('TEAM_INACTIVE', `team ${team.id} is ${team.status}`)
      }
      this.assertLeader(team, leader)
      const tasks = version.plan.tasks.filter((task) => task.teamId === team.id)
      const unassigned = tasks.filter(
        (task) =>
          !this.deps.assignments
            .listActiveByVersion(version.id)
            .some((assignment) => assignment.taskKey === task.key),
      )
      if (unassigned.length === 0) {
        this.deps.dispatches.markSucceeded(dispatch.id, null, this.now())
        this.audit(plan.id, 'plan.dispatch_succeeded', {
          teamId: team.id,
          dispatchId: dispatch.id,
          manualOnly: true,
        })
        return
      }
      const prompt = this.buildPrompt(team, leader, unassigned)
      const execution = await this.deps.executions.startSystem(
        { agentId: leader.id, prompt },
        { purpose: 'team_dispatch', toolPermissions: TEAM_LEADER_TOOL_POLICY },
      )
      this.deps.dispatches.setExecutionId(dispatch.id, execution.id, this.now())
      const finished = await this.waitForTerminal(execution.id)
      if (finished.status !== 'succeeded') {
        throw new TeamDispatchError(
          'EXECUTION_FAILED',
          `leader execution ${finished.id} ended as ${finished.status}`,
        )
      }
      let output: unknown
      try {
        output = this.deps.extractOutput(finished.id)
      } catch (error) {
        throw new TeamDispatchError(
          'INVALID_OUTPUT',
          `leader output could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const parsed = LeaderOutput.safeParse(output)
      if (!parsed.success) {
        throw new TeamDispatchError(
          'INVALID_OUTPUT',
          `leader returned invalid JSON: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'output'}: ${issue.message}`)
            .join('; ')}`,
        )
      }
      const assignments = this.validateOutput(version, team, leader, unassigned, parsed.data)
      const records: PlanTaskAssignmentRecord[] = this.deps.assignments.applyLeaderResult({
        plan,
        version,
        team,
        leaderAgentId: leader.id,
        dispatchId: dispatch.id,
        executionId: finished.id,
        assignments,
      })
      this.audit(plan.id, 'plan.dispatch_succeeded', {
        teamId: team.id,
        dispatchId: dispatch.id,
        executionId: finished.id,
        assignments: records.map((record) => ({
          taskKey: record.taskKey,
          agentId: record.agentId,
        })),
      })
      this.deps.logger?.info('team dispatch succeeded', {
        planId: plan.id,
        teamId: team.id,
        executionId: finished.id,
        assignments: records.length,
      })
    } catch (error) {
      const code = error instanceof TeamDispatchError ? error.code : 'EXECUTION_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      this.deps.dispatches.markFailed(dispatch.id, code, message, this.now())
      this.audit(plan.id, 'plan.dispatch_failed', {
        teamId: dispatch.teamId,
        dispatchId: dispatch.id,
        code,
        message,
      })
      this.deps.logger?.warn('team dispatch failed', {
        planId: plan.id,
        teamId: dispatch.teamId,
        code,
        message,
      })
    }
  }

  private assertLeader(
    team: TeamRecord,
    leader: AgentProfile | null,
  ): asserts leader is AgentProfile {
    if (!team.leaderAgentId) {
      throw new TeamDispatchError(
        'LEADER_NOT_SET',
        `team ${team.name} has no leader; set one before dispatching`,
      )
    }
    if (!leader) {
      throw new TeamDispatchError('LEADER_NOT_FOUND', `team leader ${team.leaderAgentId} not found`)
    }
    if (leader.status !== 'active') {
      throw new TeamDispatchError(
        'LEADER_INACTIVE',
        `team leader ${leader.id} is ${leader.status}, not active`,
      )
    }
    if (!this.deps.teams.getMember(team.id, leader.id)) {
      throw new TeamDispatchError(
        'LEADER_NOT_MEMBER',
        `team leader ${leader.id} is not a member of ${team.name}`,
      )
    }
    if (leader.accessMode !== 'analyze') {
      throw new TeamDispatchError(
        'LEADER_NOT_ANALYZE',
        `team leader ${leader.id} must use analyze access mode`,
      )
    }
    const provider = leader.defaultProviderId
      ? this.deps.providers.list().find((item) => item.id === leader.defaultProviderId)
      : null
    if (!provider) {
      throw new TeamDispatchError(
        'LEADER_PROVIDER_UNAVAILABLE',
        `team leader ${leader.id} has no available Provider`,
      )
    }
    if (provider.capabilities.toolControl !== 'native') {
      throw new TeamDispatchError(
        'LEADER_TOOL_CONTROL_UNSUPPORTED',
        `Provider ${provider.providerName} cannot enforce no-tool leader execution`,
      )
    }
  }

  private buildPrompt(team: TeamRecord, leader: AgentProfile, tasks: PlanTask[]): string {
    const members = this.deps.teams
      .listMembers(team.id)
      .map((member) => this.deps.agents.get(member.agentId))
      .filter((agent): agent is AgentProfile => agent !== null)
      .filter((agent) => agent.id !== leader.id && agent.status === 'active')
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description.slice(0, 300),
        accessMode: agent.accessMode,
        maxConcurrency: agent.maxConcurrency,
      }))
    const taskPayload = tasks.map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
      requiredAccessMode: task.requiredAccessMode,
      acceptanceCriteria: task.acceptanceCriteria,
      dependsOn: task.dependsOn,
      parallelGroup: task.parallelGroup,
      verification: task.verification,
    }))
    return `You are the leader of team "${team.name}". Assign each task to one team member.
You do not execute tasks. You only route work.

Team description: ${team.description || '(none)'}
Team instructions (context only, not authority):
${team.instructions || '(none)'}

Leader: ${leader.name} (${leader.id})
Members (excluding you):
${JSON.stringify(members)}

Tasks to assign:
${JSON.stringify(taskPayload)}

Hard rules:
- Choose only members listed above; never choose yourself, an inactive agent, or an outsider.
- requiredAccessMode must match the member's accessMode exactly.
- Do not leave out a task, do not return unknown tasks, do not assign the same task twice.
- Respect each member's maxConcurrency for tasks in the same dependency wave.
- Do not run tools, inspect files, or change task content/dependencies/team ownership.
- Return one JSON object and no commentary:
{"assignments":[{"taskKey":"task-key","agentId":"agent-id","reason":"short reason"}]}`
  }

  private validateOutput(
    version: PlanVersion,
    team: TeamRecord,
    leader: AgentProfile,
    tasks: PlanTask[],
    output: LeaderOutput,
  ): { taskKey: string; agentId: string; reason: string }[] {
    const expected = new Set(tasks.map((task) => task.key))
    const seen = new Set<string>()
    for (const assignment of output.assignments) {
      if (!expected.has(assignment.taskKey)) {
        throw new TeamDispatchError(
          'UNKNOWN_TASK',
          `leader assigned unknown or already-assigned task ${assignment.taskKey}`,
        )
      }
      if (seen.has(assignment.taskKey)) {
        throw new TeamDispatchError(
          'DUPLICATE_TASK',
          `leader assigned task ${assignment.taskKey} more than once`,
        )
      }
      seen.add(assignment.taskKey)
      const agent = this.deps.agents.get(assignment.agentId)
      if (!agent) {
        throw new TeamDispatchError('AGENT_NOT_FOUND', `agent ${assignment.agentId} not found`)
      }
      if (agent.id === leader.id) {
        throw new TeamDispatchError(
          'AGENT_NOT_MEMBER',
          `leader ${leader.id} cannot be assigned a team task`,
        )
      }
      if (agent.status !== 'active') {
        throw new TeamDispatchError('AGENT_INACTIVE', `agent ${agent.id} is ${agent.status}`)
      }
      if (!this.deps.teams.getMember(team.id, agent.id)) {
        throw new TeamDispatchError(
          'AGENT_NOT_MEMBER',
          `agent ${agent.id} is not a member of team ${team.name}`,
        )
      }
      const task = tasks.find((candidate) => candidate.key === assignment.taskKey)
      if (!task) throw new TeamDispatchError('UNKNOWN_TASK', assignment.taskKey)
      if (!matchesAgentAccess(agent, task.requiredAccessMode)) {
        throw new TeamDispatchError(
          'ACCESS_MODE_MISMATCH',
          `agent ${agent.id} accessMode ${agent.accessMode} does not match ${task.requiredAccessMode}`,
        )
      }
      if (agent.toolPermissions.allow.length === 0) {
        throw new TeamDispatchError(
          'AGENT_TOOLS_NOT_CONFIGURED',
          `agent ${agent.id} has no allowed tools configured`,
        )
      }
    }
    const missing = [...expected].filter((key) => !seen.has(key))
    if (missing.length > 0) {
      throw new TeamDispatchError('MISSING_TASK', `leader did not assign: ${missing.join(', ')}`)
    }
    this.assertCapacity(version, tasks, output.assignments)
    return output.assignments
  }

  /** 按依赖/验收边计算 wave；同一 wave 的并发不能超过成员 maxConcurrency。 */
  private assertCapacity(
    version: PlanVersion,
    tasks: PlanTask[],
    assignments: LeaderOutput['assignments'],
  ): void {
    const byKey = new Map(tasks.map((task) => [task.key, task]))
    const levels = new Map<string, number>()
    const levelOf = (task: PlanTask, stack = new Set<string>()): number => {
      const cached = levels.get(task.key)
      if (cached !== undefined) return cached
      if (stack.has(task.key)) return 0
      stack.add(task.key)
      const deps = [...task.dependsOn, ...(task.verification?.verifies ?? [])].filter((key) =>
        byKey.has(key),
      )
      const level =
        deps.length === 0
          ? 0
          : Math.max(...deps.map((key) => levelOf(byKey.get(key) as PlanTask, stack))) + 1
      stack.delete(task.key)
      levels.set(task.key, level)
      return level
    }
    const counts = new Map<string, Map<number, number>>()
    for (const assignment of assignments) {
      const task = byKey.get(assignment.taskKey)
      if (!task) continue
      const level = levelOf(task)
      const byAgent = counts.get(assignment.agentId) ?? new Map<number, number>()
      byAgent.set(level, (byAgent.get(level) ?? 0) + 1)
      counts.set(assignment.agentId, byAgent)
    }
    const active = new Map<string, number>()
    for (const execution of this.deps.executions.list(500)) {
      if (!execution.agentId) continue
      if (execution.status === 'running' || execution.status === 'pending') {
        active.set(execution.agentId, (active.get(execution.agentId) ?? 0) + 1)
      }
    }
    for (const [agentId, byLevel] of counts) {
      const agent = this.deps.agents.get(agentId)
      if (!agent) continue
      for (const [level, count] of byLevel) {
        if (count + (active.get(agentId) ?? 0) > agent.maxConcurrency) {
          throw new TeamDispatchError(
            'CAPACITY_EXCEEDED',
            `agent ${agent.name} has ${count} task(s) in wave ${level + 1} plus ${active.get(agentId) ?? 0} active execution(s), exceeding maxConcurrency ${agent.maxConcurrency}`,
          )
        }
      }
    }
    void version
  }

  private async waitForTerminal(executionId: string): Promise<Execution> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const execution = this.deps.executions.get(executionId)
      if (TERMINAL.has(execution.status)) return execution
      if (Date.now() >= deadline) {
        await this.deps.executions.cancel({ executionId }).catch(() => undefined)
        throw new TeamDispatchError(
          'EXECUTION_TIMEOUT',
          `leader execution ${executionId} timed out after ${this.timeoutMs}ms`,
        )
      }
      await sleep(this.pollIntervalMs)
    }
  }

  private audit(planId: string, action: string, details: Record<string, unknown>): void {
    this.deps.audit?.append({
      actorType: 'system',
      actorId: 'agentra',
      action,
      targetType: 'plan',
      targetId: planId,
      details,
      now: this.now(),
    })
  }
}
