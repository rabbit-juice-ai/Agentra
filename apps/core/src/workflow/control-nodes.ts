import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
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
  /** Condition 重新求值为 true：上一轮由它触发的返工完成。 */
  onConditionCompleted?(nodeRunId: string): void
}

/**
 * S5-1：审批等待统一走 pauseBranch 的处置语义（QA 复验指出的两条暂停路径）。
 * pauseBranch 包含三档 Provider 处置 + 审计；未接线时退化为 Repository 直调（旧行为）。
 */
export type BranchPausePort = {
  pause(runId: string, branchKey: string, reason: string): Promise<boolean> | boolean
}

export type ControlNodeDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  approvals: ApprovalService
  audit?: AuditRepository
  branchPause?: BranchPausePort
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

/** Start 运行时：无副作用，直接把 running 收尾为 succeeded。 */
export function completeStartNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, node } = load(deps, nodeRunId)
  if (node.type !== 'start') throw new Error(`node ${node.key} is not a start node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()
  deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now)
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

  let triggerRework = false
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
      triggerRework = true
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

  const succeeded = deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now, {
    outputSnapshot: { when: result.value },
  })
  if (!succeeded) return
  if (result.value) {
    // 返工后 Condition 再次求值为 true：此时本轮返工才算完成。
    deps.reworkTrigger?.onConditionCompleted?.(nodeRun.id)
    return
  }
  if (triggerRework) {
    // 先让 Condition 自身进入 succeeded，再重置「target → Condition」区域；
    // 否则 Condition 仍处于 running，返工无法为它创建新 attempt。
    const falseBranch = node.config.falseBranch
    if (typeof falseBranch === 'object' && falseBranch.kind === 'rework') {
      deps.reworkTrigger?.request({
        runId: run.id,
        nodeRunId: nodeRun.id,
        nodeKey: node.key,
        reportNodeKey: falseBranch.reportNodeKey,
      })
    }
  }
}

/** ParallelSplit 运行时：split 成功时激活各分支（ensureBranchRuns 只建 blocked）。 */
export function completeSplitNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, definition, node } = load(deps, nodeRunId)
  if (node.type !== 'parallel_split')
    throw new Error(`node ${node.key} is not a parallel_split node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()

  transaction(deps.db, () => {
    if (!deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now)) return
    const branchEdges = definition.edges.filter(
      (edge) => edge.source === node.key && edge.branchKey !== undefined,
    )
    for (const edge of branchEdges) {
      const branch = deps.branches.getByKey(run.id, `${node.key}/${edge.branchKey}`)
      if (branch?.status === 'blocked') {
        deps.branches.transition(branch.id, ['blocked'], 'active', now)
      }
    }
  })
}

/** Join 运行时：任一入边源 failed/cancelled → join failed；全部 succeeded 才放行。 */
export function completeJoinNode(deps: ControlNodeDeps, nodeRunId: string): void {
  const { nodeRun, run, definition, node } = load(deps, nodeRunId)
  if (node.type !== 'join') throw new Error(`node ${node.key} is not a join node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()
  const states = latestStates(deps, run.id)
  const incoming = definition.edges.filter((edge) => edge.target === node.key)
  const sources = incoming.map((edge) => edge.source)

  const failedSources = sources.filter((source) => {
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

  const allSucceeded = sources.every((source) => states.get(source)?.status === 'succeeded')
  const allDisposed = sources.every((source) => {
    const status = states.get(source)?.status
    return status === 'succeeded' || status === 'skipped'
  })
  if (!allDisposed) return

  // F-1：join 成功即代表该 split 的全部支线都走到了 join，分支任务完成。
  // 与 join 迁移同事务，避免「join succeeded 但分支仍 active」的中间态。
  transaction(deps.db, () => {
    if (
      !deps.nodes.transition(nodeRun.id, ['running'], allSucceeded ? 'succeeded' : 'skipped', now)
    ) {
      return
    }
    if (!allSucceeded) return
    const splitKey = node.config.pairWith
    for (const branch of deps.branches.listByRun(run.id)) {
      if (!branch.branchKey.startsWith(`${splitKey}/`)) continue
      if (branch.status !== 'active' && branch.status !== 'paused') continue
      deps.branches.transition(branch.id, [branch.status], 'completed', now)
    }
  })
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
export async function enterHumanApproval(deps: ControlNodeDeps, nodeRunId: string): Promise<void> {
  const { nodeRun, run, node } = load(deps, nodeRunId)
  if (node.type !== 'human_approval')
    throw new Error(`node ${node.key} is not a human_approval node`)
  const now = (deps.now ?? (() => new Date().toISOString()))()

  // 进入等待 + 建 pending 审批必须原子：否则会出现「等审批但无审批行」。
  // 分支暂停统一走 branchPause（scheduler.pauseBranch，含三档处置与审计）；
  // pauseBranch 内部先 CAS 状态再处置执行，与本事务的顺序保证一致（状态先落）。
  const branch = nodeRun.branchRunId ? deps.branches.get(nodeRun.branchRunId) : null
  const pendingPause =
    branch && deps.branchPause
      ? Promise.resolve(deps.branchPause.pause(run.id, branch.branchKey, 'waiting_approval'))
      : null
  transaction(deps.db, () => {
    if (!deps.nodes.transition(nodeRun.id, ['running'], 'waiting_approval', now)) return
    if (nodeRun.branchRunId && !deps.branchPause) {
      const branch = deps.branches.get(nodeRun.branchRunId)
      if (deps.branches.pause(nodeRun.branchRunId, 'waiting_approval', now)) {
        deps.audit?.append({
          actorType: 'system',
          actorId: null,
          action: 'workflow.branch.paused',
          targetType: 'branch_run',
          targetId: nodeRun.branchRunId,
          details: {
            runId: run.id,
            branchKey: branch?.branchKey ?? null,
            reason: 'waiting_approval',
            nodeRunId: nodeRun.id,
            from: 'active',
            to: 'paused',
          },
          now,
        })
      }
    }

    const targetKey = node.config.target.nodeKey
    const targetNode = deps.nodes
      .listByRun(run.id)
      .filter((candidate) => candidate.workflowNodeKey === targetKey)
      .sort((left, right) => right.attempt - left.attempt)[0]
    deps.approvals.requestForNode(nodeRun.id, {
      approvalType: node.config.target.phase,
      // DATABASE §2.7：before_execute 决策发生时任务尚未执行，target_node_run_id 必须为 NULL；
      // 只有 after_execute 才指向被审任务的最新 attempt。
      targetNodeRunId:
        node.config.target.phase === 'after_execute' ? (targetNode?.id ?? null) : null,
      requestedBy: 'system',
    })
  })
  if (pendingPause) await pendingPause
}
