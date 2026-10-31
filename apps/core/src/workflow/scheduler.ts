import { newId } from '@agentra/shared'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import type { BranchRunRecord, BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
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
  skippedGates: { nodeKey: string; gate: string; reason: string }[]
  /** 有失败前驱、无法就绪的节点。 */
  failedPredecessors: Record<string, string[]>
}

export type SchedulerLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
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
  /** 失败兜底路径的可观测性（如 nodes.fail() 因状态被并发改走而未生效）。 */
  logger?: SchedulerLogger
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
}

function latestAttempts(nodes: NodeRunRecord[]): Map<string, NodeRunRecord> {
  const latest = new Map<string, NodeRunRecord>()
  for (const node of nodes) {
    const current = latest.get(node.workflowNodeKey)
    if (!current || node.attempt > current.attempt) latest.set(node.workflowNodeKey, node)
  }
  return latest
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
  private readonly onNodeStarted: NodeStartHandler | undefined
  private readonly logger: SchedulerLogger | undefined
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
    this.onNodeStarted = deps.onNodeStarted
    this.logger = deps.logger
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** 一次调度推进：可重复调用，直到 TickResult 为空。 */
  async tick(runId: string): Promise<TickResult> {
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
    const skippedGates: TickResult['skippedGates'] = []

    for (const definitionNode of definition.nodes) {
      const nodeRun = after.get(definitionNode.key)
      if (nodeRun === undefined || nodeRun.status !== 'ready') continue

      const branchKey = branchKeys.get(definitionNode.key) ?? ROOT_BRANCH_KEY

      // F-3：每个节点在闸门与 CAS 之前**同步重读** run 与 branch。
      // 重读 → 闸门 → CAS 全程同步，中间不得插入 await —— 否则 await onNodeStarted
      // 期间发生的 pauseBranch/pauseRun 仍会跨越到本次 tick 的后续节点。
      const currentRun = this.runs.get(runId)
      if (currentRun === null || currentRun.status !== 'running') break
      const currentBranch = this.branches.getByKey(runId, branchKey)
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
        branchKey,
        definition,
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
      if (!this.nodes.transition(nodeRun.id, ['ready'], 'running', now)) continue
      startedAttempts.push(definitionNode.key)

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
            nodeKey: definitionNode.key,
            nodeRunId: nodeRun.id,
          })
        }
      }
    }

    return {
      promoted,
      startedAttempts,
      skippedGates,
      failedPredecessors: Object.fromEntries(readiness.failedPredecessors),
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
    const now = this.now()
    const branchKeys = new Set<string>([ROOT_BRANCH_KEY])
    for (const key of resolveBranchKeys(definition).values()) branchKeys.add(key)

    const existing = new Map(
      this.branches.listByRun(runId).map((branch) => [branch.branchKey, branch]),
    )
    for (const branchKey of branchKeys) {
      if (existing.has(branchKey)) continue
      const created = this.branches.create(
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

  /** 暂停分支：只改状态（CAS active → paused），调度闸门随即拒绝该分支的派发。 */
  pauseBranch(runId: string, branchKey: string, reason: string): boolean {
    const branch = this.branches.getByKey(runId, branchKey)
    if (!branch) return false
    return this.branches.pause(branch.id, reason, this.now())
  }

  /** 恢复分支：CAS paused → active；下一次 tick 会重新计算依赖并派发。 */
  resumeBranch(runId: string, branchKey: string): boolean {
    const branch = this.branches.getByKey(runId, branchKey)
    if (!branch) return false
    return this.branches.resume(branch.id, this.now())
  }

  /** Work 级暂停：Run 迁移 running → paused，所有分支都不再派发（不改分支自身状态）。 */
  pauseRun(runId: string): boolean {
    return this.runs.transition(runId, ['running'], 'paused', this.now())
  }

  /** Work 级恢复：paused → running，下一次 tick 重新计算依赖。 */
  resumeRun(runId: string): boolean {
    return this.runs.transition(runId, ['paused'], 'running', this.now())
  }

  get(runId: string): WorkflowRunRecord | null {
    return this.runs.get(runId)
  }
}
