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
} from '@agentra/protocol'
import { executionScratchDir, newId } from '@agentra/shared'
import type { RuntimeClient } from '../daemon/daemon-client'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { AssignmentRepository } from '../db/repositories/assignment-repository'
import type { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import {
  type ExecutionRepository,
  isTerminalExecutionState,
} from '../db/repositories/execution-repository'
import type { SessionRepository } from '../db/repositories/session-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { CoreEventHub } from './event-hub'
import type { ProviderRegistry } from './provider-registry'
import type { WorkdirLockService } from './workdir-lock-service'
import type { WorktreeService } from './worktree-service'

export type ExecutionServiceLogger = {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
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
  allowedTools: string[]
  disallowedTools: string[]
  allowedRoots: string[] | undefined
}

export type ExecutionServiceDeps = {
  db: Database
  runtime: RuntimeClient
  registry: ProviderRegistry
  works: WorkRepository
  worktrees: WorktreeService
  locks: WorkdirLockService
  agents: AgentRepository
  assignments: AssignmentRepository
  sessions: SessionRepository
  executions: ExecutionRepository
  logs: ExecutionLogRepository
  hub: CoreEventHub
  scratchRoot: string
  logger?: ExecutionServiceLogger
  now?: () => string
}

/** 无人值守执行的默认权限模式：不弹权限请求（阶段 1 无审批 UI），最小权限。 */
const DEFAULT_PERMISSION_MODE = 'dontAsk'
const MAX_SEEN_EVENT_IDS = 10_000
/** 对账宽限：刚创建的 pending 执行可能仍在启动途中，不判为崩溃。 */
const RECONCILE_PENDING_GRACE_MS = 30_000
/** 只有进行中的 Work 可以启动执行。 */
const WORK_ACCEPTS_EXECUTIONS = new Set(['active', 'paused'])

/**
 * 执行编排：Core 是 Execution 状态的唯一权威写入者。
 * 顺序遵循 ARCHITECTURE §8：先落库启动意图 → 请求 Daemon 启动 → 持久化结果 → 消费事件。
 */
export class ExecutionService {
  private readonly seenEventIds = new Set<string>()
  /** executionId → 待启动任务；与 executions 表里的 queued 标记一一对应。 */
  private readonly queued = new Map<string, SpawnJob>()
  private readonly draining = new Set<string>()
  private readonly seenEventOrder: string[] = []
  private readonly db: Database
  private readonly runtime: RuntimeClient
  private readonly registry: ProviderRegistry
  private readonly agents: AgentRepository
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
  private readonly now: () => string

  constructor(deps: ExecutionServiceDeps) {
    this.db = deps.db
    this.runtime = deps.runtime
    this.registry = deps.registry
    this.agents = deps.agents
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
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async start(params: ExecutionStartParams): Promise<Execution> {
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
    const toolPermissions = agent.toolPermissions
    if (toolPermissions.allow.length === 0) {
      throw new RpcMethodError(
        'AGENT_TOOLS_NOT_CONFIGURED',
        `Agent「${agent.name}」未配置任何允许工具（allow 为空）。请先在 Agent 配置中填写允许使用的工具再启动执行。`,
      )
    }

    const provider = this.resolveProvider(agent)
    // 验收 6：CLI 不可用/未认证必须在创建 Execution 之前拦截。
    this.assertProviderUsable(provider)

    // D-1：绑定 Work 时必须先解析该 (workId, agentId) 的 active assignment。
    // 拦截点必须在「获取目录锁 / 创建 Session / 创建 Execution」三者之前，命中即零副作用。
    const assignment = this.resolveActiveAssignment(params.workId, agent.id)

    const executionId = `exe-${crypto.randomUUID()}`
    const sessionId = newId('ses')
    const externalSessionId = crypto.randomUUID()
    const { workingDirectory, workId, allowedRoots } = this.resolveWorkingDirectory(
      params,
      executionId,
    )

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
      this.executions.create(execution)
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
        { allow: toolPermissions.allow, deny: toolPermissions.deny },
        now,
      )
    })
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
      systemPrompt: agent.systemPrompt.length > 0 ? agent.systemPrompt : undefined,
      allowedTools: toolPermissions.allow,
      disallowedTools: toolPermissions.deny,
      // 阶段 2：绑定 Work 时把允许的目录根一并声明给 Daemon（Daemon 仍做边界校验）。
      allowedRoots: workId ? [this.scratchRoot, ...allowedRoots] : undefined,
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
      this.logger?.info('execution queued', { executionId, agentId: agent.id, activeCount })
      return this.get(executionId)
    }

    return this.spawn(job)
  }

  /**
   * 真正启动进程。排队任务被调度时复用同一条路径。
   */
  private async spawn(job: SpawnJob): Promise<Execution> {
    const { executionId } = job
    try {
      const handle = await this.runtime.start({
        executionId,
        providerId: job.providerId,
        executablePath: job.executablePath,
        capabilities: job.capabilities,
        prompt: job.prompt,
        workingDirectory: job.workingDirectory,
        sessionId: job.externalSessionId,
        systemPrompt: job.systemPrompt,
        permissionMode: DEFAULT_PERMISSION_MODE,
        allowedTools: job.allowedTools,
        disallowedTools: job.disallowedTools,
        allowedRoots: job.allowedRoots,
      })
      this.executions.markRunning(executionId, {
        processId: handle.processId,
        startedAt: handle.startedAt,
        updatedAt: handle.startedAt,
      })
      this.appendSystemLog(
        executionId,
        'execution.process_started',
        { processId: handle.processId },
        handle.startedAt,
      )
      return this.get(executionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.locks.releaseByExecution(executionId)
      const failedAt = this.now()
      this.executions.finish(executionId, {
        status: 'failed',
        endedAt: failedAt,
        recoveryState: { reason: 'start_failed', message },
      })
      this.sessions.end(job.sessionId, failedAt)
      this.appendSystemLog(executionId, 'execution.start_failed', { message }, failedAt)
      this.publishState(executionId, 'failed', 'pending', message)
      this.logger?.error('execution start failed', { executionId, error: message })
      throw error
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

  async cancel(params: ExecutionCancelParams): Promise<Execution> {
    const execution = this.get(params.executionId)
    // D-2：取消排队中的执行时，把内存队列里的条目一并清掉，避免 Map 单调增长。
    this.queued.delete(params.executionId)
    if (isTerminalExecutionState(execution.status)) return execution

    const now = this.now()
    const previous = execution.status
    this.executions.finish(execution.id, {
      status: 'cancelled',
      endedAt: now,
      recoveryState: { reason: 'user_cancelled' },
    })
    this.sessions.end(execution.sessionId, now)
    this.queued.delete(execution.id)
    this.appendSystemLog(execution.id, 'execution.cancel_requested', {}, now)
    this.publishState(execution.id, 'cancelled', previous, 'cancelled by user')
    this.locks.releaseByExecution(execution.id)
    void this.drainQueue(execution.agentId)

    try {
      await this.runtime.cancel(execution.id)
    } catch (error) {
      // Daemon 侧取消失败：状态已按用户意图终结，记录可追踪的失败原因。
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn('daemon cancel failed', { executionId: execution.id, error: message })
      this.executions.setRecoveryState(
        execution.id,
        { reason: 'cancel_failed', message },
        this.now(),
      )
    }
    return this.get(execution.id)
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
   * Daemon 订阅（重）连后对账：Daemon 不知道的活跃执行标记 crashed，
   * 仍在运行的执行保持 running。绝不自动重放可能有副作用的执行。
   */
  async reconcile(): Promise<void> {
    const activeIds = await this.runtime.listActive()
    const active = new Set(activeIds)
    const now = this.now()
    for (const execution of this.executions.listActive()) {
      if (active.has(execution.id)) {
        this.executions.markRunning(execution.id, {
          processId: null,
          startedAt: execution.startedAt ?? now,
          updatedAt: now,
        })
        continue
      }
      if (execution.status === 'pending' && this.queued.has(execution.id)) {
        // 排队中的执行本来就没有进程，不能按崩溃处理。
        continue
      }
      if (
        execution.status === 'pending' &&
        Date.now() - Date.parse(execution.createdAt) < RECONCILE_PENDING_GRACE_MS
      ) {
        continue
      }
      const previous = execution.status
      this.executions.finish(execution.id, {
        status: 'crashed',
        endedAt: now,
        recoveryState: {
          reason: 'reconciliation',
          detail: 'process not found in daemon after reconnect',
        },
      })
      this.sessions.end(execution.sessionId, now)
      this.appendSystemLog(execution.id, 'execution.crashed', { reason: 'reconciliation' }, now)
      this.publishState(
        execution.id,
        'crashed',
        previous,
        'process not found in daemon after reconnect',
      )
      this.logger?.warn('execution reconciled as crashed', { executionId: execution.id })
    }
  }

  private handleOutput(event: RuntimeEvent): void {
    const payload = ExecutionOutputPayload.parse(event.payload)
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
    } else if (isTerminalExecutionState(payload.status)) {
      this.executions.finish(payload.executionId, {
        status: payload.status,
        endedAt: payload.timestamp,
      })
      this.sessions.end(execution.sessionId, payload.timestamp)
      this.locks.releaseByExecution(payload.executionId)
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

  private handleExited(event: RuntimeEvent): void {
    const payload = ExecutionExitedPayload.parse(event.payload)
    const execution = this.executions.get(payload.executionId)
    if (!execution) {
      this.logger?.warn('exited event for unknown execution', {
        executionId: payload.executionId,
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
    this.executions.finish(payload.executionId, {
      status,
      exitCode: payload.exitCode,
      endedAt: payload.timestamp,
    })
    this.sessions.end(execution.sessionId, payload.timestamp)
    this.queued.delete(payload.executionId)
    this.locks.releaseByExecution(payload.executionId)
    void this.drainQueue(execution.agentId)
    this.appendSystemLog(
      payload.executionId,
      'execution.exited',
      { exitCode: payload.exitCode, signal: payload.signal, reason: payload.reason },
      payload.timestamp,
    )
    this.hub.publish(event)
  }

  /**
   * 解析工作目录：绑定 Work 时用 worktree 或 work.rootPath，否则沿用阶段 1 的执行 scratch 目录。
   * 返回值里的 workId 只用于锁记录与排障。
   */
  private resolveWorkingDirectory(
    params: ExecutionStartParams,
    executionId: string,
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
    if (!WORK_ACCEPTS_EXECUTIONS.has(work.status)) {
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
    this.draining.add(agentId)
    try {
      for (;;) {
        const agent = this.agents.get(agentId)
        if (!agent) return
        const active = this.executions.countActiveByAgent(agentId)
        if (active >= agent.maxConcurrency) return

        const [next] = this.executions.listQueuedByAgent(agentId, 1)
        if (!next) return
        const job = this.queued.get(next.id)
        this.queued.delete(next.id)
        const now = this.now()
        this.executions.setRecoveryState(next.id, { queued: false, dequeuedAt: now }, now)
        this.appendSystemLog(next.id, 'execution.dequeued', { activeBefore: active }, now)
        if (!job) {
          // 进程内队列与库里的标记不一致（理论上不该发生）：按失败终态处理，不静默丢弃。
          this.executions.finish(next.id, {
            status: 'failed',
            endedAt: now,
            recoveryState: { reason: 'queue_entry_missing' },
          })
          this.sessions.end(next.sessionId, now)
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
      this.executions.finish(execution.id, {
        status: 'failed',
        endedAt: now,
        recoveryState: { reason: 'queue_discarded_on_restart', discardedAt: now },
      })
      this.sessions.end(execution.sessionId, now)
      this.locks.releaseByExecution(execution.id)
      this.appendSystemLog(
        execution.id,
        'execution.queue_discarded',
        { reason: 'core_restart' },
        now,
      )
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
    if (!assignment || assignment.status !== 'active') {
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
