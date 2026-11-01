import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agentra/workflow-schema'
import { isTerminalNodeStatus, type NodeRunStatus } from './state-machine'

/** 不属于任何并行分支的节点（Start 到 Split 之前、Join 之后）。 */
export const ROOT_BRANCH_KEY = 'root'

export type WorkflowGraph = {
  nodes: Map<string, WorkflowNode>
  out: Map<string, WorkflowEdge[]>
  inn: Map<string, WorkflowEdge[]>
}

export function buildGraph(definition: WorkflowDefinition): WorkflowGraph {
  const nodes = new Map<string, WorkflowNode>()
  for (const node of definition.nodes) nodes.set(node.key, node)
  const out = new Map<string, WorkflowEdge[]>()
  const inn = new Map<string, WorkflowEdge[]>()
  for (const key of nodes.keys()) {
    out.set(key, [])
    inn.set(key, [])
  }
  for (const edge of definition.edges) {
    out.get(edge.source)?.push(edge)
    inn.get(edge.target)?.push(edge)
  }
  return { nodes, out, inn }
}

/**
 * 运行期分支实例键：`<splitNodeKey>/<branchKey>`，root 分支为 `root`。
 *
 * 区域定义：split 的每条出边沿图向下，直到配对 join（不含 join）为止的节点都属于该分支；
 * 发布期已保证 MVP 不允许嵌套并行，所以区域不会重叠。
 */
export function resolveBranchKeys(definition: WorkflowDefinition): Map<string, string> {
  const graph = buildGraph(definition)
  const result = new Map<string, string>()
  for (const node of definition.nodes) result.set(node.key, ROOT_BRANCH_KEY)

  const joins = definition.nodes.filter((node) => node.type === 'join')
  for (const split of definition.nodes) {
    if (split.type !== 'parallel_split') continue
    const join = joins.find((candidate) => candidate.config.pairWith === split.key)
    if (!join) continue

    for (const edge of graph.out.get(split.key) ?? []) {
      if (edge.branchKey === undefined) continue
      const branchKey = `${split.key}/${edge.branchKey}`
      const visited = new Set<string>()
      const queue = [edge.target]
      while (queue.length > 0) {
        const key = queue.shift()
        if (key === undefined || key === join.key || visited.has(key)) continue
        visited.add(key)
        // 先到先得：同一节点不会同时属于两个并行区域（嵌套并行在发布期已被拒绝）
        if (result.get(key) === ROOT_BRANCH_KEY) result.set(key, branchKey)
        for (const next of graph.out.get(key) ?? []) queue.push(next.target)
      }
    }
  }
  return result
}

/** 运行期节点视图：只依赖 NodeRun 的状态与输出，不读定义之外的运行态。 */
export type NodeStateView = {
  status: NodeRunStatus
  output: Record<string, unknown> | null
}

export type EdgeDisposition = 'taken' | 'not_taken' | 'pending' | 'failed' | 'skipped'

/**
 * 一条入边的运行期处置：
 * - taken：源节点成功，且（无边条件 或 condition 输出 when 与边一致）
 * - not_taken：condition 边且 when 与输出不一致（该分支未被选中）
 * - pending：源未终态，或 condition 尚未记录 when
 * - failed：源节点失败/取消/跳过
 */
export function edgeDisposition(
  edge: WorkflowEdge,
  states: Map<string, NodeStateView>,
): EdgeDisposition {
  const source = states.get(edge.source)
  if (!source || !isTerminalNodeStatus(source.status)) return 'pending'
  if (source.status === 'skipped') return 'skipped'
  if (source.status !== 'succeeded') return 'failed'
  if (edge.when === undefined) return 'taken'
  const when = source.output?.when
  if (typeof when !== 'boolean') return 'pending'
  return when === edge.when ? 'taken' : 'not_taken'
}

/**
 * 该测试节点的失败是否由下游 Condition 的 falseBranch=rework 消费。
 * 若是，返工由 Condition 触发（它会把自己也纳入返工区域重新求值），
 * 桥接层不得再自动触发一次，否则会留下一个不会被重新求值的 Condition。
 */
export function isTestReportConsumedByCondition(
  definition: WorkflowDefinition,
  testNodeKey: string,
): boolean {
  return definition.nodes.some(
    (node) =>
      node.type === 'condition' &&
      typeof node.config.falseBranch === 'object' &&
      node.config.falseBranch.kind === 'rework' &&
      node.config.falseBranch.reportNodeKey === testNodeKey,
  )
}

export type ReadinessResult = {
  /** 应迁移 blocked → ready 的节点 key（按定义顺序）。 */
  ready: string[]
  /** 仍不可就绪的原因（诊断用）。 */
  pending: Map<string, string>
  /** 有失败/取消/跳过前驱的节点。 */
  failedPredecessors: Map<string, string[]>
}

/**
 * 依赖计算：只判断 blocked 节点是否满足"全部入边已处置且至少一条 taken"。
 *
 * - join：要求**所有**入边 taken（all_success）；
 * - 其它节点：condition 的未选中分支视为已处置（不计入 required），
 *   但必须至少有一条 taken —— 全部未选中的节点不会被调度，交由分支失败/跳过策略处理。
 * - 不做任何状态写入：调用方按 S4-1 的 CAS 迁移。
 */
export function evaluateReadiness(
  definition: WorkflowDefinition,
  states: Map<string, NodeStateView>,
): ReadinessResult {
  const graph = buildGraph(definition)
  const ready: string[] = []
  const pending = new Map<string, string>()
  const failedPredecessors = new Map<string, string[]>()

  for (const node of definition.nodes) {
    const state = states.get(node.key)
    if (state && state.status !== 'blocked') continue
    if (!state) {
      pending.set(node.key, 'node_run_missing')
      continue
    }

    if (node.type === 'start') {
      ready.push(node.key)
      continue
    }

    const incoming = graph.inn.get(node.key) ?? []
    if (incoming.length === 0) {
      pending.set(node.key, 'no_incoming_edges')
      continue
    }

    const dispositions = incoming.map((edge) => ({
      edge,
      disposition: edgeDisposition(edge, states),
    }))
    const failedSources = dispositions
      .filter((item) => item.disposition === 'failed')
      .map((item) => item.edge.source)
    if (failedSources.length > 0) {
      failedPredecessors.set(node.key, failedSources)
      pending.set(node.key, 'predecessor_failed')
      continue
    }

    const pendingEdge = dispositions.find((item) => item.disposition === 'pending')
    if (pendingEdge) {
      pending.set(
        node.key,
        pendingEdge.edge.when === undefined
          ? `predecessor_pending:${pendingEdge.edge.source}`
          : `condition_outcome_missing:${pendingEdge.edge.source}`,
      )
      continue
    }

    const taken = dispositions.filter((item) => item.disposition === 'taken').length
    const skipped = dispositions.filter((item) => item.disposition === 'skipped').length
    if (node.type === 'join') {
      // skipped 不阻塞 join：全部入边要么 taken、要么 skipped 即可进入 join 运行时，
      // 由运行时决定 join 自身是否 skipped（all_success 前提不成立）。
      if (taken + skipped !== incoming.length) {
        pending.set(node.key, 'join_waiting_all_success')
        continue
      }
    } else if (taken === 0) {
      pending.set(node.key, 'no_taken_edge')
      continue
    }

    ready.push(node.key)
  }

  return { ready, pending, failedPredecessors }
}
