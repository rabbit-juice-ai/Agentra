import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import type { ApprovalService } from './approval-service'
import { type ConditionNodeState, evaluateCondition } from './condition-evaluator'
import type { PublishedDefinitionProvider } from './published-definition-provider'

export type ControlEventSink = {
  publish(event: { type: string; runId: string }): void
}

export type ReworkTrigger = {
  request(input: { runId: string; nodeRunId: string; nodeKey: string; reportNodeKey: string }): void
}

export type ControlNodeDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  approvals: ApprovalService
  eventSink?: ControlEventSink
  reworkTrigger?: ReworkTrigger
  now?: () => string
}

type Loaded = {
  nodeRun: NodeRunRecord
  run: WorkflowRunRecord
  definition: WorkflowDefinition
  node: WorkflowNode
}

function load(deps: ControlNodeDeps, nodeRunId: string): Loaded {
  const nodeRun = deps.nodes.get(nodeRunId)
  if (!nodeRun) throw new Error(`node run ${nodeRunId} not found`)
  const run = deps.runs.get(nodeRun.workflowRunId)
  if (!run) throw new Error(`workflow run ${nodeRun.workflowRunId} not found`)
  const { definition } = deps.definitions.get(run.workflowVersionId)
  const node = definition.nodes.find((candidate) => candidate.key === nodeRun.workflowNodeKey)
  if (!node) throw new Error(`node ${nodeRun.workflowNodeKey} not found in definition`)
  return { nodeRun, run, definition, node }
}

function latestStates(deps: ControlNodeDeps, runId: string): Map<string, ConditionNodeState> {
  const latest = new Map<string, ConditionNodeState>()
  const attempts = new Map<string, NodeRunRecord>()
  for (const node of deps.nodes.listByRun(runId)) {
    const current = attempts.get(node.workflowNodeKey)
    if (!current || node.attempt > current.attempt) attempts.set(node.workflowNodeKey, node)
  }
  for (const [key, node] of attempts) {
    latest.set(key, { status: node.status, attempt: node.attempt, output: node.outputSnapshot })
  }
  return latest
}

/** Condition 运行时：求值 → 写 output.when；求值异常 → 节点 failed（不按 false 处理）。 */
export function completeConditionNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, definition, node } = load(deps, nodeRunId)
  if (node.type !== 'condition') throw new Error(`node ${node.key} is not a condition node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()

  const result = evaluateCondition(node.config.predicate, latestStates(deps, run.id))
  if (!result.ok) {
    deps.nodes.fail(
      nodeRun.id,
      ['running'],
      { category: 'condition_evaluation', nodeKey: node.key, message: result.reason },
      now,
    )
    return
  }

  if (!result.value) {
    const falseBranch = node.config.falseBranch
    if (typeof falseBranch === 'object' && falseBranch.kind === 'rework') {
      // C-11：rework 也算「假分支已匹配」，节点本身成功，返工动作交给 S4-6 的触发器。
      // 触发器缺失是接线错误，不能静默成功——否则「返工」被吞掉，下游无从得知。
      if (!deps.reworkTrigger) {
        deps.nodes.fail(
          nodeRun.id,
          ['running'],
          {
            category: 'internal',
            nodeKey: node.key,
            message: 'rework trigger is not configured for falseBranch=rework',
          },
          now,
        )
        return
      }
      deps.reworkTrigger.request({
        runId: run.id,
        nodeRunId: nodeRun.id,
        nodeKey: node.key,
        reportNodeKey: falseBranch.reportNodeKey,
      })
    } else if (!definition.edges.some((edge) => edge.source === node.key && edge.when === false)) {
      deps.nodes.fail(
        nodeRun.id,
        ['running'],
        {
          category: 'condition_evaluation',
          nodeKey: node.key,
          message: 'condition evaluated to false but no when=false edge exists',
        },
        now,
      )
      return
    }
  }

  deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now, {
    outputSnapshot: { when: result.value },
  })
}

/** Join 运行时：任一入边源 failed/cancelled → join failed；全部 succeeded 才放行。 */
export function completeJoinNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, definition, node } = load(deps, nodeRunId)
  if (node.type !== 'join') throw new Error(`node ${node.key} is not a join node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()
  const states = latestStates(deps, run.id)
  const incoming = definition.edges.filter((edge) => edge.target === node.key)

  const failedSources = incoming
    .map((edge) => edge.source)
    .filter((source) => {
      const state = states.get(source)
      return state?.status === 'failed' || state?.status === 'cancelled'
    })
  if (failedSources.length > 0) {
    deps.nodes.fail(
      nodeRun.id,
      ['running'],
      {
        category: 'join_failed',
        nodeKey: node.key,
        message: `join failed: upstream ${failedSources.join(', ')} did not succeed`,
        details: { failedSources },
      },
      now,
    )
    return
  }

  const allSucceeded = incoming.every((edge) => states.get(edge.source)?.status === 'succeeded')
  if (!allSucceeded) return
  deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now)
}

/** C-9：全部分支终止后才终结 Run；任一 failed → failed，否则 completed。 */
export function resolveRunTerminalStatus(
  branches: { status: string }[],
): 'completed' | 'failed' | null {
  if (
    branches.some(
      (branch) =>
        branch.status === 'active' || branch.status === 'paused' || branch.status === 'blocked',
    )
  ) {
    return null
  }
  return branches.some((branch) => branch.status === 'failed') ? 'failed' : 'completed'
}

/** End 运行时：结束所在分支；全部分支终止后按 C-9 终结 Run 并只发一次事件。 */
export function completeEndNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, node } = load(deps, nodeRunId)
  if (node.type !== 'end') throw new Error(`node ${node.key} is not an end node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()

  // 节点结束、分支结束、Run 终结必须原子；事件只能在 COMMIT 之后发布。
  const event = transaction(deps.db, () => {
    // 分支必须处于 active/paused 才能被 End 收尾；blocked 分支上出现 End 属调度异常，
    // 此时不写任何状态，避免「节点 succeeded 但分支仍 blocked」的半提交。
    const branch = nodeRun.branchRunId ? deps.branches.get(nodeRun.branchRunId) : null
    if (nodeRun.branchRunId && branch?.status !== 'active' && branch?.status !== 'paused') {
      return null
    }
    if (!deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now)) return null

    if (branch) {
      if (!deps.branches.transition(branch.id, [branch.status], 'completed', now)) return null
    }

    const target = resolveRunTerminalStatus(deps.branches.listByRun(run.id))
    if (target === null) return null
    if (!deps.runs.transition(run.id, ['running'], target, now)) return null
    return {
      type: target === 'completed' ? 'workflow.completed' : 'workflow.failed',
      runId: run.id,
    }
  })
  if (event) deps.eventSink?.publish(event)
}

/** HumanApproval 入口：进入 waiting_approval、只暂停当前分支、创建 pending 审批。 */
export function enterHumanApproval(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, node } = load(deps, nodeRunId)
  if (node.type !== 'human_approval')
    throw new Error(`node ${node.key} is not a human_approval node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()

  // 进入等待 + 暂停分支 + 建 pending 审批必须原子：否则会出现「等审批但无审批行」。
  transaction(deps.db, () => {
    if (!deps.nodes.transition(nodeRun.id, ['running'], 'waiting_approval', now)) return
    if (nodeRun.branchRunId) deps.branches.pause(nodeRun.branchRunId, 'waiting_approval', now)

    const targetKey = node.config.target.nodeKey
    const targetNode = deps.nodes
      .listByRun(run.id)
      .filter((candidate) => candidate.workflowNodeKey === targetKey)
      .sort((left, right) => right.attempt - left.attempt)[0]
    deps.approvals.requestForNode(nodeRun.id, {
      approvalType: node.config.target.phase,
      targetNodeRunId: targetNode?.id ?? null,
      requestedBy: 'system',
    })
  })
}
