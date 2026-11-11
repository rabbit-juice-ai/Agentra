import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  type AgentProfile,
  type Execution,
  type ExecutionCancelParams,
  ExecutionExitedPayload,
  type ExecutionInterruptParams,
  type ExecutionLog,
  type ExecutionLogsParams,
  ExecutionOutputPayload,
  type ExecutionSendMessageParams,
  type ExecutionStartParams,
  type ExecutionState,
  ExecutionStatePayload,
  PROTOCOL_VERSION,
  RpcMethodError,
  type RuntimeEvent,
  type RuntimeProviderRecord,
  type ToolPermissions,
} from '@agentra/protocol'
import { executionScratchDir, newId } from '@agentra/shared'
import { z } from 'zod'
import type { RuntimeClient } from '../daemon/daemon-client'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { AssignmentRepository } from '../db/repositories/assignment-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import {
  type ExecutionRepository,
  isTerminalExecutionState,
} from '../db/repositories/execution-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { RecoveryAttemptRepository } from '../db/repositories/recovery-attempt-repository'
import type { SessionRepository } from '../db/repositories/session-repository'
import type { SkillRepository } from '../db/repositories/skill-repository'
import type { TeamRepository } from '../db/repositories/team-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import type { NodeRunStatus } from '../workflow/state-machine'
import type { CheckpointService } from './checkpoint-service'
import type { CoreEventHub } from './event-hub'
import type { ProviderRegistry } from './provider-registry'
import { redactOutput } from './redact-output'
import type { TaskMemoryService } from './task-memory-service'
import type { WorkdirLockService } from './workdir-lock-service'
import type { WorktreeService } from './worktree-service'

export type ExecutionServiceLogger = {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

/** Core 内部系统执行（队长/助手）用途；不允许从 RPC 传入。 */
export type SystemExecutionPurpose =
  | 'team_dispatch'
  | 'team_leader'
  | 'planner_chat'
  | 'assistant_chat'
  | 'assistant_plan'

export type SystemExecutionOptions = {
  purpose: SystemExecutionPurpose
  toolPermissions: ToolPermissions
  systemPromptOverride?: string
  /** 团队协作线程允许在 Work 暂停/完成后继续响应消息。 */
  allowInactiveWork?: boolean
}

export type ExecutionStartOptions = {
  allowInactiveWork?: boolean
  /** 仅 Core 内部恢复入口使用。 */
  recovery?: {
    attemptId: string
    checkpointId: string
    teamRunId?: string | null
    /** 在 Session/Execution 创建事务内执行；用于 completed Work 原子重开。 */
    reopenWork?: () => void
    /** 在 Session/Execution 创建事务内执行；用于 Team subtask 原子置 running。 */
    onStarted?: () => void
  }
}

/** Phase 1B-2B：T3 事务上下文。只允许使用调用方已开启的同一连接。 */
export type RecoveryTxContext = {
  db: Database
  inTransaction: true
}

export type PreparedRecoveryNode = {
  executionId: string
  sessionId: string
}

/**
 * 排队中的启动任务。只存内存：Core 重启后排队一律丢弃并标记（见 discardQueuedOnStartup），
 * 所以队列不会变成重启后没人处理的幽灵。
 */
type SpawnJob = {
  executionId: string
  agentId: string
  providerId: string
  executablePath: string | null
  capabilities: Execution['capabilities']
  prompt: string
  workingDirectory: string
  sessionId: string
  externalSessionId: string
  systemPrompt: string | undefined
  model: string | undefined
  allowedTools: string[]
  disallowedTools: string[]
  allowedRoots: string[] | undefined
  allowInactiveWork?: boolean
}

export type ExecutionServiceDeps = {
  db: Database
  runtime: RuntimeClient
  registry: ProviderRegistry
  works: WorkRepository
  worktrees: WorktreeService
  locks: WorkdirLockService
  agents: AgentRepository
  /** 可选：把 Agent 选中的技能指令追加到工作指令之后；缺省不注入。 */
  skills?: SkillRepository
  /** 可选：Work 关联团队且 Agent 是成员时，注入团队指引。 */
  teams?: TeamRepository
  /** 可选：执行启动前刷新 Work 的 Task Memory 验收标准快照。 */
  taskMemories?: Pick<TaskMemoryService, 'refreshForWork'>
  /** 可选：Phase 1B-1 Checkpoint 创建与高风险失败启动阻断。 */
  checkpoints?: Pick<CheckpointService, 'createForExecution' | 'assertCanStart'>
  /** 仅恢复执行：在新 Session/Execution 事务内关联 Recovery Attempt。 */
  recoveries?: Pick<RecoveryAttemptRepository, 'markRunning'>
  assignments: AssignmentRepository
  sessions: SessionRepository
  executions: ExecutionRepository
  logs: ExecutionLogRepository
  /** 可选：把 runId / branchRunId / nodeRunId 带进执行日志与诊断字段。 */
  nodeRuns?: NodeRunRepository
  hub: CoreEventHub
  scratchRoot: string
  logger?: ExecutionServiceLogger
  /** S55-2B：维护模式门禁；缺省视为 normal（测试/旧装配兼容）。 */
  maintenance?: {
    isExecutionStartAllowed(): boolean
    /** S55-2C：entering_maintenance 期间终态事件仍可取得内部 event-handler lease。 */
    isEventIngressAllowed?(): boolean
  }
  /** S55-2B：in-flight start/spawn/event 计数；缺省不跟踪。 */
  drain?: DrainCoordinator
  /** S55-2B-1B：终态审计（A2 来源区分）；缺省跳过审计写入。 */
  audit?: AuditRepository
  /**
   * S55-2B-1B：终态补偿桥接（**直调** WorkflowExecutionBridge.onExecutionFinished）。
   * 补偿链要求同步、无 kick；不得接 engine 包装。
   */
  onTerminalBridge?: (execution: Execution) => void
  /** 执行进入终态后的运行时调度触发（engine 包装：桥接 no-op + kick）。 */
  onExecutionFinished?: (execution: Execution) => void
  /** S55-2B-1B：S4 验证需要校验 NodeRun 所属 WorkflowRun 存在。 */
  workflowRuns?: { get(id: string): unknown | null }
  now?: () => string
}

/** 无人值守执行的默认权限模式：不弹权限请求（阶段 1 无审批 UI），最小权限。 */
const DEFAULT_PERMISSION_MODE = 'dontAsk'
const MAX_SEEN_EVENT_IDS = 10_000
const WorkEffectState = z
  .object({
    cancellationPending: z.boolean().optional(),
    workPause: z
      .object({
        workId: z.string(),
        interrupted: z.boolean(),
        requestedAt: z.string(),
        resumed: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough()

/** 只有进行中的 Work 可以启动执行。 */
const WORK_ACCEPTS_EXECUTIONS = new Set(['active'])

/** S55-2B-1B：终态观察来源（审计 details.source 区分事件/对账/Core 主动）。 */
export type TerminalObservationSource =
  | 'event_observed'
  | 'reconciliation_observed'
  | 'core_initiated'

/** S55-2B-1B：reconcile 分类结果（boot / 运行期重连共用同一保守分类器）。 */
export type ReconciliationReport = {
  confirmedActive: string[]
  observedTerminal: Array<{ executionId: string; daemonStatus: ExecutionState }>
  unconfirmed: string[]
  conflicts: Array<{
    kind: 'daemon_active_db_terminal' | 'daemon_unknown_execution'
    executionId: string
  }>
}

/**
 * S55-2B-1B（报告五 §2.2）：S4 允许集合——桥接已完成或本就不适用的节点状态。
 * running 表示桥接未收尾；blocked/ready/未知状态视为矛盾；均 fail closed。
 * reconciliation_required 表示「终态补偿已完成、节点待人工对账」，不代表业务成功。
 */
const TERMINAL_COMPENSATION_NODE_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'waiting_approval',
  'paused',
  'changes_requested',
  'rejected',
  'reconciliation_required',
])

/**
 * 执行编排：Core 是 Execution 状态的唯一权威写入者。
 * 顺序遵循 ARCHITECTURE §8：先落库启动意图 → 请求 Daemon 启动 → 持久化结果 → 消费事件。
 */
export class ExecutionService {
  private readonly spawnInFlight = new Map<string, Promise<Execution>>()
  private readonly cancelInFlight = new Map<string, Promise<Execution>>()

  private readWorkEffects(id: string) {
    const state = this.executions.getRecoveryStateRaw(id)
    if (!state.valid) throw new Error(`Invalid recovery state for execution ${id}`)
    return WorkEffectState.parse(state.raw === null ? {} : JSON.parse(state.raw))
  }

  isWorkPauseInterrupted(id: string): boolean {
    const state = this.readWorkEffects(id)
    return state.workPause?.interrupted === true && state.cancellationPending === undefined
  }

  /** Work 状态已提交后调用。仅处理本 Work；中断标志先持久化，不把中断当正常成功。 */
  async pauseWork(workId: string): Promise<void> {
    if (this.works.get(workId)?.status !== 'paused') return
    for (const execution of this.executions.listByWork(workId)) {
      if (isTerminalExecutionState(execution.status)) continue
      const state = this.readWorkEffects(execution.id)
      if (state.workPause && !state.workPause.resumed) continue
      if (state.queued === true || execution.capabilities.interrupt === 'unsupported') {
        this.executions.mergeRecoveryState(
          execution.id,
          { workPause: { workId, interrupted: false, requestedAt: this.now(), resumed: false } },
          this.now(),
        )
        this.appendSystemLog(
          execution.id,
          'execution.work_pause.awaiting_completion',
          { workId },
          this.now(),
        )
        continue
      }
      this.executions.mergeRecoveryState(
        execution.id,
        { workPause: { workId, interrupted: true, requestedAt: this.now(), resumed: false } },
        this.now(),
      )
      await this.spawnInFlight.get(execution.id)?.catch(() => undefined)
      try {
        await this.interrupt({ executionId: execution.id })
      } catch (error) {
        this.executions.mergeRecoveryState(
          execution.id,
          { workPause: { interrupted: false } },
          this.now(),
        )
        this.logger?.warn('Work pause interrupt failed; waiting for current step', {
          workId,
          executionId: execution.id,
          error: String(error),
        })
      }
    }
  }

  /** 用户明确恢复后，仅为被 Work 中断的非完成节点创建新 attempt；旧 Execution/Artifact 保留。 */
  async resumeWork(workId: string): Promise<void> {
    if (this.works.get(workId)?.status !== 'active') return
    for (const execution of this.executions.listByWork(workId)) {
      const pause = this.readWorkEffects(execution.id).workPause
      if (!pause || pause.resumed) continue
      if (!pause.interrupted) {
        this.executions.mergeRecoveryState(
          execution.id,
          { workPause: { resumed: true } },
          this.now(),
        )
        continue
      }
      if (!isTerminalExecutionState(execution.status))
        throw new RpcMethodError(
          'NOT_READY',
          'Work interruption is still settling; retry resume shortly',
        )
      const nodeId = this.executions.getNodeRunId(execution.id)
      const node = nodeId ? this.nodeRuns?.get(nodeId) : null
      if (node?.status !== 'reconciliation_required') continue
      if (
        this.workflowRuns &&
        z.object({ status: z.string() }).parse(this.workflowRuns.get(node.workflowRunId)).status !==
          'running'
      )
        continue
      const attempts =
        this.nodeRuns?.listByRunAndKey(node.workflowRunId, node.workflowNodeKey) ?? []
      transaction(this.db, () => {
        if (!attempts.some((n) => n.attempt > node.attempt))
          this.nodeRuns?.create(
            {
              id: newId('nrn'),
              workflowRunId: node.workflowRunId,
              workflowNodeKey: node.workflowNodeKey,
              branchRunId: node.branchRunId,
              attempt: node.attempt + 1,
              inputSnapshot: node.inputSnapshot,
            },
            this.now(),
          )
        this.executions.mergeRecoveryState(
          execution.id,
          { workPause: { resumed: true } },
          this.now(),
        )
      })
    }
    for (const execution of this.executions.listByWork(workId)) {
      if (execution.agentId) await this.drainQueue(execution.agentId)
    }
  }

  async terminateWork(workId: string): Promise<void> {
    if (this.works.get(workId)?.status !== 'cancelled') return
    for (const execution of this.executions.listByWork(workId)) {
      if (
        !isTerminalExecutionState(execution.status) ||
        this.readWorkEffects(execution.id).cancellationPending
      ) {
        await this.cancel({ executionId: execution.id }, true)
      }
    }
  }

  /** 普通启动对账前收敛未完成的 Work 进程处置；不启动新任务。 */
  async recoverWorkEffects(): Promise<void> {
    for (const work of this.works.list(false)) {
      if (work.status === 'cancelled') await this.terminateWork(work.id)
      if (work.status === 'paused') await this.pauseWork(work.id)
    }
  }

  private readonly seenEventIds = new Set<string>()
  /** executionId → 待启动任务；与 executions 表里的 queued 标记一一对应。 */
  private readonly queued = new Map<string, SpawnJob>()
  /** Phase 1B-2B：T3 已创建、等待 COMMIT 后 spawn 的恢复任务。 */
  private readonly preparedRecovery = new Map<string, SpawnJob>()
  /**
   * S55-2B-1B：正在 startInternal 途中（行已建、spawn 未返回）的执行。
   * 只用于运行期对账避免误分类在途启动；进程崩溃后自然消失（下次 boot 按
   * 「pending 且无 Daemon 证据」正确归入 A6）。
   */
  private readonly starting = new Set<string>()
  private readonly draining = new Set<string>()
  private readonly seenEventOrder: string[] = []
  private readonly db: Database
  private readonly runtime: RuntimeClient
  private readonly registry: ProviderRegistry
  private readonly agents: AgentRepository
  private readonly skills: SkillRepository | undefined
  private readonly teams: TeamRepository | undefined
  private readonly taskMemories: Pick<TaskMemoryService, 'refreshForWork'> | undefined
  private readonly checkpoints:
    | Pick<CheckpointService, 'createForExecution' | 'assertCanStart'>
    | undefined
  private readonly recoveries: Pick<RecoveryAttemptRepository, 'markRunning'> | undefined
  private readonly assignments: AssignmentRepository
  private readonly sessions: SessionRepository
  private readonly executions: ExecutionRepository
  private readonly logs: ExecutionLogRepository
  private readonly hub: CoreEventHub
  private readonly works: WorkRepository
  private readonly worktrees: WorktreeService
  private readonly locks: WorkdirLockService
  private readonly scratchRoot: string
  private readonly logger: ExecutionServiceLogger | undefined
  private readonly onExecutionFinished: ((execution: Execution) => void) | undefined
  private readonly onTerminalBridge: ((execution: Execution) => void) | undefined
  private readonly audit: AuditRepository | undefined
  private readonly nodeRuns: NodeRunRepository | undefined
  private readonly workflowRuns: { get(id: string): unknown | null } | undefined
  private readonly maintenance:
    | { isExecutionStartAllowed(): boolean; isEventIngressAllowed?(): boolean }
    | undefined
  private readonly drain: DrainCoordinator | undefined
  private readonly now: () => string

  constructor(deps: ExecutionServiceDeps) {
    this.db = deps.db
    this.runtime = deps.runtime
    this.registry = deps.registry
    this.agents = deps.agents
    this.skills = deps.skills
    this.teams = deps.teams
    this.taskMemories = deps.taskMemories
    this.checkpoints = deps.checkpoints
    this.recoveries = deps.recoveries
    this.assignments = deps.assignments
    this.sessions = deps.sessions
    this.executions = deps.executions
    this.logs = deps.logs
    this.hub = deps.hub
    this.works = deps.works
    this.worktrees = deps.worktrees
    this.locks = deps.locks
    this.scratchRoot = deps.scratchRoot
    this.logger = deps.logger
    this.onExecutionFinished = deps.onExecutionFinished
    this.onTerminalBridge = deps.onTerminalBridge
    this.audit = deps.audit
    this.nodeRuns = deps.nodeRuns
    this.workflowRuns = deps.workflowRuns
    this.maintenance = deps.maintenance
    this.drain = deps.drain
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async start(
    params: ExecutionStartParams,
    options: ExecutionStartOptions = {},
  ): Promise<Execution> {
    return this.withStartLease('execution.start', () =>
      this.startInternal(params, null, undefined, options),
    )
  }

  /**
   * Core 内部系统执行入口：只允许 TeamDispatchService / 后续 AssistantService 调用。
   * 不暴露 RPC；工具策略由调用方显式覆盖，仍受 Provider 能力与执行前门禁约束。
   */
  async startSystem(
    params: ExecutionStartParams,
    options: SystemExecutionOptions,
  ): Promise<Execution> {
    return this.withStartLease('execution.startSystem', () =>
      this.startInternal(params, null, options, {
        allowInactiveWork: options.allowInactiveWork,
      }),
    )
  }

  /**
   * 仅用于恢复启动对账：判断 pending Execution 是否已有 Daemon 启动证据。
   * 不修改任何状态；无法确认时返回 unconfirmed。
   */
  async classifyPendingStart(
    executionId: string,
  ): Promise<'spawned' | 'not_started' | 'unconfirmed'> {
    const execution = this.executions.get(executionId)
    if (!execution) return 'unconfirmed'
    if (execution.status !== 'pending') return 'spawned'
    if (execution.processId !== null || execution.startedAt !== null) return 'spawned'
    try {
      const active = await this.runtime.listActive()
      if (active.includes(executionId)) return 'spawned'
      try {
        await this.runtime.status(executionId)
        return 'spawned'
      } catch (error) {
        if (error instanceof RpcMethodError && error.code === 'EXECUTION_NOT_FOUND') {
          return 'not_started'
        }
        return 'unconfirmed'
      }
    } catch {
      return 'unconfirmed'
    }
  }

  /**
   * 仅用于恢复启动对账：确认从未启动的 pending Execution 收敛为 failed。
   * 有任何 process/startedAt 证据时拒绝，防止误杀已启动执行。
   */
  failUnstartedExecution(executionId: string, reason: string): boolean {
    const execution = this.executions.get(executionId)
    if (!execution || execution.status !== 'pending') return false
    if (execution.processId !== null || execution.startedAt !== null) return false
    this.recordTerminalObservation({
      executionId,
      status: 'failed',
      endedAt: this.now(),
      source: 'core_initiated',
      extraState: { reason },
      logEvent: 'execution.start_interrupted',
      logData: { reason },
      auditAction: 'execution.terminal.observed',
    })
    return true
  }

  /**
   * Core 内部恢复入口：创建新 Session/Execution，并在同一事务内关联 Recovery Attempt。
   * 不暴露为 RPC；work.recovery.start 只通过 RecoveryService 调用。
   */
  async startRecovery(
    params: ExecutionStartParams,
    options: {
      recovery: { attemptId: string; checkpointId: string; teamRunId?: string | null }
      allowInactiveWork?: boolean
      system?: SystemExecutionOptions
    },
  ): Promise<Execution> {
    return this.withStartLease('execution.startRecovery', () =>
      this.startInternal(params, null, options.system, {
        allowInactiveWork: options.allowInactiveWork,
        recovery: options.recovery,
      }),
    )
  }

  /**
   * 工作流节点专用入口：把 Execution 绑定到 NodeRun（executions.node_run_id）。
   * 不暴露为 RPC —— 只有 Core 内部的 WorkflowExecutionBridge 调用。
   */
  async startForNode(nodeRunId: string, params: ExecutionStartParams): Promise<Execution> {
    return this.withStartLease('execution.startForNode', () =>
      this.startInternal(params, nodeRunId),
    )
  }

  /**
   * Phase 1B-2B：在调用方 T3 事务内创建 Session/Execution（不 spawn、不加锁、不做文件系统操作）。
   * 调用方必须传入同一个已 BEGIN IMMEDIATE 的连接；本方法不会自行开启事务。
   */
  prepareRecoveryForNode(
    tx: RecoveryTxContext,
    nodeRunId: string,
    params: ExecutionStartParams & { worktreeId: string },
    options: { recoveryAttemptId: string; checkpointId: string },
  ): PreparedRecoveryNode {
    if (tx.inTransaction !== true || tx.db !== this.db) {
      throw new RpcMethodError('INVALID_PARAMS', 'recovery node start requires the T3 transaction')
    }
    this.assertStartAllowed()
    const work = params.workId ? this.works.get(params.workId) : null
    if (!params.workId || !work) {
      throw new RpcMethodError('INVALID_PARAMS', 'recovery node start requires a work')
    }
    if (work.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', 'Work is not active; refusing recovery start')
    }
    const prompt = params.prompt.trim()
    if (prompt.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'prompt must not be blank')
    }
    const agent = this.agents.get(params.agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${params.agentId}`)
    if (agent.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `agent ${agent.id} is ${agent.status}, not active`)
    }
    if (agent.toolPermissions.allow.length === 0) {
      throw new RpcMethodError(
        'AGENT_TOOLS_NOT_CONFIGURED',
        `Agent「${agent.name}」未配置任何允许工具（allow 为空）。`,
      )
    }
    const provider = this.resolveProvider(agent)
    this.assertProviderUsable(provider)
    const assignment = this.resolveActiveAssignment(work.id, agent.id)
    const activeCount = this.executions.countActiveByAgent(agent.id)
    if (activeCount >= agent.maxConcurrency) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `CAPACITY_EXCEEDED: agent ${agent.id} is at max concurrency`,
        { code: 'CAPACITY_EXCEEDED' },
      )
    }

    const executionId = `exe-${crypto.randomUUID()}`
    const sessionId = newId('ses')
    const externalSessionId = crypto.randomUUID()
    const { workingDirectory, allowedRoots } = this.resolveWorkingDirectory(
      { ...params, workId: work.id },
      executionId,
      false,
    )
    const now = this.now()
    const execution: Execution = {
      id: executionId,
      sessionId,
      providerId: provider.id,
      agentId: agent.id,
      externalExecutionId: externalSessionId,
      processId: null,
      status: 'pending',
      workingDirectory,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      capabilities: provider.capabilities,
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.create({
      id: sessionId,
      assignmentId: null,
      providerId: provider.id,
      externalSessionId,
      contextRef: agent.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    })
    this.executions.create(execution, nodeRunId)
    this.executions.mergeRecoveryState(
      executionId,
      {
        recovery: {
          attemptId: options.recoveryAttemptId,
          checkpointId: options.checkpointId,
          worktreeId: params.worktreeId,
        },
      },
      now,
    )
    if (assignment) this.sessions.bindAssignment(sessionId, assignment.id, now)
    this.appendSystemLog(
      executionId,
      'execution.created',
      { agentId: agent.id, providerId: provider.id },
      now,
    )
    this.appendSystemLog(
      executionId,
      'execution.tool_policy',
      { allow: agent.toolPermissions.allow, deny: agent.toolPermissions.deny },
      now,
    )

    const job: SpawnJob = {
      executionId,
      agentId: agent.id,
      providerId: provider.id,
      executablePath: provider.executablePath,
      capabilities: provider.capabilities,
      prompt,
      workingDirectory,
      sessionId,
      externalSessionId,
      systemPrompt: this.composeSystemPrompt(agent, work.id),
      model: agent.model ?? undefined,
      allowedTools: agent.toolPermissions.allow,
      disallowedTools: agent.toolPermissions.deny,
      allowedRoots: [this.worktrees.worktreeRoot, ...allowedRoots],
    }
    this.preparedRecovery.set(executionId, job)
    return { executionId, sessionId }
  }

  /** T3 回滚时清理内存中的预启动任务；数据库行已随事务回滚。 */
  discardPreparedRecovery(executionId: string): void {
    this.preparedRecovery.delete(executionId)
  }

  /** Phase 1B-2B：T3 COMMIT 后 spawn；获取 Workdir 锁并把 holder 转移到 CLI PID。 */
  async spawnPreparedRecovery(executionId: string): Promise<Execution> {
    const job = this.preparedRecovery.get(executionId)
    if (!job) {
      throw new RpcMethodError('NOT_READY', `prepared recovery ${executionId} is missing`)
    }
    const owner = this.executions.findOwningWork(executionId)
    const workId = owner?.workId ?? null
    try {
      this.locks.acquire(job.workingDirectory, executionId, workId, { kind: 'core' })
    } catch (error) {
      this.preparedRecovery.delete(executionId)
      this.failUnstartedExecution(executionId, 'WORKDIR_LOCKED')
      throw error
    }
    let execution: Execution
    try {
      execution = await this.spawn(job)
    } catch (error) {
      const current = this.get(executionId)
      if (
        !current ||
        current.status === 'failed' ||
        (current.status === 'pending' && current.processId === null)
      ) {
        this.locks.releaseByExecution(executionId)
      }
      this.preparedRecovery.delete(executionId)
      throw error
    }
    this.preparedRecovery.delete(executionId)
    if (execution.processId !== null) {
      const updated = this.locks.updateHolderPid(
        job.workingDirectory,
        executionId,
        execution.processId,
      )
      if (!updated) {
        await this.cancel({ executionId }, true).catch(() => undefined)
        const current = this.get(executionId)
        if (
          current &&
          (current.status === 'failed' ||
            current.status === 'cancelled' ||
            current.status === 'crashed')
        ) {
          this.locks.releaseByExecution(executionId)
          throw new RpcMethodError('INVALID_PARAMS', 'recovery workdir lock holder transfer failed')
        }
        throw new RpcMethodError(
          'NOT_READY',
          'recovery process may still be running; lock retained',
        )
      }
    }
    return this.get(executionId) ?? execution
  }

  private async withStartLease<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const lease = this.drain?.acquire('execution-start', operation)
    try {
      return await action()
    } finally {
      lease?.release()
    }
  }

  /**
   * 工作指令 = Agent 自身提示词 + 所选技能 + 关联团队指引。
   * 团队指引只在「Work 关联该团队」且「Agent 是该团队成员」时注入；
   * 它提供共享上下文，不是权限，也不影响选人。
   */
  private composeSystemPrompt(agent: AgentProfile, workId: string | null): string | undefined {
    const base = agent.systemPrompt.trim()
    const skills = this.skills?.listByIds(agent.skillIds) ?? []
    const skillBlocks = skills
      .map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`)
      .filter((block) => block.length > 0)
    const teamBlocks: string[] = []
    if (workId && this.teams) {
      for (const teamId of this.works.listTeamIds(workId)) {
        const team = this.teams.get(teamId)
        if (team?.status !== 'active') continue
        if (!this.teams.getMember(teamId, agent.id)) continue
        const instructions = team.instructions.trim()
        if (instructions.length > 0) {
          teamBlocks.push(`# 团队指引 · ${team.name}\n\n${instructions}`)
        }
      }
    }
    const sections = [
      base,
      skillBlocks.length > 0 ? `# 技能\n\n${skillBlocks.join('\n\n')}` : '',
      ...teamBlocks,
    ].filter((section) => section.length > 0)
    return sections.length > 0 ? sections.join('\n\n') : undefined
  }

  private assertStartAllowed(): void {
    if (!this.maintenance || this.maintenance.isExecutionStartAllowed()) return
    throw new RpcMethodError(
      'MAINTENANCE_ACTIVE',
      'cannot start a new execution while core is in maintenance',
    )
  }

  private async startInternal(
    params: ExecutionStartParams,
    nodeRunId: string | null,
    system?: SystemExecutionOptions,
    options: ExecutionStartOptions = {},
  ): Promise<Execution> {
    this.assertStartAllowed()
    if (
      !options.allowInactiveWork &&
      params.workId &&
      this.works.get(params.workId)?.status !== 'active'
    ) {
      throw new RpcMethodError('INVALID_PARAMS', 'Work is not active; refusing execution start')
    }
    if (params.workId) this.checkpoints?.assertCanStart(params.workId)
    const prompt = params.prompt.trim()
    if (prompt.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'prompt must not be blank')
    }
    const agent = this.agents.get(params.agentId)
    if (!agent) throw new RpcMethodError('AGENT_NOT_FOUND', `agent not found: ${params.agentId}`)
    if (agent.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `agent ${agent.id} is ${agent.status}, not active`)
    }

    // U3：allow 为空 = 未配置 = 拒绝执行。强制点在 Core，且必须在创建 Execution 之前拦截。
    // 系统执行（队长/助手）由 Core 内部显式提供策略，允许空 allow；普通入口不豁免。
    const toolPermissions = system?.toolPermissions ?? agent.toolPermissions
    if (!system && toolPermissions.allow.length === 0) {
      throw new RpcMethodError(
        'AGENT_TOOLS_NOT_CONFIGURED',
        `Agent「${agent.name}」未配置任何允许工具（allow 为空）。请先在 Agent 配置中填写允许使用的工具再启动执行。`,
      )
    }

    const provider = this.resolveProvider(agent)
    // 验收 6：CLI 不可用/未认证必须在创建 Execution 之前拦截。
    this.assertProviderUsable(provider)

    // D-1：绑定 Work 时必须先解析该 (workId, agentId) 的 active assignment。
    // 系统执行不绑定 Work，不创建业务 Assignment。
    // 拦截点必须在「获取目录锁 / 创建 Session / 创建 Execution」三者之前，命中即零副作用。
    const assignment = system ? null : this.resolveActiveAssignment(params.workId, agent.id)

    const executionId = `exe-${crypto.randomUUID()}`
    const sessionId = newId('ses')
    const externalSessionId = crypto.randomUUID()
    const { workingDirectory, workId, allowedRoots } = this.resolveWorkingDirectory(
      params,
      executionId,
      options.allowInactiveWork ?? false,
    )

    if (workId) {
      const work = this.works.get(workId)
      if (work) this.taskMemories?.refreshForWork(work, 'execution_start')
    }

    // 工作目录锁：键是实际目录的绝对路径。命中时不创建 Execution（与 AGENT_TOOLS_NOT_CONFIGURED 同级）。
    this.locks.acquire(workingDirectory, executionId, workId)
    try {
      fs.mkdirSync(workingDirectory, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.locks.releaseByExecution(executionId)
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `cannot create working directory ${workingDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // 并发槽位必须在创建本次执行记录**之前**统计，否则会把自己算进去、全部误判为排队。
    const activeCount = this.executions.countActiveByAgent(agent.id)
    const shouldQueue = activeCount >= agent.maxConcurrency

    const now = this.now()
    const execution: Execution = {
      id: executionId,
      sessionId,
      providerId: provider.id,
      agentId: agent.id,
      externalExecutionId: externalSessionId,
      processId: null,
      status: 'pending',
      workingDirectory,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      capabilities: provider.capabilities,
      createdAt: now,
      updatedAt: now,
    }

    this.starting.add(executionId)
    try {
      transaction(this.db, () => {
        this.sessions.create({
          id: sessionId,
          assignmentId: null,
          providerId: provider.id,
          externalSessionId,
          contextRef: agent.id,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          lastActiveAt: now,
        })
        this.executions.create(execution, nodeRunId)
        if (options.recovery) {
          if (!this.recoveries) {
            throw new RpcMethodError('NOT_READY', 'recovery attempt repository is not configured')
          }
          this.executions.mergeRecoveryState(
            executionId,
            {
              recovery: {
                attemptId: options.recovery.attemptId,
                checkpointId: options.recovery.checkpointId,
              },
            },
            now,
          )
          if (
            !this.recoveries.markRunning(
              options.recovery.attemptId,
              {
                executionId,
                sessionId,
                teamRunId: options.recovery.teamRunId ?? null,
              },
              now,
            )
          ) {
            throw new RpcMethodError(
              'INVALID_PARAMS',
              `RECOVERY_ACTIVE_EXISTS: recovery attempt ${options.recovery.attemptId} is not starting`,
              { code: 'RECOVERY_ACTIVE_EXISTS' },
            )
          }
          options.recovery.reopenWork?.()
          options.recovery.onStarted?.()
        }
        // D-1：同一事务内把 Session 绑到 Assignment（阶段 1 scratch 模式没有 assignment，保持 NULL）。
        if (assignment) this.sessions.bindAssignment(sessionId, assignment.id, now)
        this.appendSystemLog(
          executionId,
          'execution.created',
          { agentId: agent.id, providerId: provider.id },
          now,
        )
        // 审计：本次实际生效的工具策略（不新增表或列，落在 execution_logs 的 system 流）。
        this.appendSystemLog(
          executionId,
          'execution.tool_policy',
          {
            allow: toolPermissions.allow,
            deny: toolPermissions.deny,
            ...(system ? { purpose: system.purpose, system: true } : {}),
          },
          now,
        )
      })
    } catch (error) {
      this.starting.delete(executionId)
      throw error
    }
    this.logger?.info('execution created', {
      executionId,
      agentId: agent.id,
      providerId: provider.id,
      workingDirectory,
    })

    const job: SpawnJob = {
      executionId,
      agentId: agent.id,
      providerId: provider.id,
      executablePath: provider.executablePath,
      capabilities: provider.capabilities,
      prompt,
      workingDirectory,
      sessionId,
      externalSessionId,
      systemPrompt: system?.systemPromptOverride ?? this.composeSystemPrompt(agent, workId),
      model: agent.model ?? undefined,
      allowedTools: toolPermissions.allow,
      disallowedTools: toolPermissions.deny,
      // 阶段 2：绑定 Work 时把允许的目录根一并声明给 Daemon（Daemon 仍做边界校验）。
      allowedRoots: workId ? [this.scratchRoot, ...allowedRoots] : undefined,
      allowInactiveWork: options.allowInactiveWork,
    }

    // 并发上限：达到 maxConcurrency 时进入排队，**不启动进程**，返回 pending 的执行记录。
    if (shouldQueue) {
      this.queued.set(executionId, job)
      transaction(this.db, () => {
        this.executions.setRecoveryState(executionId, { queued: true, queuedAt: now }, now)
        this.appendSystemLog(
          executionId,
          'execution.queued',
          { activeCount, maxConcurrency: agent.maxConcurrency },
          now,
        )
      })
      this.starting.delete(executionId)
      this.logger?.info('execution queued', {
        executionId,
        agentId: agent.id,
        activeCount,
        ...this.workflowContext(executionId),
      })
      return this.get(executionId)
    }

    return this.spawn(job)
  }

  /**
   * 真正启动进程。排队任务被调度时复用同一条路径。
   */
  private spawn(job: SpawnJob): Promise<Execution> {
    const promise = this.spawnInternal(job)
    this.spawnInFlight.set(job.executionId, promise)
    void promise.finally(() => this.spawnInFlight.delete(job.executionId)).catch(() => undefined)
    return promise
  }

  private async spawnInternal(job: SpawnJob): Promise<Execution> {
    const { executionId } = job
    const lease = this.drain?.acquire('execution-start', `execution.spawn:${executionId}`)
    try {
      try {
        this.assertStartAllowed()
        const owner = this.executions.findOwningWork(executionId)
        if (!job.allowInactiveWork && owner && this.works.get(owner.workId)?.status !== 'active')
          throw new RpcMethodError('INVALID_PARAMS', 'Work is not active; refusing process start')
        const handle = await this.runtime.start({
          executionId,
          providerId: job.providerId,
          executablePath: job.executablePath,
          capabilities: job.capabilities,
          prompt: job.prompt,
          workingDirectory: job.workingDirectory,
          sessionId: job.externalSessionId,
          systemPrompt: job.systemPrompt,
          model: job.model,
          permissionMode: DEFAULT_PERMISSION_MODE,
          allowedTools: job.allowedTools,
          disallowedTools: job.disallowedTools,
          allowedRoots: job.allowedRoots,
        })
        // Daemon start 的 await 期间 Work 可能被终止；句柄返回后立即取消实际进程。
        const afterOwner = this.executions.findOwningWork(executionId)
        if (afterOwner && this.works.get(afterOwner.workId)?.status === 'cancelled') {
          await this.runtime.cancel(executionId)
          await this.confirmRuntimeTerminal(executionId)
          this.executions.mergeRecoveryState(
            executionId,
            { cancellationPending: false },
            this.now(),
          )
          return this.get(executionId)
        }
        this.executions.markRunning(executionId, {
          processId: handle.processId,
          startedAt: handle.startedAt,
          updatedAt: handle.startedAt,
        })
        this.appendSystemLog(
          executionId,
          'execution.process_started',
          { processId: handle.processId, ...this.workflowContext(executionId) },
          handle.startedAt,
        )
        return this.get(executionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const maintenanceAbort =
          error instanceof RpcMethodError && error.code === 'MAINTENANCE_ACTIVE'
        const failedAt = this.now()
        this.recordTerminalObservation({
          executionId,
          status: 'failed',
          endedAt: failedAt,
          source: 'core_initiated',
          extraState: {
            reason: maintenanceAbort ? 'maintenance_start_aborted' : 'start_failed',
            message,
          },
          logEvent: 'execution.start_failed',
          logData: { message },
          auditAction: 'execution.terminal.observed',
        })
        this.publishState(executionId, 'failed', 'pending', message)
        this.logger?.error('execution start failed', {
          executionId,
          error: message,
          ...this.workflowContext(executionId),
        })
        throw error
      }
    } finally {
      this.starting.delete(executionId)
      lease?.release()
    }
  }

  async sendMessage(params: ExecutionSendMessageParams): Promise<{ sent: true }> {
    const execution = this.get(params.executionId)
    if (execution.capabilities.streaming === 'unsupported') {
      throw new RpcMethodError(
        'CAPABILITY_UNSUPPORTED',
        `provider ${execution.providerId} declares streaming=unsupported`,
      )
    }
    if (isTerminalExecutionState(execution.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `execution ${execution.id} is ${execution.status}; cannot send a message`,
      )
    }
    await this.runtime.sendMessage(execution.id, params.message)
    this.appendSystemLog(execution.id, 'execution.message_sent', {}, this.now())
    return { sent: true }
  }

  async interrupt(params: ExecutionInterruptParams): Promise<{ interrupted: boolean }> {
    const execution = this.get(params.executionId)
    // 验收 5：unsupported 能力必须返回固定错误码，且不改变 Execution 状态。
    if (execution.capabilities.interrupt === 'unsupported') {
      throw new RpcMethodError(
        'CAPABILITY_UNSUPPORTED',
        `provider ${execution.providerId} declares interrupt=unsupported; use cancel instead`,
      )
    }
    if (isTerminalExecutionState(execution.status)) return { interrupted: false }
    const result = await this.runtime.interrupt(execution.id)
    this.appendSystemLog(
      execution.id,
      'execution.interrupt_requested',
      { interrupted: result.interrupted },
      this.now(),
    )
    return result
  }

  async cancel(
    params: ExecutionCancelParams,
    requireRuntimeConfirmation = false,
  ): Promise<Execution> {
    let promise = this.cancelInFlight.get(params.executionId)
    if (!promise) {
      promise = this.cancelInternal(params, requireRuntimeConfirmation)
      this.cancelInFlight.set(params.executionId, promise)
      void promise
        .finally(() => this.cancelInFlight.delete(params.executionId))
        .catch(() => undefined)
    }
    const result = await promise
    if (requireRuntimeConfirmation && this.readWorkEffects(result.id).cancellationPending) {
      throw new RpcMethodError(
        'NOT_READY',
        'Work is stopped, but process cancellation is unconfirmed; retry termination',
      )
    }
    return result
  }

  private async cancelInternal(
    params: ExecutionCancelParams,
    requireRuntimeConfirmation: boolean,
  ): Promise<Execution> {
    const execution = this.get(params.executionId)
    const wasQueued =
      this.queued.has(execution.id) || this.readWorkEffects(execution.id).queued === true
    this.queued.delete(params.executionId)
    if (
      isTerminalExecutionState(execution.status) &&
      !this.readWorkEffects(execution.id).cancellationPending
    )
      return execution
    const runtimeNeeded = !wasQueued
    this.executions.mergeRecoveryState(
      execution.id,
      { cancellationPending: runtimeNeeded },
      this.now(),
    )
    if (isTerminalExecutionState(execution.status)) {
      await this.requestRuntimeCancel(execution.id, requireRuntimeConfirmation)
      return this.get(execution.id)
    }

    const now = this.now()
    const previous = execution.status
    this.recordTerminalObservation({
      executionId: execution.id,
      status: 'cancelled',
      endedAt: now,
      source: 'core_initiated',
      extraState: { reason: 'user_cancelled' },
      logEvent: 'execution.cancel_requested',
      logData: this.workflowContext(execution.id),
      auditAction: 'execution.terminal.observed',
    })
    this.publishState(execution.id, 'cancelled', previous, 'cancelled by user')
    void this.drainQueue(execution.agentId)
    // S4-5 O-2：取消也是终态迁移，必须通知工作流桥接，否则 NodeRun 会停在 running。
    this.notifyExecutionFinished(execution.id)

    if (runtimeNeeded) await this.requestRuntimeCancel(execution.id, requireRuntimeConfirmation)
    return this.get(execution.id)
  }

  private async requestRuntimeCancel(executionId: string, confirmTerminal: boolean): Promise<void> {
    await this.spawnInFlight.get(executionId)?.catch(() => undefined)
    if (!this.readWorkEffects(executionId).cancellationPending) return
    try {
      await this.runtime.cancel(executionId)
      if (confirmTerminal) await this.confirmRuntimeTerminal(executionId)
      this.executions.mergeRecoveryState(executionId, { cancellationPending: false }, this.now())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn('daemon cancel failed', { executionId, error: message })
      this.executions.mergeRecoveryState(
        executionId,
        { cancellationPending: true, reason: 'cancel_failed', message },
        this.now(),
      )
    }
  }

  private async confirmRuntimeTerminal(executionId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (isTerminalExecutionState((await this.runtime.status(executionId)).status)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Daemon process did not reach a terminal state after cancellation')
  }

  /** executionId → node_run_id（工作流桥接用）。 */
  getNodeRunId(executionId: string): string | null {
    return this.executions.getNodeRunId(executionId)
  }

  get(executionId: string): Execution {
    const execution = this.executions.get(executionId)
    if (!execution) {
      throw new RpcMethodError('EXECUTION_NOT_FOUND', `execution not found: ${executionId}`)
    }
    return execution
  }

  list(limit = 50): Execution[] {
    return this.executions.list(limit)
  }

  logsFor(params: ExecutionLogsParams): ExecutionLog[] {
    this.get(params.executionId)
    return this.logs.list(params.executionId, params.afterSequence ?? 0, params.limit ?? 1000)
  }

  /** 处理 Daemon 事件：eventId 去重 → 持久化 → 广播 Desktop。 */
  handleRuntimeEvent(event: RuntimeEvent): void {
    const lease = this.drain?.acquire('event-handler', `event:${event.eventType}`, {
      // Drain is closed before active Execution reaches zero; necessary terminal events remain
      // admitted through the explicitly controlled internal path until ingress is paused.
      internal: this.maintenance?.isEventIngressAllowed?.() === true,
    })
    try {
      this.handleRuntimeEventInternal(event)
    } finally {
      lease?.release()
    }
  }

  private handleRuntimeEventInternal(event: RuntimeEvent): void {
    if (this.seenEventIds.has(event.eventId)) {
      this.logger?.info('duplicate runtime event ignored', {
        eventId: event.eventId,
        eventType: event.eventType,
      })
      return
    }
    this.rememberEvent(event.eventId)

    try {
      switch (event.eventType) {
        case 'execution.output':
          this.handleOutput(event)
          break
        case 'execution.state':
          this.handleState(event)
          break
        case 'execution.exited':
          this.handleExited(event)
          break
        default:
          this.logger?.warn('unknown runtime event type', { eventType: event.eventType })
      }
    } catch (error) {
      // 单条事件处理失败不得打断订阅；结构化记录后继续处理后续事件。
      this.logger?.error('failed to handle runtime event', {
        eventId: event.eventId,
        eventType: event.eventType,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * S55-2B-1B（R3）：保守对账分类器——启动恢复与运行期重连共用。
   *
   * 证据只来自 Daemon 的 listActive + 逐执行 status：
   * - Daemon 明确报告活跃 → 保持 running（A1/A5）；
   * - Daemon 同进程明确报告终态 → 补记账（A2，TX1+补偿链）；
   * - Daemon 查不到记录（EXECUTION_NOT_FOUND）→ 不可确认（A3/A6），绝不判 crashed；
   * - Daemon 活跃但 DB 已终态 / DB 未知 → 矛盾（C3/C4），调用方进入 recovery_locked。
   * listActive/status 抛非 EXECUTION_NOT_FOUND 错误 → 证据中断（C5），原样上抛。
   * 不再有「pending 宽限期后自动判 crashed」的分支。
   */
  async reconcile(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      confirmedActive: [],
      observedTerminal: [],
      unconfirmed: [],
      conflicts: [],
    }
    const activeIds = new Set(await this.runtime.listActive())
    const now = this.now()
    const dbActive = this.executions.listActive()
    const dbActiveIds = new Set(dbActive.map((execution) => execution.id))

    for (const execution of dbActive) {
      // 在途启动（行已建、spawn 未返回）：证据尚未产生，不参与分类。
      if (this.starting.has(execution.id)) continue
      // 排队行由 discardQueuedOnStartup 按策略处置（boot 期先行执行）。
      if (execution.status === 'pending' && this.queued.has(execution.id)) continue

      if (activeIds.has(execution.id)) {
        this.executions.markRunning(execution.id, {
          processId: null,
          startedAt: execution.startedAt ?? now,
          updatedAt: now,
        })
        report.confirmedActive.push(execution.id)
        continue
      }

      let status: {
        status: ExecutionState
        exitCode: number | null
        endedAt: string | null
        processId: number | null
      }
      try {
        status = await this.runtime.status(execution.id)
      } catch (error) {
        if (error instanceof RpcMethodError && error.code === 'EXECUTION_NOT_FOUND') {
          report.unconfirmed.push(execution.id)
          this.audit?.append({
            actorType: 'system',
            actorId: null,
            action: 'reconciliation.execution.unconfirmed',
            targetType: 'execution',
            targetId: execution.id,
            details: {
              source: 'reconciliation_observed',
              evidence: 'EXECUTION_NOT_FOUND',
              previousStatus: execution.status,
            },
            now,
          })
          continue
        }
        // C5：对账过程中 Daemon 断开/不可达——中止，由调用方 recovery_locked。
        throw error
      }

      if (isTerminalExecutionState(status.status)) {
        report.observedTerminal.push({ executionId: execution.id, daemonStatus: status.status })
        this.recordTerminalObservation({
          executionId: execution.id,
          status: status.status,
          exitCode: status.exitCode,
          endedAt: status.endedAt ?? now,
          source: 'reconciliation_observed',
          extraState: { reason: 'reconciliation_observed' },
          evidence: {
            daemonStatus: status.status,
            daemonProcessId: status.processId,
            previousStatus: execution.status,
          },
          logEvent: 'execution.reconciled',
          logData: {
            daemonStatus: status.status,
            previousStatus: execution.status,
            ...this.workflowContext(execution.id),
          },
          auditAction: 'reconciliation.execution.observed_terminal',
        })
      } else {
        // Daemon 认识且非终态（未出现在 listActive 的竞态窗口）：按活跃处理。
        this.executions.markRunning(execution.id, {
          processId: null,
          startedAt: execution.startedAt ?? now,
          updatedAt: now,
        })
        report.confirmedActive.push(execution.id)
      }
    }

    // C3/C4：Daemon 活跃集合中的 DB 已终态 / DB 未知执行——矛盾，不可仲裁。
    for (const id of activeIds) {
      if (dbActiveIds.has(id)) continue
      const row = this.executions.get(id)
      if (row && isTerminalExecutionState(row.status)) {
        report.conflicts.push({ kind: 'daemon_active_db_terminal', executionId: id })
      } else if (!row) {
        report.conflicts.push({ kind: 'daemon_unknown_execution', executionId: id })
      }
    }
    for (const conflict of report.conflicts) {
      this.audit?.append({
        actorType: 'system',
        actorId: null,
        action: 'reconciliation.conflict',
        targetType: 'execution',
        targetId: conflict.executionId,
        details: { source: 'reconciliation_observed', kind: conflict.kind },
        now,
      })
      this.logger?.error('reconciliation conflict detected', {
        kind: conflict.kind,
        executionId: conflict.executionId,
      })
    }

    return report
  }

  /**
   * S55-2B-1B（A2）：终态观察统一入口。
   *
   * TX1（BEGIN IMMEDIATE）内原子完成：终态 CAS + terminalProcessing.pending 标志
   * + session/lock/系统日志/审计。事务内 read-merge-write 保留既有 recovery_state
   * 键；JSON 损坏即抛错回滚（fail closed，禁止静默覆盖）。
   *
   * 事务提交后执行补偿链。补偿是否执行**只由持久化 pending 状态驱动**，
   * 绝不由 finish 的 changed 返回值决定（崩溃遗留场景下 CAS 必输但副作用欠缺）。
   */
  private recordTerminalObservation(input: {
    executionId: string
    status: ExecutionState
    exitCode?: number | null
    endedAt: string
    source: TerminalObservationSource
    extraState?: Record<string, unknown>
    evidence?: Record<string, unknown>
    logEvent?: string
    logData?: Record<string, unknown>
    auditAction?: string
  }): void {
    const existing = this.executions.get(input.executionId)
    if (!existing) return

    if (!isTerminalExecutionState(existing.status)) {
      transaction(this.db, () => {
        const raw = this.executions.getRecoveryStateRaw(input.executionId)
        if (raw.raw !== null && !raw.valid) {
          throw new Error(
            `recovery_state_json is corrupt for execution ${input.executionId}; refusing to overwrite (fail closed)`,
          )
        }
        let merged: Record<string, unknown> = {}
        if (raw.raw !== null) {
          // 损坏 JSON 在上一分支已拦截；这里仍兜底解析失败为 fail closed。
          try {
            merged = JSON.parse(raw.raw) as Record<string, unknown>
          } catch (error) {
            throw new Error(
              `recovery_state_json parse failed for execution ${input.executionId}: ${String(error)}`,
            )
          }
        }
        merged = {
          ...merged,
          ...(input.extraState ?? {}),
          terminalProcessing: {
            state: 'pending',
            source: input.source,
            observedAt: input.endedAt,
            ...(input.evidence ? { evidence: input.evidence } : {}),
          },
        }
        const changed = this.executions.finish(input.executionId, {
          status: input.status,
          exitCode: input.exitCode,
          endedAt: input.endedAt,
          recoveryState: merged,
        })
        if (!changed) return
        this.sessions.end(existing.sessionId, input.endedAt)
        this.locks.releaseByExecution(input.executionId)
        if (input.logEvent) {
          this.appendSystemLog(
            input.executionId,
            input.logEvent,
            input.logData ?? {},
            input.endedAt,
          )
        }
        if (input.auditAction) {
          this.audit?.append({
            actorType: 'system',
            actorId: null,
            action: input.auditAction,
            targetType: 'execution',
            targetId: input.executionId,
            details: {
              source: input.source,
              previousStatus: existing.status,
              status: input.status,
              ...(input.evidence ?? {}),
            },
            now: input.endedAt,
          })
        }
      })
    }

    // 补偿由持久化状态驱动：无论本次是否赢得 CAS，只要该行是 pending 就执行/重放。
    this.processTerminalCompensation(input.executionId)
  }

  /**
   * S55-2B-1B：终态补偿链（S2–S5）。完全由持久化 pending 状态驱动，幂等可重放。
   * 全链同步执行（无 await / 无 kick）；桥接直调（不经 engine 包装）。
   */
  private processTerminalCompensation(
    executionId: string,
  ): 'completed' | 'pending' | 'not-applicable' {
    const execution = this.executions.get(executionId)
    if (!execution) return 'not-applicable'
    if (!isTerminalExecutionState(execution.status)) return 'not-applicable'
    const raw = this.executions.getRecoveryStateRaw(executionId)
    // 无标志的历史终态行不归本机制管（节点层由 recover-N2 兜底）。
    if (raw.raw === null) return 'not-applicable'
    if (!raw.valid) return 'pending'
    let state: Record<string, unknown>
    try {
      state = JSON.parse(raw.raw) as Record<string, unknown>
    } catch {
      return 'pending'
    }
    const processing = state.terminalProcessing as { state?: unknown } | undefined
    if (!processing || processing.state === 'completed') return 'not-applicable'
    if (processing.state !== 'pending') return 'pending'

    // S2：内存队列清理（幂等）。
    this.queued.delete(executionId)
    // S3：桥接直调（同步；内部 guard + CAS 保证重复调用 no-op）。
    try {
      this.onTerminalBridge?.(execution)
    } catch (error) {
      this.logger?.error('terminal compensation bridge failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return 'pending'
    }
    // S4：验证必要副作用已完成。
    const verification = this.verifyTerminalCompensation(execution)
    if (!verification.ok) {
      this.logger?.error('terminal compensation verification failed', {
        executionId,
        reason: verification.reason,
      })
      return 'pending'
    }
    // 从未启动的恢复 Execution 不产生 Checkpoint；它是启动中断对账结果，不是任务事实。
    if (state.reason !== 'START_INTERRUPTED') {
      try {
        this.checkpoints?.createForExecution(executionId, 'generic')
      } catch (error) {
        this.logger?.warn('checkpoint creation failed after terminal compensation', {
          executionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // S5：completed 标记（json_patch 键级合并，保留 source/evidence 等既有键）。
    const completedAt = this.now()
    try {
      this.executions.mergeRecoveryState(
        executionId,
        { terminalProcessing: { state: 'completed', completedAt } },
        completedAt,
      )
    } catch (error) {
      this.logger?.error('terminal compensation completed write failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return 'pending'
    }
    return 'completed'
  }

  /** S55-2B-1B（S4）：验证终态补偿的必要副作用（报告五 §2.2 允许集合）。 */
  private verifyTerminalCompensation(
    execution: Execution,
  ): { ok: true } | { ok: false; reason: string } {
    const session = this.sessions.get(execution.sessionId)
    if (session?.status !== 'ended') {
      return { ok: false, reason: `session ${execution.sessionId} is not ended` }
    }
    if (this.locks.countByExecution(execution.id) > 0) {
      return { ok: false, reason: 'workdir lock still held' }
    }
    const nodeRunId = this.executions.getNodeRunId(execution.id)
    // scratch 执行（node_run_id = NULL）：无节点校验项。
    if (nodeRunId === null) return { ok: true }
    if (!this.nodeRuns) return { ok: false, reason: 'node run repository unavailable' }
    const nodeRun = this.nodeRuns.get(nodeRunId)
    if (!nodeRun) return { ok: false, reason: `node run ${nodeRunId} not found` }
    if (!TERMINAL_COMPENSATION_NODE_STATUSES.has(nodeRun.status)) {
      return { ok: false, reason: `node run ${nodeRunId} is ${nodeRun.status}` }
    }
    if (this.workflowRuns && !this.workflowRuns.get(nodeRun.workflowRunId)) {
      return { ok: false, reason: `workflow run ${nodeRun.workflowRunId} not found` }
    }
    return { ok: true }
  }

  /**
   * S55-2B-1B：启动终态补偿 sweep。损坏 JSON 预检 fail closed；
   * 任一待处理行验证失败时保持 pending 并上报（调用方进入 recovery_locked）。
   */
  processTerminalBacklog(): {
    processed: number
    completed: number
    failures: Array<{ executionId: string; reason: string }>
  } {
    const corrupt = this.executions.countCorruptRecoveryState()
    if (corrupt > 0) {
      throw new Error(
        `detected ${corrupt} execution(s) with corrupt recovery_state_json; refusing to continue boot (fail closed)`,
      )
    }
    const pendingRows = this.executions.listTerminalProcessingPending()
    const failures: Array<{ executionId: string; reason: string }> = []
    let completed = 0
    for (const execution of pendingRows) {
      let outcome: 'completed' | 'pending' | 'not-applicable'
      try {
        outcome = this.processTerminalCompensation(execution.id)
      } catch (error) {
        failures.push({
          executionId: execution.id,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (outcome === 'completed') completed += 1
      else if (outcome === 'pending') {
        failures.push({ executionId: execution.id, reason: 'compensation verification failed' })
      }
    }
    return { processed: pendingRows.length, completed, failures }
  }

  private handleOutput(event: RuntimeEvent): void {
    const payload = ExecutionOutputPayload.parse(event.payload)
    payload.content = redactOutput(payload.content)
    const execution = this.executions.get(payload.executionId)
    if (!execution) {
      this.logger?.warn('output event for unknown execution', { executionId: payload.executionId })
      return
    }
    const persisted = this.logs.append(
      payload.executionId,
      payload.stream,
      payload.content,
      payload.timestamp,
    )
    // 补充持久化后的 log 序号：Desktop 据此与 execution.logs 拉取结果去重。
    this.hub.publish({ ...event, payload: { ...payload, logSequenceNo: persisted.sequenceNo } })
  }

  private handleState(event: RuntimeEvent): void {
    const payload = ExecutionStatePayload.parse(event.payload)
    const execution = this.executions.get(payload.executionId)
    if (!execution) {
      this.logger?.warn('state event for unknown execution', { executionId: payload.executionId })
      return
    }
    // 终态事件由 exited 事件统一落库，避免重复迁移与重复日志。
    if (isTerminalExecutionState(execution.status)) return

    if (payload.status === 'running') {
      this.executions.markRunning(payload.executionId, {
        processId: null,
        startedAt: payload.timestamp,
        updatedAt: payload.timestamp,
      })
      this.appendSystemLog(
        payload.executionId,
        'execution.state',
        {
          status: payload.status,
          previousStatus: payload.previousStatus,
          detail: payload.detail ?? null,
        },
        payload.timestamp,
      )
      this.hub.publish(event)
      return
    }

    if (isTerminalExecutionState(payload.status)) {
      // S55-2B-1B：终态走统一 TX1 + 补偿链（审计来源 event_observed）。
      this.recordTerminalObservation({
        executionId: payload.executionId,
        status: payload.status,
        endedAt: payload.timestamp,
        source: 'event_observed',
        evidence: { previousStatus: payload.previousStatus, detail: payload.detail ?? null },
        logEvent: 'execution.state',
        logData: {
          status: payload.status,
          previousStatus: payload.previousStatus,
          detail: payload.detail ?? null,
        },
        auditAction: 'execution.terminal.observed',
      })
      this.hub.publish(event)
      this.notifyExecutionFinished(payload.executionId)
      return
    }

    this.appendSystemLog(
      payload.executionId,
      'execution.state',
      {
        status: payload.status,
        previousStatus: payload.previousStatus,
        detail: payload.detail ?? null,
      },
      payload.timestamp,
    )
    this.hub.publish(event)
  }

  /** 诊断字段：执行 → NodeRun → Run/Branch；缺失时只带已知 ID。 */
  private workflowContext(executionId: string): Record<string, unknown> {
    const nodeRunId = this.executions.getNodeRunId(executionId)
    if (!nodeRunId) return {}
    const nodeRun = this.nodeRuns?.get(nodeRunId)
    return {
      nodeRunId,
      ...(nodeRun ? { runId: nodeRun.workflowRunId, branchRunId: nodeRun.branchRunId } : {}),
    }
  }

  private notifyExecutionFinished(executionId: string): void {
    if (!this.onExecutionFinished) return
    const execution = this.executions.get(executionId)
    if (!execution) return
    try {
      this.onExecutionFinished(execution)
    } catch (error) {
      this.logger?.warn('onExecutionFinished callback failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private handleExited(event: RuntimeEvent): void {
    const payload = ExecutionExitedPayload.parse(event.payload)
    const execution = this.executions.get(payload.executionId)
    if (!execution) {
      this.logger?.warn('exited event for unknown execution', {
        executionId: payload.executionId,
      })
      return
    }
    // S55-2B-1B：终态事实已落库后到达的重复 exited 事件不重复记账（幂等收紧）。
    // 但状态事件不含 exit code，仍需用 exited 补全进程事实（不改变终态）。
    if (isTerminalExecutionState(execution.status)) {
      if (execution.exitCode === null) {
        this.executions.finish(payload.executionId, {
          status: execution.status,
          exitCode: payload.exitCode,
          endedAt: payload.timestamp,
        })
        // 终态已由 state 事件落库；exited 仍要留下进程事实证据（供排障与验收）。
        this.appendSystemLog(
          payload.executionId,
          'execution.exited',
          {
            exitCode: payload.exitCode,
            signal: payload.signal,
            reason: payload.reason,
            ...this.workflowContext(payload.executionId),
          },
          payload.timestamp,
        )
      }
      this.logger?.info('exited event for already-terminal execution ignored', {
        executionId: payload.executionId,
        status: execution.status,
      })
      return
    }
    const status: ExecutionState =
      payload.reason === 'cancelled'
        ? 'cancelled'
        : payload.reason === 'crashed'
          ? 'crashed'
          : payload.exitCode === 0
            ? 'succeeded'
            : 'failed'
    this.recordTerminalObservation({
      executionId: payload.executionId,
      status,
      exitCode: payload.exitCode,
      endedAt: payload.timestamp,
      source: 'event_observed',
      evidence: { reason: payload.reason, signal: payload.signal, exitCode: payload.exitCode },
      logEvent: 'execution.exited',
      logData: {
        exitCode: payload.exitCode,
        signal: payload.signal,
        reason: payload.reason,
        ...this.workflowContext(payload.executionId),
      },
      auditAction: 'execution.terminal.observed',
    })
    void this.drainQueue(execution.agentId)
    this.hub.publish(event)
    this.notifyExecutionFinished(payload.executionId)
  }

  /**
   * 解析工作目录：绑定 Work 时用 worktree 或 work.rootPath，否则沿用阶段 1 的执行 scratch 目录。
   * 返回值里的 workId 只用于锁记录与排障。
   */
  private resolveWorkingDirectory(
    params: ExecutionStartParams,
    executionId: string,
    allowInactiveWork = false,
  ): { workingDirectory: string; workId: string | null; allowedRoots: string[] } {
    if (!params.workId) {
      return {
        workingDirectory: executionScratchDir(this.scratchRoot, executionId),
        workId: null,
        allowedRoots: [],
      }
    }
    const work = this.works.get(params.workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${params.workId}`)
    if (!allowInactiveWork && !WORK_ACCEPTS_EXECUTIONS.has(work.status)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${work.id} is ${work.status}, cannot start executions`,
      )
    }
    if (params.worktreeId) {
      const worktree = this.worktrees.get(params.worktreeId)
      if (!worktree || worktree.workId !== work.id) {
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `worktree ${params.worktreeId} does not belong to work ${work.id}`,
        )
      }
      if (worktree.status !== 'active') {
        throw new RpcMethodError('INVALID_PARAMS', `worktree ${worktree.id} is ${worktree.status}`)
      }
      return {
        workingDirectory: path.resolve(worktree.worktreePath),
        workId: work.id,
        // worktree 在数据目录下，同时声明 Work 根，便于未来在 rootPath 内再派生子目录。
        allowedRoots: [this.worktrees.worktreeRoot, path.resolve(work.rootPath)],
      }
    }
    return {
      workingDirectory: path.resolve(work.rootPath),
      workId: work.id,
      allowedRoots: [path.resolve(work.rootPath)],
    }
  }

  /**
   * 槽位释放后按入队顺序自动调度。同一 Agent 的调度串行化，避免并发触发重复启动。
   */
  private async drainQueue(agentId: string | null): Promise<void> {
    if (!agentId || this.draining.has(agentId)) return
    if (this.maintenance && !this.maintenance.isExecutionStartAllowed()) return
    this.draining.add(agentId)
    try {
      for (;;) {
        if (this.maintenance && !this.maintenance.isExecutionStartAllowed()) return
        const agent = this.agents.get(agentId)
        if (!agent) return
        const active = this.executions.countActiveByAgent(agentId)
        if (active >= agent.maxConcurrency) return

        const next = this.executions.listQueuedByAgent(agentId, 1000).find((candidate) => {
          const owner = this.executions.findOwningWork(candidate.id)
          return !owner || this.works.get(owner.workId)?.status === 'active'
        })
        if (!next) return
        const job = this.queued.get(next.id)
        this.queued.delete(next.id)
        const now = this.now()
        this.executions.setRecoveryState(next.id, { queued: false, dequeuedAt: now }, now)
        this.appendSystemLog(next.id, 'execution.dequeued', { activeBefore: active }, now)
        if (!job) {
          // 进程内队列与库里的标记不一致（理论上不该发生）：按失败终态处理，不静默丢弃。
          this.recordTerminalObservation({
            executionId: next.id,
            status: 'failed',
            endedAt: now,
            source: 'core_initiated',
            extraState: { reason: 'queue_entry_missing' },
          })
          continue
        }
        try {
          await this.spawn(job)
        } catch {
          // spawn 已把执行置为 failed 并记录原因；继续尝试下一条。
        }
      }
    } finally {
      this.draining.delete(agentId)
    }
  }

  /**
   * Core 启动时处置上次遗留的排队任务：**丢弃并标记**，不自动恢复。
   * 理由：排队任务从未启动过进程，自动补跑等于在用户不知情时产生副作用。
   */
  discardQueuedOnStartup(): number {
    const queuedRows = this.executions.listQueued()
    const now = this.now()
    for (const execution of queuedRows) {
      // S55-2B-1B：走统一终态观察入口（TX1 原子 + 补偿链）；丢弃是启动策略动作，
      // 不写对账审计（保持既有 system log 语义）。
      this.recordTerminalObservation({
        executionId: execution.id,
        status: 'failed',
        endedAt: now,
        source: 'core_initiated',
        extraState: { reason: 'queue_discarded_on_restart', discardedAt: now },
        logEvent: 'execution.queue_discarded',
        logData: { reason: 'core_restart', ...this.workflowContext(execution.id) },
      })
    }
    return queuedRows.length
  }

  /**
   * 解析 (workId, agentId) 的 active assignment。
   * 未指定 workId（阶段 1 scratch 模式）返回 null；指定了但查不到 active 岗位直接拒绝。
   */
  private resolveActiveAssignment(
    workId: string | undefined,
    agentId: string,
  ): { id: string } | null {
    if (!workId) return null
    const assignment = this.assignments.findByWorkAndAgent(workId, agentId)
    if (assignment?.status !== 'active') {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${workId} has no active assignment for agent ${agentId}; create one before starting an execution`,
      )
    }
    return assignment
  }

  private resolveProvider(agent: AgentProfile): RuntimeProviderRecord {
    const candidates = this.registry.list()
    if (candidates.length === 0) {
      throw new RpcMethodError(
        'CLI_UNAVAILABLE',
        '未发现任何运行时 Provider。请安装 Claude Code 后刷新 Provider（runtime.provider.refresh）。',
      )
    }
    const preferredId = agent.defaultProviderId ?? this.agents.defaultProviderId(agent.id)
    if (preferredId) {
      const preferred = candidates.find((provider) => provider.id === preferredId)
      if (!preferred) {
        throw new RpcMethodError(
          'PROVIDER_NOT_FOUND',
          `agent ${agent.id} is bound to missing provider ${preferredId}`,
        )
      }
      return preferred
    }
    const healthy = candidates.find(
      (provider) => provider.healthStatus === 'healthy' && provider.executablePath !== null,
    )
    // 上面已保证 candidates 非空；显式判空替代非空断言，保持类型安全且无行为变化。
    const fallback = candidates[0]
    if (!fallback) {
      throw new RpcMethodError('CLI_UNAVAILABLE', '未发现任何运行时 Provider。')
    }
    return healthy ?? fallback
  }

  private assertProviderUsable(provider: RuntimeProviderRecord): void {
    if (!provider.executablePath) {
      throw new RpcMethodError(
        'CLI_UNAVAILABLE',
        `Provider ${provider.id} 未找到 Claude Code 可执行文件。请安装 Claude Code 后刷新 Provider。`,
      )
    }
    try {
      fs.accessSync(provider.executablePath, fs.constants.X_OK)
    } catch {
      this.registry.markUnavailable(provider.id)
      throw new RpcMethodError(
        'CLI_UNAVAILABLE',
        `Claude Code 可执行文件不可用：${provider.executablePath}。请检查安装或设置 AGENTRA_CLAUDE_PATH 后刷新 Provider。`,
      )
    }
    if (provider.healthStatus === 'unauthenticated') {
      throw new RpcMethodError(
        'CLI_NOT_AUTHENTICATED',
        'Claude Code 未认证：请在终端执行 `claude auth login`（或配置 ANTHROPIC_API_KEY）后刷新 Provider。',
      )
    }
    if (provider.healthStatus !== 'healthy') {
      throw new RpcMethodError(
        'CLI_UNAVAILABLE',
        `Provider ${provider.id} 健康状态为 ${provider.healthStatus}。请刷新 Provider（runtime.provider.refresh）后重试。`,
      )
    }
  }

  private publishState(
    executionId: string,
    status: ExecutionState,
    previousStatus: ExecutionState | null,
    detail?: string,
  ): void {
    const occurredAt = this.now()
    this.hub.publish({
      eventId: newId('evt'),
      protocolVersion: PROTOCOL_VERSION,
      eventType: 'execution.state',
      occurredAt,
      aggregateType: 'execution',
      aggregateId: executionId,
      payload: {
        executionId,
        // 0 = Core 合成事件（非 Daemon 事件流）。
        sequenceNo: 0,
        status,
        previousStatus,
        detail,
        timestamp: occurredAt,
      },
      correlationId: executionId,
    })
  }

  private appendSystemLog(
    executionId: string,
    event: string,
    data: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.logs.append(executionId, 'system', JSON.stringify({ event, ...data }), timestamp)
  }

  private rememberEvent(eventId: string): void {
    this.seenEventIds.add(eventId)
    this.seenEventOrder.push(eventId)
    while (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventOrder.shift()
      if (oldest) this.seenEventIds.delete(oldest)
    }
  }
}
