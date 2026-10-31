import { newId } from '@agentra/shared'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import type { BranchRunRecord, BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import {
  allowAllResourcePorts,
  type DispatchContext,
  type DispatchGate,
  defaultDispatchGates,
  type ResourcePorts,
} from './dispatch-gates'
import { evaluateReadiness, type NodeStateView, ROOT_BRANCH_KEY, resolveBranchKeys } from './graph'
import type { PublishedDefinitionProvider } from './published-definition-provider'

export type NodeStartHandler = (context: DispatchContext) => void | Promise<void>

export type TickResult = {
  /** blocked → ready 的节点 key。 */
  promoted: string[]
  /** ready → running 且已交给 onNodeStarted 的节点 key。 */
  started: string[]
  /** 资源/分支闸门拒绝的节点与原因（保持 ready，不启动）。 */
  skippedGates: { nodeKey: string; gate: string; reason: string }[]
  /** 有失败前驱、无法就绪的节点。 */
  failedPredecessors: Record<string, string[]>
}

export type SchedulerDeps = {
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  /** 默认六项检查；测试可注入更少/更多闸门。 */
  gates?: DispatchGate[]
  ports?: ResourcePorts
  /**
   * ready → running 之后的启动钩子。S4-3 只提供接缝，真正的 Execution 桥接在 S4-4；
   * 钩子抛错时节点按结构化失败（category=internal）收尾，不会留在 running。
   */
  onNodeStarted?: NodeStartHandler
  now?: () => string
}

const EMPTY_RESULT: TickResult = {
  promoted: [],
  started: [],
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
  private readonly now: () => string

  constructor(deps: SchedulerDeps) {
    this.runs = deps.runs
    this.branches = deps.branches
    this.nodes = deps.nodes
    this.definitions = deps.definitions
    this.gates = deps.gates ?? defaultDispatchGates(deps.ports ?? allowAllResourcePorts())
    this.onNodeStarted = deps.onNodeStarted
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** 一次调度推进：可重复调用，直到 TickResult 为空。 */
  async tick(runId: string): Promise<TickResult> {
    const now = this.now()
    const run = this.runs.get(runId)
    if (run === null || run.status !== 'running') return { ...EMPTY_RESULT }

    const { definition } = this.definitions.get(run.workflowVersionId)
    const branchKeys = resolveBranchKeys(definition)
    const branches = new Map(
      this.branches.listByRun(runId).map((branch) => [branch.branchKey, branch]),
    )

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
    const started: string[] = []
    const skippedGates: TickResult['skippedGates'] = []

    for (const definitionNode of definition.nodes) {
      const nodeRun = after.get(definitionNode.key)
      if (nodeRun === undefined || nodeRun.status !== 'ready') continue

      const branchKey = branchKeys.get(definitionNode.key) ?? ROOT_BRANCH_KEY
      const branch = branches.get(branchKey)
      if (!branch) {
        skippedGates.push({
          nodeKey: definitionNode.key,
          gate: 'branch_record',
          reason: `branch run ${branchKey} not found`,
        })
        continue
      }

      const context: DispatchContext = {
        run,
        nodeRun,
        node: definitionNode,
        branch,
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

      // CAS：并发下只有一个调度者能把 ready 推到 running
      if (!this.nodes.transition(nodeRun.id, ['ready'], 'running', now)) continue
      started.push(definitionNode.key)

      try {
        await this.onNodeStarted?.(context)
      } catch (error) {
        this.nodes.fail(
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
      }
    }

    return {
      promoted,
      started,
      skippedGates,
      failedPredecessors: Object.fromEntries(readiness.failedPredecessors),
    }
  }

  /** 反复推进直到没有 promoted / started（有上限，避免调度器空转）。 */
  async runUntilIdle(runId: string, maxTicks = 100): Promise<TickResult[]> {
    const results: TickResult[] = []
    for (let index = 0; index < maxTicks; index += 1) {
      const result = await this.tick(runId)
      results.push(result)
      if (result.promoted.length === 0 && result.started.length === 0) break
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
