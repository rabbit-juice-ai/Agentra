import { newId } from '@agentra/shared'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { BranchRunRecord, BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { applyBranchPausePolicy, type BranchPauseExecutor } from './branch-pause-policy'
import type { DispatchContext, DispatchGate } from './dispatch-gates'
import { evaluateReadiness, type NodeStateView, ROOT_BRANCH_KEY, resolveBranchKeys } from './graph'
import type { PublishedDefinitionProvider } from './published-definition-provider'

export type NodeStartHandler = (context: DispatchContext) => void | Promise<void>

export type TickResult = {
  /** blocked → ready 的节点 key。 */
  promoted: string[]
  /**
   * 已**尝试**启动的节点：CAS `ready → running` 成功后立刻记录。
   * 只代表"调度器把它交给了 onNodeStarted"，不代表执行成功——执行结果由 S4-4 回写。
   */
  startedAttempts: string[]
  /** 资源/分支闸门拒绝的节点与原因（保持 ready，不启动）。 */
  skippedGates: { nodeKey: string; gate: string; reason: string; agentId?: string }[]
  /** 有失败前驱、无法就绪的节点。 */
  failedPredecessors: Record<string, string[]>
  /** 本 tick 真正 CAS 成功的启动明细（含 nodeRunId / branchRunId / agentId）。 */
  startedNodes: {
    runId: string
    nodeKey: string
    nodeRunId: string
    branchRunId: string | null
    agentId: string | null
  }[]
}

export type SchedulerLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

export type TickOptions = {
  /**
   * 公平调度：同一 tick 内每个 Agent 最多启动的节点数。
   * 由 FairDispatcher 逐 Run 调用时共享 startsByAgent，保证多 Run 轮转。
   */
  maxStartsPerAgent?: number
  /** 同一轮公平调度内各 Agent 已启动数；由调用方跨 Run 共享。 */
  startsByAgent?: Map<string, number>
}

export type SchedulerDeps = {
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  /**
   * **必填**：派发闸门必须由装配方显式提供。
   * 生产装配用真实端口（S4-4 前可以显式空实现）；测试显式传
   * `defaultDispatchGates(allowAllResourcePorts())`。
   * 这里刻意没有默认值：漏传一次就会让资源闸门全部失效，且没有任何运行时信号。
   */
  gates: DispatchGate[]
  /** 公平调度：解析节点所属 Agent；解析失败返回 null（不参与 per-agent 限额）。 */
  agentResolver?: (context: DispatchContext) => string | null
  /** 暂停/恢复审计（actor/action/target）。 */
  audit?: AuditRepository
  /** S4-07：执行处置端口。未提供时 pauseBranch 只做状态迁移（不中断执行）。 */
  pauseExecutor?: BranchPauseExecutor
  /** S4-07：执行处置的可观测性。 */
  pauseLogger?: { warn(message: string, meta?: Record<string, unknown>): void }
  /** S4-07：非终态执行查询（按分支）。 */
  executionsRepo?: ExecutionRepository
  /** 失败兜底路径的可观测性（如 nodes.fail() 因状态被并发改走而未生效）。 */
  logger?: SchedulerLogger
  /** S55-2B：维护模式门禁；缺省视为 normal（测试/旧装配兼容）。 */
  maintenance?: { isSchedulerAllowed(): boolean }
  /** S55-2B：in-flight tick 计数；缺省不跟踪（测试/旧装配兼容）。 */
  drain?: DrainCoordinator
  /**
   * ready → running 之后的启动钩子。S4-3 只提供接缝，真正的 Execution 桥接在 S4-4；
   * 钩子抛错时节点按结构化失败（category=internal）收尾，不会留在 running。
   */
  onNodeStarted?: NodeStartHandler
  now?: () => string
}

const EMPTY_RESULT: TickResult = {
  promoted: [],
  startedAttempts: [],
  skippedGates: [],
  failedPredecessors: {},
  startedNodes: [],
}

function latestAttempts(nodes: NodeRunRecord[]): Map<string, NodeRunRecord> {
  const latest = new Map<string, NodeRunRecord>()
  for (const node of nodes) {
    const current = latest.get(node.workflowNodeKey)
    if (!current || node.attempt > current.attempt) latest.set(node.workflowNodeKey, node)
  }
  return latest
}

/** 为一次 Run 建立分支实例：root（active）+ 每个 split 的 `<split>/<branchKey>`（blocked）。幂等。 */
export function ensureBranchRuns(
  branches: BranchRunRepository,
  runId: string,
  definition: WorkflowDefinition,
  now: string,
): BranchRunRecord[] {
  const branchKeys = new Set<string>([ROOT_BRANCH_KEY])
  for (const key of resolveBranchKeys(definition).values()) branchKeys.add(key)

  const existing = new Map(branches.listByRun(runId).map((branch) => [branch.branchKey, branch]))
  for (const branchKey of branchKeys) {
    if (existing.has(branchKey)) continue
    const created = branches.create(
      {
        id: newId('brn'),
        workflowRunId: runId,
        branchKey,
        status: branchKey === ROOT_BRANCH_KEY ? 'active' : 'blocked',
      },
      now,
    )
    existing.set(branchKey, created)
  }
  return [...existing.values()]
}

/**
 * 调度核心：只做「依赖计算 → blocked→ready → 闸门判定 → ready→running」。
 *
 * 约束：
 * - 所有状态迁移都走 Repository 的「状态机对照 + CAS」，不直接 UPDATE；
 * - 不调用全量一致性断言（它只能在一一致性边界调用，调度循环内部不是边界）；
 * - 暂停 = 状态过滤：分支/运行被暂停时闸门拒绝派发，不杀任何进程。
 */
export class WorkflowScheduler {
  private readonly runs: WorkflowRunRepository
  private readonly branches: BranchRunRepository
  private readonly nodes: NodeRunRepository
  private readonly definitions: PublishedDefinitionProvider
  private readonly gates: DispatchGate[]
  private readonly agentResolver: ((context: DispatchContext) => string | null) | undefined
  private readonly audit: AuditRepository | undefined
  private readonly pauseExecutor: BranchPauseExecutor | undefined
  private readonly pauseLogger:
    | { warn(message: string, meta?: Record<string, unknown>): void }
    | undefined
  private readonly executionsRepo: ExecutionRepository | undefined
  private readonly onNodeStarted: NodeStartHandler | undefined
  private readonly logger: SchedulerLogger | undefined
  private readonly maintenance: { isSchedulerAllowed(): boolean } | undefined
  private readonly drain: DrainCoordinator | undefined
  private readonly now: () => string

  constructor(deps: SchedulerDeps) {
    if (!Array.isArray(deps.gates)) {
      throw new Error(
        'workflow scheduler requires explicit dispatch gates; refusing to fall back to allow-all ports',
      )
    }
    this.runs = deps.runs
    this.branches = deps.branches
    this.nodes = deps.nodes
    this.definitions = deps.definitions
    this.gates = deps.gates
    this.agentResolver = deps.agentResolver
    this.audit = deps.audit
    this.pauseExecutor = deps.pauseExecutor
    this.pauseLogger = deps.pauseLogger
    this.executionsRepo = deps.executionsRepo
    this.onNodeStarted = deps.onNodeStarted
    this.logger = deps.logger
    this.maintenance = deps.maintenance
    this.drain = deps.drain
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** 一次调度推进：可重复调用，直到 TickResult 为空。 */
  async tick(runId: string, options: TickOptions = {}): Promise<TickResult> {
    if (!this.isDispatchAllowed()) return { ...EMPTY_RESULT }
    const lease = this.drain?.acquire('scheduler-tick', `tick:${runId}`)
    try {
      return await this.tickInternal(runId, options)
    } finally {
      lease?.release()
    }
  }

  /** 维护模式是否允许新的调度推进。 */
  isDispatchAllowed(): boolean {
    return !this.maintenance || this.maintenance.isSchedulerAllowed()
  }

  private async tickInternal(runId: string, options: TickOptions = {}): Promise<TickResult> {
    if (!this.isDispatchAllowed()) return { ...EMPTY_RESULT }
    const now = this.now()
    const run = this.runs.get(runId)
    if (run === null || run.status !== 'running') return { ...EMPTY_RESULT }

    const { definition } = this.definitions.get(run.workflowVersionId)
    const branchKeys = resolveBranchKeys(definition)

    const before = latestAttempts(this.nodes.listByRun(runId))
    const states = new Map<string, NodeStateView>()
    for (const [key, node] of before) {
      states.set(key, { status: node.status, output: node.outputSnapshot })
    }

    const readiness = evaluateReadiness(definition, states)
    const promoted: string[] = []
    for (const key of readiness.ready) {
      const node = before.get(key)
      if (node === undefined || node.status !== 'blocked') continue
      if (this.nodes.transition(node.id, ['blocked'], 'ready', now)) promoted.push(key)
    }

    const after = latestAttempts(this.nodes.listByRun(runId))
    const startedAttempts: string[] = []
    const startedNodes: TickResult['startedNodes'] = []
    const skippedGates: TickResult['skippedGates'] = []

    const nodesByKey = new Map(definition.nodes.map((node) => [node.key, node]))
    const readyRuns = [...after.values()]
      .filter((node) => node.status === 'ready')
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )

    for (const nodeRun of readyRuns) {
      if (!this.isDispatchAllowed()) break
      const definitionNode = nodesByKey.get(nodeRun.workflowNodeKey)
      if (definitionNode === undefined) continue

      const branchKey = branchKeys.get(definitionNode.key) ?? ROOT_BRANCH_KEY

      // F-3：每个节点在闸门与 CAS 之前**同步重读** run 与 branch。
      // 重读 → 闸门 → CAS 全程同步，中间不得插入 await —— 否则 await onNodeStarted
      // 期间发生的 pauseBranch/pauseRun 仍会跨越到本次 tick 的后续节点。
      const currentRun = this.runs.get(runId)
      if (currentRun === null || currentRun.status !== 'running') break
      // 返工会为已终结的并行分支创建带后缀的新 BranchRun；NodeRun 上的 branch_run_id
      // 是权威归属，定义映射只是旧数据的回退。重读与闸门/CAS 之间仍然不得 await。
      const currentBranch =
        (nodeRun.branchRunId ? this.branches.get(nodeRun.branchRunId) : null) ??
        this.branches.getByKey(runId, branchKey)
      if (currentBranch === null) {
        skippedGates.push({
          nodeKey: definitionNode.key,
          gate: 'branch_record',
          reason: `branch run ${branchKey} not found`,
        })
        continue
      }

      const context: DispatchContext = {
        run: currentRun,
        nodeRun,
        node: definitionNode,
        branch: currentBranch,
        branchKey: currentBranch.branchKey,
        definition,
      }

      const agentId = this.agentResolver?.(context) ?? null
      const usedByAgent = agentId ? (options.startsByAgent?.get(agentId) ?? 0) : 0
      if (
        agentId !== null &&
        options.maxStartsPerAgent !== undefined &&
        usedByAgent >= options.maxStartsPerAgent
      ) {
        skippedGates.push({
          nodeKey: definitionNode.key,
          gate: 'agent_rotation',
          reason: `agent ${agentId} reached per-pass start limit`,
          agentId,
        })
        continue
      }

      let denied: { gate: string; reason: string } | null = null
      for (const gate of this.gates) {
        const result = gate.check(context)
        if (!result.ok) {
          denied = { gate: gate.name, reason: result.reason }
          break
        }
      }
      if (denied) {
        skippedGates.push({ nodeKey: definitionNode.key, ...denied })
        continue
      }

      // CAS：并发下只有一个调度者能把 ready 推到 running（与重读同一同步块）
      if (!this.isDispatchAllowed()) break
      if (!this.nodes.transition(nodeRun.id, ['ready'], 'running', now)) continue

      if (!this.isDispatchAllowed()) {
        this.deferForMaintenance(nodeRun, now)
        continue
      }

      startedAttempts.push(definitionNode.key)
      startedNodes.push({
        runId,
        nodeKey: definitionNode.key,
        nodeRunId: nodeRun.id,
        branchRunId: nodeRun.branchRunId,
        agentId,
      })
      if (agentId !== null && options.startsByAgent) {
        options.startsByAgent.set(agentId, (options.startsByAgent.get(agentId) ?? 0) + 1)
      }

      try {
        await this.onNodeStarted?.(context)
      } catch (error) {
        const marked = this.nodes.fail(
          nodeRun.id,
          ['running'],
          {
            category: 'internal',
            nodeKey: definitionNode.key,
            message: `node start handler failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          this.now(),
        )
        if (!marked) {
          this.logger?.warn('node failed to transition to failed; state was changed concurrently', {
            runId: runId,
            branchRunId: nodeRun.branchRunId,
            nodeKey: definitionNode.key,
            nodeRunId: nodeRun.id,
          })
        }
      }
      if (!this.isDispatchAllowed()) {
        this.logger?.warn('maintenance entered while node start handler was in flight', {
          runId,
          branchRunId: nodeRun.branchRunId,
          nodeKey: definitionNode.key,
          nodeRunId: nodeRun.id,
        })
      }
    }

    return {
      promoted,
      startedAttempts,
      skippedGates,
      failedPredecessors: Object.fromEntries(readiness.failedPredecessors),
      startedNodes,
    }
  }

  /**
   * CAS 已发生但维护模式在 handler 启动前生效：节点不能留在 running，也不能标记成功。
   * 使用 reconciliation_required，等待后续人工/恢复对账，不自动重跑。
   */
  private deferForMaintenance(nodeRun: NodeRunRecord, now: string): void {
    const moved = this.nodes.transition(nodeRun.id, ['running'], 'reconciliation_required', now)
    if (!moved) {
      this.logger?.warn('node maintenance defer transition skipped; state changed concurrently', {
        nodeRunId: nodeRun.id,
        nodeKey: nodeRun.workflowNodeKey,
      })
    }
  }

  /** 反复推进直到没有 promoted / startedAttempts（有上限，避免调度器空转）。 */
  async runUntilIdle(runId: string, maxTicks = 100): Promise<TickResult[]> {
    const results: TickResult[] = []
    for (let index = 0; index < maxTicks; index += 1) {
      const result = await this.tick(runId)
      results.push(result)
      if (result.promoted.length === 0 && result.startedAttempts.length === 0) break
    }
    return results
  }

  /**
   * 为一次 Run 建立分支实例：root（active）+ 每个 split 的 `<split>/<branchKey>`（blocked，
   * 由 ParallelSplit 处理器在 split 成功时激活）。幂等。
   */
  ensureBranches(runId: string, definition: WorkflowDefinition): BranchRunRecord[] {
    return ensureBranchRuns(this.branches, runId, definition, this.now())
  }

  /**
   * 暂停分支：CAS active → paused + 对该分支运行中 Execution 按其 Provider 能力处置（S4-07）。
   * 顺序保证：状态先落库（闸门立即停止派发），随后执行处置；处置是异步的，
   * 失败不回滚状态（闸门已生效），按 awaiting_completion 兜底并记录审计/告警。
   */
  pauseBranch(
    runId: string,
    branchKey: string,
    reason: string,
    actor: { type: 'user' | 'agent' | 'system'; id?: string } = { type: 'system' },
  ): Promise<boolean> {
    const branch = this.branches.getByKey(runId, branchKey)
    if (!branch) return Promise.resolve(false)
    const now = this.now()
    const paused = this.branches.pause(branch.id, reason, now)
    if (paused) {
      this.audit?.append({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'workflow.branch.paused',
        targetType: 'branch_run',
        targetId: branch.id,
        details: { runId, branchKey, reason, from: 'active', to: 'paused' },
        now,
      })
      if (this.pauseExecutor && this.executionsRepo) {
        return applyBranchPausePolicy({
          branchRunId: branch.id,
          executions: this.executionsRepo,
          nodeRuns: this.nodes,
          executor: this.pauseExecutor,
          audit: this.audit,
          logger: this.pauseLogger,
          runId,
          branchKey,
          now: this.now(),
        }).then(() => true)
      }
    }
    return Promise.resolve(paused)
  }

  /**
   * 恢复分支：CAS paused → active；下一次 tick 会重新计算依赖并派发。
   *
   * 被中断执行的续接语义（S4-07）：
   * - interrupt + resume 均可用（native 档）：无需重建——若 CLI 进程仍在，reconcile 会
   *   恢复订阅；若进程已随中断退出，node 回到 running 时由 Execution 终态回写/恢复服务
   *   按「终态执行补记账」处理，重新派发新 attempt（resume 走既有 session）。
   * - interrupt 可用、resume 不可用（上下文档）：不 resume，恢复后由调度器为该节点
   *   重新派发新 attempt（上下文在 Session 里，attempt 是新执行）。
   * - interrupt 不支持：无需动作——执行从未被打断，自然结束后闸门恢复派发。
   * 三档的共同点：恢复后该分支 ready 的节点由 tick 重新计算依赖派发，无需专门重建。
   */
  resumeBranch(
    runId: string,
    branchKey: string,
    actor: { type: 'user' | 'agent' | 'system'; id?: string } = { type: 'system' },
  ): boolean {
    const branch = this.branches.getByKey(runId, branchKey)
    if (!branch) return false
    const resumed = this.branches.resume(branch.id, this.now())
    if (resumed) {
      this.audit?.append({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'workflow.branch.resumed',
        targetType: 'branch_run',
        targetId: branch.id,
        details: { runId, branchKey, from: 'paused', to: 'active' },
        now: this.now(),
      })
    }
    return resumed
  }

  /** Work 级暂停：Run 迁移 running → paused，所有分支都不再派发（不改分支自身状态）。 */
  pauseRun(
    runId: string,
    actor: { type: 'user' | 'agent' | 'system'; id?: string } = { type: 'system' },
  ): boolean {
    const paused = this.runs.transition(runId, ['running'], 'paused', this.now())
    if (paused) {
      this.audit?.append({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'workflow.run.paused',
        targetType: 'workflow_run',
        targetId: runId,
        details: { from: 'running', to: 'paused' },
        now: this.now(),
      })
    }
    return paused
  }

  /** Work 级恢复：paused → running，下一次 tick 重新计算依赖。 */
  resumeRun(
    runId: string,
    actor: { type: 'user' | 'agent' | 'system'; id?: string } = { type: 'system' },
  ): boolean {
    const resumed = this.runs.transition(runId, ['paused'], 'running', this.now())
    if (resumed) {
      this.audit?.append({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'workflow.run.resumed',
        targetType: 'workflow_run',
        targetId: runId,
        details: { from: 'paused', to: 'running' },
        now: this.now(),
      })
    }
    return resumed
  }

  get(runId: string): WorkflowRunRecord | null {
    return this.runs.get(runId)
  }
}
