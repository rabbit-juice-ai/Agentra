import {
  type AgentProfile,
  type Execution,
  ExecutionExitedPayload,
  type ExecutionLog,
  ExecutionOutputPayload,
  type ExecutionStartParams,
  ExecutionStatePayload,
  RpcMethodError,
  type RuntimeEvent,
  type RuntimeProviderRecord,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  TeamMessageKind,
  TeamTaskMessageRecord,
  TeamTaskMessageRepository,
  TeamTaskRunRecord,
  TeamTaskRunRepository,
  TeamTaskRunStepRepository,
  TeamTaskSubtaskRecord,
  TeamTaskSubtaskRepository,
} from '../db/repositories/collaboration-repository'
import type { TeamRecord, TeamRepository } from '../db/repositories/team-repository'
import type { WorkRecord, WorkRepository } from '../db/repositories/work-repository'
import type { AssignmentService } from './assignment-service'
import type { CheckpointService } from './checkpoint-service'
import type { ExecutionStartOptions, SystemExecutionOptions } from './execution-service'
import {
  renderTaskMemoryForPrompt,
  type TaskMemory,
  type TaskMemoryService,
} from './task-memory-service'
import type { WorkService } from './work-service'

const LeaderReply = z.object({
  reply: z.string().min(1).max(20_000),
  subtasks: z
    .array(
      z
        .object({
          title: z.string().min(1).max(200),
          description: z.string().max(4000).default(''),
          assigneeAgentId: z.string().min(1).nullable().optional(),
        })
        .strict(),
    )
    .max(30)
    .default([]),
  completeSubtaskIds: z.array(z.string().min(1)).max(50).default([]),
  decision: z.string().max(4000).nullable().default(null),
  escalateToPlanner: z.boolean().default(false),
  plannerQuestion: z.string().max(4000).nullable().default(null),
})

const MemberReply = z.object({
  reply: z.string().min(1).max(20_000),
  blocked: z.boolean().default(false),
  question: z.string().max(4000).nullable().default(null),
})

export type TeamLeaderReply = z.infer<typeof LeaderReply>
export type TeamMemberReply = z.infer<typeof MemberReply>

const MEMBER_FALLBACK_REPLY = '成员已完成本轮处理。'

export const TEAM_LEADER_TOOL_POLICY = {
  version: 1 as const,
  allow: [],
  deny: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
}

export type TeamTaskExecutionPort = {
  start(params: ExecutionStartParams, options?: ExecutionStartOptions): Promise<Execution>
  startSystem(params: ExecutionStartParams, options: SystemExecutionOptions): Promise<Execution>
  get(executionId: string): Execution
  list(limit?: number): Execution[]
  cancel(params: { executionId: string }): Promise<Execution>
  sendMessage(params: { executionId: string; message: string }): Promise<{ sent: true }>
}

export type TeamTaskPlannerPort = {
  escalateFromTeam(input: {
    workId: string
    teamId: string
    teamName: string
    workTitle: string
    question: string
    context: string
  }): Promise<void>
}

export type TeamCollaborationServiceDeps = {
  db: Database
  works: WorkService
  workRepository: WorkRepository
  taskMemories?: Pick<TaskMemoryService, 'refreshForWork'>
  checkpoints?: Pick<CheckpointService, 'createForExecution'>
  teams: TeamRepository
  agents: AgentRepository
  assignments: AssignmentService
  executions: TeamTaskExecutionPort
  providers: { list(): RuntimeProviderRecord[] }
  extractOutput: (executionId: string) => Record<string, unknown>
  executionLogs: { list(executionId: string, after?: number, limit?: number): ExecutionLog[] }
  messages: TeamTaskMessageRepository
  subtasks: TeamTaskSubtaskRepository
  runs: TeamTaskRunRepository
  steps: TeamTaskRunStepRepository
  planner: TeamTaskPlannerPort
  hub?: { subscribe(listener: (event: RuntimeEvent) => void): () => void }
  audit?: AuditRepository
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
  now?: () => string
}

export type TeamTaskView = {
  work: WorkRecord
  messages: TeamTaskMessageRecord[]
  subtasks: TeamTaskSubtaskRecord[]
  runs: TeamTaskRunRecord[]
  steps: ReturnType<TeamTaskRunStepRepository['listByWork']>
  activeRun: TeamTaskRunRecord | null
}

export type TeamCommentMode = 'normal' | 'steer' | 'after_run' | 'restart' | 'skip'

/**
 * 团队任务线程引擎：
 * - 任务发给团队后，队长先拆解/分派；
 * - 成员完成后回到队长验收；
 * - 成员/队长遇到无法决定的问题升级 Planner；
 * - 所有消息、决定、运行都在同一个任务线程里。
 */
export class TeamCollaborationService {
  private readonly now: () => string
  private readonly startingRuns = new Set<string>()

  constructor(private readonly deps: TeamCollaborationServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    deps.hub?.subscribe((event) => this.onRuntimeEvent(event))
  }

  async createFromPlanner(input: {
    teamId: string
    title: string
    goal: string
    description: string
    acceptanceCriteria: string[]
    rootPath: string
    projectId?: string
  }): Promise<{ workId: string }> {
    const team = this.requireActiveTeam(input.teamId)
    const leaderId = team.leaderAgentId
    if (!leaderId) throw new RpcMethodError('INVALID_PARAMS', `team ${team.id} has no leader`)
    const leader = this.requireAgent(leaderId)
    this.assertLeader(team, leader)
    const work = this.deps.works.create({
      name: input.title,
      description: input.description,
      objective: input.goal,
      rootPath: input.rootPath,
      collaborationMode: 'team',
      ownerTeamId: team.id,
      issueStatus: 'backlog',
      assigneeAgentId: leaderId,
      acceptanceCriteria: input.acceptanceCriteria,
      projectId: input.projectId,
    })
    this.deps.works.linkTeam(work.id, team.id)
    this.deps.works.activate(work.id)
    this.deps.works.setIssueStatus(work.id, 'in_progress')
    const message = this.appendMessage(
      work.id,
      'leader',
      leader.id,
      `收到，我先拆解「${input.title}」，然后把任务分给大家。`,
      'message',
      { ack: true },
    )
    this.enqueueRun(work.id, leaderId, 'leader', null, message.id)
    this.audit(work.id, 'team_task.created', { teamId: team.id, leaderId })
    return { workId: work.id }
  }

  get(workId: string): TeamTaskView {
    const work = this.requireTeamTask(workId)
    return {
      work,
      messages: this.deps.messages.listByWork(workId),
      subtasks: this.deps.subtasks.listByWork(workId),
      runs: this.deps.runs.listByWork(workId),
      steps: this.deps.steps.listByWork(workId),
      activeRun: this.deps.runs.getActiveByWork(workId),
    }
  }

  /**
   * 线程评论。normal 会在有运行排队；steer 注入当前运行；
   * after_run 排队到下一次；restart 取消当前运行后重开；skip 只留消息。
   */
  async comment(input: {
    workId: string
    content: string
    authorId: string
    mentions?: string[]
    mode?: TeamCommentMode
  }): Promise<{ message: TeamTaskMessageRecord; run: TeamTaskRunRecord | null }> {
    const work = this.requireTeamTask(input.workId)
    const content = input.content.trim()
    if (content.length === 0)
      throw new RpcMethodError('INVALID_PARAMS', 'comment must not be blank')
    const mode = input.mode ?? 'normal'
    const message = this.appendMessage(work.id, 'user', input.authorId, content, 'message', {})
    if (mode === 'skip') return { message, run: null }
    const team = this.requireOwnerTeam(work)
    const target = this.pickTarget(work, team, input.mentions ?? [])
    if (!target) {
      this.appendMessage(
        work.id,
        'system',
        'agentra',
        '当前没有可触发的成员。请先设置任务负责人或 @ 一个团队成员。',
        'status',
        {},
      )
      return { message, run: null }
    }
    const role = target.id === team.leaderAgentId ? 'leader' : 'member'
    const active = this.deps.runs.getActiveByWork(work.id)
    if (mode === 'steer') {
      if (!active?.executionId) {
        this.appendMessage(
          work.id,
          'system',
          'agentra',
          '当前没有运行中的执行可以注入，已改为排队。',
          'status',
          {},
        )
      } else {
        await this.deps.executions.sendMessage({
          executionId: active.executionId,
          message: content,
        })
        this.appendMessage(
          work.id,
          'system',
          'agentra',
          `已把老板的指令注入 Agent「${target.name}」当前运行。`,
          'status',
          { executionId: active.executionId },
        )
        return { message, run: active }
      }
    }
    if (mode === 'restart' && active) {
      if (active.executionId) {
        await this.deps.executions
          .cancel({ executionId: active.executionId })
          .catch(() => undefined)
      }
      this.deps.runs.finish(active.id, 'cancelled', 'RESTART', 'restarted by boss', this.now())
      this.appendMessage(work.id, 'system', 'agentra', '老板要求重启当前运行。', 'status', {})
    }
    const run = this.enqueueRun(work.id, target.id, role, null, message.id)
    return { message, run }
  }

  setStatus(workId: string, status: WorkRecord['issueStatus']): WorkRecord {
    this.requireTeamTask(workId)
    return this.deps.works.setIssueStatus(workId, status)
  }

  /** Planner 回复团队升级：写入团队线程，并让队长继续处理。 */
  onPlannerDecision(workId: string, content: string): void {
    const work = this.requireTeamTask(workId)
    const team = this.requireOwnerTeam(work)
    const message = this.appendMessage(work.id, 'planner', 'planner', content, 'decision', {
      from: 'planner',
    })
    if (work.issueStatus === 'backlog' || work.issueStatus === 'triage') {
      this.deps.works.setIssueStatus(work.id, 'in_progress')
    }
    if (team.leaderAgentId) {
      this.enqueueRun(work.id, team.leaderAgentId, 'leader', null, message.id)
    }
  }

  /**
   * Core 启动恢复：queued 继续启动；running 有执行则等待终态，无执行或已终态则收敛。
   * 只在 Daemon 可用且非 Restore 启动时调用。
   */
  async recover(): Promise<void> {
    const workIds = new Set<string>()
    for (const run of this.deps.runs.listUnfinished()) {
      workIds.add(run.workId)
      if (run.status === 'queued') {
        void this.startRun(run)
        continue
      }
      if (!run.executionId) {
        if (run.subtaskId) {
          this.deps.subtasks.updateStatus(run.subtaskId, ['running'], 'blocked', this.now())
        }
        this.deps.runs.finish(
          run.id,
          'failed',
          'INTERRUPTED',
          'Core restarted without an execution id',
          this.now(),
        )
        continue
      }
      let execution: Execution | null = null
      try {
        execution = this.deps.executions.get(run.executionId)
      } catch {
        execution = null
      }
      if (!execution) {
        if (run.subtaskId) {
          this.deps.subtasks.updateStatus(run.subtaskId, ['running'], 'blocked', this.now())
        }
        this.deps.runs.finish(
          run.id,
          'failed',
          'INTERRUPTED',
          'Execution missing after restart',
          this.now(),
        )
        continue
      }
      if (
        execution.status === 'succeeded' ||
        execution.status === 'failed' ||
        execution.status === 'cancelled' ||
        execution.status === 'crashed'
      ) {
        await this.onExecutionTerminal(
          run.executionId,
          execution.status === 'crashed' ? 'failed' : execution.status,
        )
      }
      // still running: leave it; ExecutionService reconciliation will emit the terminal event.
    }
    for (const workId of workIds) this.startQueued(workId)
  }

  /**
   * 旧版本在长输出提取失败时会把成员报告降级为占位文案。
   * 启动时从对应执行的最终结果重新提取，修复历史线程；新运行不会再产生占位文案。
   */
  backfillMemberReports(limit = 50): number {
    let repaired = 0
    for (const message of this.deps.messages.listMemberMessagesByContent(
      MEMBER_FALLBACK_REPLY,
      limit,
    )) {
      const runId = typeof message.metadata.runId === 'string' ? message.metadata.runId : null
      if (!runId) continue
      const run = this.deps.runs.get(runId)
      if (!run?.executionId) continue
      const output = this.tryExtractOutput(run.executionId)
      if (!output) continue
      const reply = this.parseMemberReply(output).reply.trim()
      if (!reply || reply === MEMBER_FALLBACK_REPLY) continue
      this.deps.messages.updateContent(message.id, reply)
      repaired++
    }
    return repaired
  }

  /**
   * v30 之前完成的成员运行没有持久化工具步骤。
   * 启动时从执行日志回填 Bash/Read/Edit 等步骤，让历史消息的“详情”也能看到运行日志。
   */
  backfillRunSteps(limit = 50): number {
    let inserted = 0
    for (const run of this.deps.runs.listMemberRunsWithoutSteps(limit)) {
      if (!run.executionId) continue
      const before = this.deps.steps.listByRun(run.id).length
      let cursor = 0
      for (;;) {
        const page = this.deps.executionLogs.list(run.executionId, cursor, 500)
        if (!page.length) break
        for (const log of page) {
          cursor = log.sequenceNo
          if (log.stream !== 'structured') continue
          try {
            const value = JSON.parse(log.content) as Record<string, unknown>
            this.recordStepsFromValue(run, value, log.timestamp)
          } catch {
            // 非 JSON structured 输出不进入执行记录。
          }
        }
      }
      inserted += this.deps.steps.listByRun(run.id).length - before
    }
    return inserted
  }

  /** 测试/恢复路径使用：执行终态进入协作状态机。 */
  async onExecutionTerminal(
    executionId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): Promise<void> {
    const run = this.deps.runs.getByExecutionId(executionId)
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return
    if (
      !this.deps.runs.finish(
        run.id,
        status,
        status === 'succeeded' ? null : 'EXECUTION_FAILED',
        status === 'succeeded' ? null : `execution ${status}`,
        this.now(),
      )
    ) {
      return
    }
    const work = this.deps.workRepository.get(run.workId)
    if (!work) return
    if (status !== 'succeeded') {
      if (run.subtaskId) {
        this.deps.subtasks.updateStatus(run.subtaskId, ['running'], 'blocked', this.now())
      }
      this.appendMessage(
        run.workId,
        'system',
        'agentra',
        `Agent 运行${status === 'cancelled' ? '已取消' : '失败'}。`,
        'status',
        { runId: run.id, executionId },
      )
      const checkpoint = this.createCheckpointForRun(executionId, run.workId)
      if (!checkpoint.blocked) this.startQueued(run.workId)
      return
    }
    const output = this.tryExtractOutput(executionId)
    let checkpointResult: { blocked: boolean } | null = null
    const ensureCheckpoint = (): { blocked: boolean } => {
      checkpointResult ??= this.createCheckpointForRun(executionId, work.id)
      return checkpointResult
    }
    if (run.role === 'leader') {
      await this.handleLeaderFinished(work, run, output, () => !ensureCheckpoint().blocked)
    } else {
      await this.handleMemberFinished(work, run, output, () => !ensureCheckpoint().blocked)
    }
    if (!ensureCheckpoint().blocked) this.startQueued(work.id)
  }

  private createCheckpointForRun(executionId: string, workId: string): { blocked: boolean } {
    if (!this.deps.checkpoints) return { blocked: false }
    try {
      const result = this.deps.checkpoints.createForExecution(executionId, 'team')
      if (result.blocked) {
        this.appendMessage(
          workId,
          'system',
          'agentra',
          'Checkpoint 未通过校验或存在高风险副作用，已阻止后续自动运行，等待人工处理。',
          'status',
          { executionId, checkpointId: result.checkpointId, reasons: result.reasons },
        )
      }
      return { blocked: result.blocked }
    } catch (error) {
      this.deps.logger?.warn('team checkpoint creation failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.appendMessage(
        workId,
        'system',
        'agentra',
        'Checkpoint 创建失败，已阻止后续自动运行，等待人工处理。',
        'status',
        { executionId },
      )
      return { blocked: true }
    }
  }

  private async handleLeaderFinished(
    work: WorkRecord,
    run: TeamTaskRunRecord,
    output: Record<string, unknown> | null,
    beforeEnqueue?: () => boolean,
  ): Promise<void> {
    const team = this.requireOwnerTeam(work)
    const leader = run.agentId ? this.deps.agents.get(run.agentId) : null
    if (!leader) return
    const parsed = this.parseLeaderReply(output)
    const message = this.appendMessage(
      work.id,
      'leader',
      leader.id,
      parsed.reply,
      parsed.decision ? 'decision' : 'message',
      {
        runId: run.id,
        subtaskId: run.subtaskId,
        long: parsed.reply.length > 1200,
      },
    )
    if (parsed.decision) {
      this.appendMessage(work.id, 'leader', leader.id, parsed.decision, 'decision', {
        runId: run.id,
        long: parsed.decision.length > 1200,
      })
    }
    for (const subtaskId of parsed.completeSubtaskIds) {
      const subtask = this.deps.subtasks.get(subtaskId)
      if (!subtask || subtask.workId !== work.id) continue
      this.deps.subtasks.updateStatus(
        subtaskId,
        ['pending', 'running', 'review', 'blocked'],
        'done',
        this.now(),
      )
    }
    for (const subtask of parsed.subtasks) {
      if (!subtask.assigneeAgentId) {
        this.appendMessage(
          work.id,
          'system',
          'agentra',
          `队长没有给子任务「${subtask.title}」指定成员，已跳过。`,
          'status',
          {},
        )
        continue
      }
      const assignee = this.deps.agents.get(subtask.assigneeAgentId)
      if (
        !assignee ||
        assignee.status !== 'active' ||
        !this.deps.teams.getMember(team.id, assignee.id)
      ) {
        this.appendMessage(
          work.id,
          'system',
          'agentra',
          `子任务「${subtask.title}」的成员无效或不在团队，已跳过。`,
          'status',
          {},
        )
        continue
      }
      if (assignee.id === team.leaderAgentId) {
        this.appendMessage(
          work.id,
          'system',
          'agentra',
          `队长不能把子任务「${subtask.title}」分给自己，已跳过。`,
          'status',
          {},
        )
        continue
      }
      const duplicate = this.deps.subtasks
        .listByWork(work.id)
        .some((existing) => existing.title.trim() === subtask.title.trim())
      if (duplicate) continue
      const record = {
        id: newId('tsub'),
        workId: work.id,
        title: subtask.title,
        description: subtask.description,
        assigneeAgentId: assignee.id,
        status: 'pending' as const,
        createdAt: this.now(),
        updatedAt: this.now(),
        completedAt: null,
      }
      this.deps.subtasks.insert(record)
      // 让线程里出现明确的“队长 @成员”动作，而不是只有一段大段文本。
      this.appendMessage(
        work.id,
        'leader',
        leader.id,
        `@${assignee.name} 这个交给你：「${subtask.title}」，完成后 @${leader.name} 查收。`,
        'decision',
        {
          runId: run.id,
          subtaskId: record.id,
          assigneeAgentId: assignee.id,
          assignedBy: leader.id,
          mention: assignee.name,
        },
      )
    }
    if (parsed.escalateToPlanner) {
      const question = parsed.plannerQuestion ?? parsed.reply
      this.appendMessage(
        work.id,
        'leader',
        leader.id,
        `这个问题我需要找 Planner 确认一下：${question}`,
        'escalation',
        {
          question,
          runId: run.id,
        },
      )
      void this.deps.planner
        .escalateFromTeam({
          workId: work.id,
          teamId: team.id,
          teamName: team.name,
          workTitle: work.name,
          question,
          context: this.contextFor(work.id),
        })
        .catch((error) => {
          this.deps.logger?.warn('planner escalation failed', {
            workId: work.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }
    const pending = this.deps.subtasks.nextPending(work.id)
    if (pending?.assigneeAgentId) {
      if (beforeEnqueue && !beforeEnqueue()) return
      this.enqueueRun(work.id, pending.assigneeAgentId, 'member', pending.id, message.id)
      this.deps.works.setIssueStatus(work.id, 'in_progress')
      return
    }
    const all = this.deps.subtasks.listByWork(work.id)
    if (all.length > 0 && all.every((subtask) => subtask.status === 'done')) {
      this.deps.works.setIssueStatus(work.id, 'review')
      this.appendMessage(
        work.id,
        'leader',
        leader.id,
        '所有子任务都完成了，任务已提交验收。',
        'message',
        { runId: run.id },
      )
    }
  }

  private async handleMemberFinished(
    work: WorkRecord,
    run: TeamTaskRunRecord,
    output: Record<string, unknown> | null,
    beforeEnqueue?: () => boolean,
  ): Promise<void> {
    const parsed = this.parseMemberReply(output)
    const team = this.requireOwnerTeam(work)
    const leader = team.leaderAgentId ? this.deps.agents.get(team.leaderAgentId) : null
    const subtask = run.subtaskId ? this.deps.subtasks.get(run.subtaskId) : null
    const completion =
      leader && subtask
        ? parsed.blocked
          ? `@${leader.name} 我这边遇到问题，需要你决策：${parsed.question ?? parsed.reply}`
          : `@${leader.name} 已完成「${subtask.title}」，请查收。\n\n${parsed.reply}`
        : parsed.reply
    const message = this.appendMessage(
      work.id,
      'member',
      run.agentId ?? 'unknown',
      completion,
      parsed.blocked ? 'escalation' : 'message',
      {
        runId: run.id,
        subtaskId: run.subtaskId,
        ...(leader && subtask ? { mention: leader.name, completion: true } : {}),
      },
    )
    if (run.subtaskId) {
      this.deps.subtasks.updateStatus(
        run.subtaskId,
        ['running'],
        parsed.blocked ? 'blocked' : 'review',
        this.now(),
      )
    }
    if (!leader) return
    if (beforeEnqueue && !beforeEnqueue()) return
    this.enqueueRun(work.id, leader.id, 'leader', null, message.id)
    if (parsed.blocked) {
      this.deps.works.setIssueStatus(work.id, 'in_progress')
    }
  }

  private enqueueRun(
    workId: string,
    agentId: string,
    role: 'leader' | 'member',
    subtaskId: string | null,
    triggerMessageId: string | null,
  ): TeamTaskRunRecord {
    const active = this.deps.runs.getActiveByWork(workId)
    if (active) {
      if (active.status === 'queued') {
        this.deps.runs.updateQueuedTarget(
          active.id,
          { agentId, role, subtaskId, triggerMessageId },
          this.now(),
        )
        return active
      }
      const queued = this.deps.runs.getQueuedByWork(workId)
      if (queued) {
        this.deps.runs.updateQueuedTarget(
          queued.id,
          { agentId, role, subtaskId, triggerMessageId },
          this.now(),
        )
        return queued
      }
      const record = this.newRun(workId, agentId, role, subtaskId, triggerMessageId, 'queued')
      this.deps.runs.insert(record)
      return record
    }
    const record = this.newRun(workId, agentId, role, subtaskId, triggerMessageId, 'queued')
    this.deps.runs.insert(record)
    void this.startRun(record)
    return record
  }

  private newRun(
    workId: string,
    agentId: string,
    role: 'leader' | 'member',
    subtaskId: string | null,
    triggerMessageId: string | null,
    status: 'queued',
  ): TeamTaskRunRecord {
    const now = this.now()
    return {
      id: newId('trun'),
      workId,
      agentId,
      role,
      triggerMessageId,
      subtaskId,
      status,
      executionId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
    }
  }

  private startQueued(workId: string): void {
    const active = this.deps.runs.getActiveByWork(workId)
    if (active?.status === 'running') return
    if (active?.status === 'queued') {
      void this.startRun(active)
      return
    }
    const queued = this.deps.runs.getQueuedByWork(workId)
    if (queued) void this.startRun(queued)
  }

  private async startRun(run: TeamTaskRunRecord): Promise<void> {
    if (this.startingRuns.has(run.id)) return
    this.startingRuns.add(run.id)
    try {
      await this.startRunInternal(run)
    } finally {
      this.startingRuns.delete(run.id)
    }
  }

  private async startRunInternal(run: TeamTaskRunRecord): Promise<void> {
    let work = this.deps.workRepository.get(run.workId)
    if (!work) {
      this.deps.runs.finish(run.id, 'failed', 'WORK_NOT_FOUND', 'work not found', this.now())
      return
    }
    if (!run.agentId) {
      this.deps.runs.finish(run.id, 'failed', 'AGENT_MISSING', 'run has no agent', this.now())
      return
    }
    work = this.deps.workRepository.get(run.workId) ?? work
    const taskMemory = this.deps.taskMemories?.refreshForWork(work, 'team_run_start') ?? null
    try {
      let execution: Execution
      if (run.role === 'leader') {
        const team = this.requireOwnerTeam(work)
        const leader = this.requireAgent(run.agentId)
        this.assertLeader(team, leader)
        execution = await this.deps.executions.startSystem(
          {
            agentId: leader.id,
            prompt: this.leaderPrompt(work, team, leader, run.triggerMessageId, taskMemory),
          },
          {
            purpose: 'team_leader',
            toolPermissions: TEAM_LEADER_TOOL_POLICY,
            allowInactiveWork: true,
          },
        )
      } else {
        const subtask = run.subtaskId ? this.deps.subtasks.get(run.subtaskId) : null
        const agent = this.requireAgent(run.agentId)
        const team = this.requireOwnerTeam(work)
        if (!this.deps.teams.getMember(team.id, agent.id)) {
          throw new RpcMethodError('INVALID_PARAMS', `agent ${agent.id} is not a team member`)
        }
        if (team.leaderAgentId === agent.id) {
          throw new RpcMethodError(
            'INVALID_PARAMS',
            `team leader ${agent.id} cannot run member task`,
          )
        }
        transaction(this.deps.db, () => {
          this.deps.assignments.ensureWithRoleInTransaction({
            workId: work.id,
            agentId: agent.id,
            workRole: `team-${agent.id.slice(-8)}`,
            teamId: team.id,
            now: this.now(),
            allowInactiveWork: true,
          })
        })
        if (subtask) {
          this.deps.subtasks.updateStatus(subtask.id, ['pending', 'blocked'], 'running', this.now())
        }
        execution = await this.deps.executions.start(
          {
            agentId: agent.id,
            workId: work.id,
            prompt: this.memberPrompt(work, subtask, run.triggerMessageId, taskMemory),
          },
          { allowInactiveWork: true },
        )
      }
      if (!this.deps.runs.markRunning(run.id, execution.id, this.now())) {
        await this.deps.executions.cancel({ executionId: execution.id }).catch(() => undefined)
        return
      }
      if (run.role === 'member') {
        const subtask = run.subtaskId ? this.deps.subtasks.get(run.subtaskId) : null
        const team = this.requireOwnerTeam(work)
        const leader = team.leaderAgentId ? this.deps.agents.get(team.leaderAgentId) : null
        const trigger = run.triggerMessageId ? this.deps.messages.get(run.triggerMessageId) : null
        const mention = leader?.name
        const content =
          trigger?.authorType === 'user'
            ? '收到，老板。我先处理你提到的内容，完成后向你汇报。'
            : mention
              ? `收到，@${mention}。我按你刚才的要求处理「${subtask?.title ?? '这条消息'}」，完成后向你汇报。`
              : `收到，我先处理「${subtask?.title ?? '这条消息'}」，完成后汇报。`
        this.appendMessage(work.id, 'member', run.agentId, content, 'message', {
          runId: run.id,
          executionId: execution.id,
          subtaskId: run.subtaskId,
          ack: true,
          ...(trigger?.authorType !== 'user' && mention ? { mention } : {}),
        })
      } else {
        const trigger = run.triggerMessageId ? this.deps.messages.get(run.triggerMessageId) : null
        // 初始拆解已经在 createFromPlanner 里由队长发过“收到”，不重复。
        if (trigger?.authorType !== 'leader') {
          const member =
            trigger?.authorType === 'member' && trigger.authorId
              ? this.deps.agents.get(trigger.authorId)
              : null
          const triggerSubtaskId =
            trigger && typeof trigger.metadata.subtaskId === 'string'
              ? trigger.metadata.subtaskId
              : null
          const triggerSubtask = triggerSubtaskId ? this.deps.subtasks.get(triggerSubtaskId) : null
          let content = '收到，我继续处理。'
          let mention: string | undefined
          if (member) {
            mention = member.name
            content =
              trigger?.kind === 'escalation'
                ? `收到，@${member.name}。我看一下你遇到的问题。`
                : triggerSubtask
                  ? `收到，@${member.name}。「${triggerSubtask.title}」我来验收。`
                  : `收到，@${member.name}。我看一下你的反馈。`
          } else if (trigger?.authorType === 'user') {
            content = '收到，老板。我先看一下当前情况。'
          } else if (trigger?.authorType === 'planner') {
            content = '收到 Planner 的决策，我继续安排。'
          }
          this.appendMessage(work.id, 'leader', run.agentId, content, 'message', {
            runId: run.id,
            executionId: execution.id,
            ack: true,
            ...(mention ? { mention } : {}),
          })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (run.subtaskId) {
        this.deps.subtasks.updateStatus(
          run.subtaskId,
          ['pending', 'running', 'blocked'],
          'blocked',
          this.now(),
        )
      }
      this.deps.runs.finish(run.id, 'failed', 'START_FAILED', message, this.now())
      this.appendMessage(work.id, 'system', 'agentra', `协作运行启动失败：${message}`, 'status', {
        runId: run.id,
      })
      this.deps.logger?.warn('team task run start failed', {
        workId: work.id,
        runId: run.id,
        error: message,
      })
    }
  }

  private leaderPrompt(
    work: WorkRecord,
    team: TeamRecord,
    leader: AgentProfile,
    triggerMessageId: string | null,
    taskMemory: TaskMemory | null,
  ): string {
    const members = this.deps.teams
      .listMembers(team.id)
      .map((member) => this.deps.agents.get(member.agentId))
      .filter((agent): agent is AgentProfile => agent !== null && agent.id !== leader.id)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description.slice(0, 300),
        accessMode: agent.accessMode,
      }))
    const subtasks = this.deps.subtasks.listByWork(work.id).map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
      assigneeAgentId: subtask.assigneeAgentId,
    }))
    const trigger = triggerMessageId ? this.deps.messages.get(triggerMessageId) : null
    const triggerLine =
      trigger && trigger.authorType !== 'leader'
        ? `${trigger.authorType}: ${trigger.content}`
        : '(none)'
    return `You are the leader of team "${team.name}". You own this team task and coordinate members.
You do not execute tasks. You make decisions, split subtasks, assign members and review their results.

Task: ${work.name}
Goal: ${work.objective}
Description: ${work.description}
Formal acceptance criteria (Work v${work.acceptanceCriteriaVersion}):
${work.acceptanceCriteria.length > 0 ? work.acceptanceCriteria.map((item) => `- ${item}`).join('\n') : '(none)'}
Task memory:
${renderTaskMemoryForPrompt(taskMemory)}
Team instructions:
${team.instructions || '(none)'}

Members:
${JSON.stringify(members)}

Existing subtasks:
${JSON.stringify(subtasks)}

Trigger message:
${triggerLine}

Recent team thread:
${this.contextFor(work.id)}

Rules:
- Always write "reply", "decision" and "plannerQuestion" in Simplified Chinese.
- Talk like a real team leader in first person. Address members as @name and keep the thread conversational.
- You may decide within the task: split, assign, retry, accept subtasks, ask a member to redo.
- Do not change the task goal, acceptance criteria, team ownership or escalate trivial things.
- Use only member ids above; never assign yourself.
- To make a decision, put it in "decision".
- If you cannot decide within your authority, set "escalateToPlanner": true and ask a concrete question.
- Return one JSON object only:
{"reply":"...","subtasks":[{"title":"...","description":"...","assigneeAgentId":"agent-id"}],"completeSubtaskIds":[],"decision":null,"escalateToPlanner":false,"plannerQuestion":null}`
  }

  private memberPrompt(
    work: WorkRecord,
    subtask: TeamTaskSubtaskRecord | null,
    triggerMessageId: string | null,
    taskMemory: TaskMemory | null,
  ): string {
    const trigger = triggerMessageId ? this.deps.messages.get(triggerMessageId) : null
    return `You are a member of the team working on task "${work.name}".
Goal: ${work.objective}
Description: ${work.description}
Formal acceptance criteria (Work v${work.acceptanceCriteriaVersion}):
${work.acceptanceCriteria.length > 0 ? work.acceptanceCriteria.map((item) => `- ${item}`).join('\n') : '(none)'}
Task memory (relevant slice):
${renderTaskMemoryForPrompt(taskMemory)}
Subtask: ${subtask ? `${subtask.title}\n${subtask.description}` : '(general discussion)'}

Recent team thread:
${this.contextFor(work.id)}

Trigger message:
${trigger ? `${trigger.authorType}: ${trigger.content}` : '(none)'}

Do the assigned work in the task workspace. If you are blocked or need the leader to decide, ask a concrete question in "question".
Always write "reply" and "question" in Simplified Chinese.
Talk like a real teammate in first person. Report what you did, risks and next steps; do not restate the task description.
Return one JSON object only:
{"reply":"what you did / what you need","blocked":false,"question":null}`
  }

  private parseLeaderReply(output: Record<string, unknown> | null): TeamLeaderReply {
    const parsed = LeaderReply.safeParse(output)
    if (parsed.success) return parsed.data
    const text = this.textFromOutput(output)
    return {
      reply: text || '队长已完成本轮处理。',
      subtasks: [],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    }
  }

  private parseMemberReply(output: Record<string, unknown> | null): TeamMemberReply {
    const parsed = MemberReply.safeParse(output)
    if (parsed.success) return parsed.data
    return {
      reply: this.textFromOutput(output) || MEMBER_FALLBACK_REPLY,
      blocked: false,
      question: null,
    }
  }

  private textFromOutput(output: Record<string, unknown> | null): string {
    if (!output) return ''
    if (typeof output.text === 'string') return output.text.trim()
    if (typeof output.reply === 'string') return output.reply.trim()
    return ''
  }

  private tryExtractOutput(executionId: string): Record<string, unknown> | null {
    try {
      return this.deps.extractOutput(executionId)
    } catch (error) {
      this.deps.logger?.warn('team task output extraction failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private pickTarget(work: WorkRecord, team: TeamRecord, mentions: string[]): AgentProfile | null {
    for (const agentId of mentions) {
      const agent = this.deps.agents.get(agentId)
      if (!agent || agent.status !== 'active') continue
      if (this.deps.teams.getMember(team.id, agent.id)) return agent
    }
    const assignee = work.assigneeAgentId ? this.deps.agents.get(work.assigneeAgentId) : null
    if (assignee?.status === 'active' && this.deps.teams.getMember(team.id, assignee.id)) {
      return assignee
    }
    if (team.leaderAgentId) {
      const leader = this.deps.agents.get(team.leaderAgentId)
      if (leader?.status === 'active' && this.deps.teams.getMember(team.id, leader.id))
        return leader
    }
    return null
  }

  private assertLeader(team: TeamRecord, leader: AgentProfile): void {
    if (team.leaderAgentId !== leader.id) {
      throw new RpcMethodError('INVALID_PARAMS', `agent ${leader.id} is not the team leader`)
    }
    if (leader.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `team leader ${leader.id} is ${leader.status}`)
    }
    if (!this.deps.teams.getMember(team.id, leader.id)) {
      throw new RpcMethodError('INVALID_PARAMS', `team leader ${leader.id} is not a member`)
    }
    if (leader.accessMode !== 'analyze') {
      throw new RpcMethodError('INVALID_PARAMS', `team leader ${leader.id} must be analyze`)
    }
    const provider = leader.defaultProviderId
      ? this.deps.providers.list().find((item) => item.id === leader.defaultProviderId)
      : null
    if (!provider || provider.capabilities.toolControl !== 'native') {
      throw new RpcMethodError(
        'CAPABILITY_UNSUPPORTED',
        `team leader ${leader.id} needs a Provider with native toolControl`,
      )
    }
  }

  private requireAgent(agentId: string): AgentProfile {
    const agent = this.deps.agents.get(agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent ${agentId} not found`)
    return agent
  }

  private requireActiveTeam(teamId: string): TeamRecord {
    const team = this.deps.teams.get(teamId)
    if (!team || team.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `team ${teamId} is not active`)
    }
    return team
  }

  private requireOwnerTeam(work: WorkRecord): TeamRecord {
    if (!work.ownerTeamId) {
      throw new RpcMethodError('INVALID_PARAMS', `work ${work.id} has no owner team`)
    }
    return this.requireActiveTeam(work.ownerTeamId)
  }

  private requireTeamTask(workId: string): WorkRecord {
    const work = this.deps.workRepository.get(workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work ${workId} not found`)
    if (work.collaborationMode !== 'team') {
      throw new RpcMethodError('INVALID_PARAMS', `work ${workId} is not a team collaboration task`)
    }
    return work
  }

  private appendMessage(
    workId: string,
    authorType: TeamTaskMessageRecord['authorType'],
    authorId: string,
    content: string,
    kind: TeamMessageKind,
    metadata: Record<string, unknown>,
  ): TeamTaskMessageRecord {
    const record: TeamTaskMessageRecord = {
      id: newId('tmsg'),
      workId,
      authorType,
      authorId,
      content,
      kind,
      metadata,
      executionId: null,
      createdAt: this.now(),
    }
    this.deps.messages.insert(record)
    return record
  }

  private contextFor(workId: string): string {
    return this.deps.messages
      .listRecent(workId, 30)
      .map((message) => `${message.authorType}(${message.authorId}): ${message.content}`)
      .join('\n')
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (event.eventType === 'execution.output') {
      this.recordExecutionOutput(event)
      return
    }
    if (event.eventType === 'execution.exited') {
      const parsed = ExecutionExitedPayload.safeParse(event.payload)
      if (!parsed.success) return
      const status =
        parsed.data.reason === 'cancelled'
          ? 'cancelled'
          : parsed.data.exitCode === 0
            ? 'succeeded'
            : 'failed'
      void this.onExecutionTerminal(event.aggregateId, status)
      return
    }
    if (event.eventType !== 'execution.state') return
    const parsed = ExecutionStatePayload.safeParse(event.payload)
    if (!parsed.success) return
    const status = parsed.data.status
    if (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'crashed'
    ) {
      void this.onExecutionTerminal(event.aggregateId, status === 'crashed' ? 'failed' : status)
    }
  }

  private recordExecutionOutput(event: RuntimeEvent): void {
    const payload = ExecutionOutputPayload.safeParse(event.payload)
    if (!payload.success || payload.data.stream !== 'structured') return
    const run = this.deps.runs.getByExecutionId(payload.data.executionId)
    if (!run) return
    try {
      const value = JSON.parse(payload.data.content) as Record<string, unknown>
      this.recordStepsFromValue(run, value)
    } catch {
      // 非 JSON structured 输出不进入执行记录。
    }
  }

  private recordStepsFromValue(
    run: TeamTaskRunRecord,
    value: Record<string, unknown>,
    createdAt?: string,
  ): void {
    if (value.type === 'tool_use') {
      this.recordRunStep(
        run,
        typeof value.id === 'string' ? value.id : `${String(value.name)}-${this.now()}`,
        typeof value.name === 'string' ? value.name : '工具',
        value.input,
        createdAt,
      )
      return
    }
    if (value.type === 'assistant') {
      const message = value.message as
        | {
            content?: Array<{
              type?: string
              id?: string
              name?: string
              input?: unknown
            }>
          }
        | undefined
      for (const item of message?.content ?? []) {
        if (item.type !== 'tool_use' || !item.name) continue
        this.recordRunStep(
          run,
          item.id ?? `${item.name}-${this.now()}`,
          item.name,
          item.input,
          createdAt,
        )
      }
    }
  }

  private recordRunStep(
    run: TeamTaskRunRecord,
    stepKey: string,
    name: string,
    input: unknown,
    createdAt = this.now(),
  ): void {
    this.deps.steps.insert({
      id: newId('tstep'),
      workId: run.workId,
      runId: run.id,
      stepKey,
      name,
      summary: this.toolSummary(name, input),
      createdAt,
    })
  }

  private toolSummary(name: string, input: unknown): string {
    if (typeof input !== 'object' || input === null) return name
    const value = input as Record<string, unknown>
    if (name === 'Bash' && typeof value.command === 'string') {
      const description = typeof value.description === 'string' ? value.description : ''
      return description
        ? `${description} · ${value.command.slice(0, 160)}`
        : value.command.slice(0, 200)
    }
    if (typeof value.file_path === 'string') return value.file_path
    if (typeof value.path === 'string') return value.path
    if (typeof value.query === 'string') return value.query.slice(0, 140)
    return name
  }

  private audit(workId: string, action: string, details: Record<string, unknown>): void {
    this.deps.audit?.append({
      actorType: 'system',
      actorId: 'agentra',
      action,
      targetType: 'work',
      targetId: workId,
      details,
      now: this.now(),
    })
  }
}
