import { newId } from '@agentra/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { ApprovalRepository } from '../db/repositories/approval-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  ReworkRequestRecord,
  ReworkRequestRepository,
} from '../db/repositories/rework-request-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import { buildGraph } from './graph'
import type { PublishedDefinitionProvider } from './published-definition-provider'

export type ReworkPolicyErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_REPORT'
  | 'SCOPE_NOT_REACHABLE'
  | 'SCOPE_BUSY'

export class ReworkPolicyError extends Error {
  constructor(
    readonly code: ReworkPolicyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ReworkPolicyError'
  }
}

export type ReworkEventType =
  | 'rework.requested'
  | 'rework.started'
  | 'rework.completed'
  | 'rework.exhausted'

export type ReworkEvent = {
  type: ReworkEventType
  runId: string
  reworkRequestId: string
  targetNodeKey: string
  round: number
}

export type ReworkEventSink = {
  publish(event: ReworkEvent): void
}

export type ReworkServiceDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  reworks: ReworkRequestRepository
  approvals: ApprovalRepository
  definitions: PublishedDefinitionProvider
  audit?: AuditRepository
  events?: ReworkEventSink
  now?: () => string
}

export type ReworkActor = { type: 'user' | 'agent' | 'system'; id?: string }

type RequestOneInput = {
  run: WorkflowRunRecord
  definition: WorkflowDefinition
  targetNode: NodeRunRecord
  targetNodeKey: string
  triggerType: 'request_changes' | 'test_failure'
  triggerApprovalId: string | null
  testReport: Record<string, unknown> | null
  createdBy: 'system' | 'approval' | 'user'
  actor: ReworkActor
}

function latestAttempt(nodes: NodeRunRepository, runId: string, key: string): NodeRunRecord | null {
  const attempts = nodes.listByRunAndKey(runId, key)
  return attempts.length === 0 ? null : (attempts[attempts.length - 1] as NodeRunRecord)
}

/**
 * 返工目标必须是「被返工任务的原始 NodeRun」，不能取 rework 自己刚创建的 blocked attempt。
 * 因此测试报告触发时选最新一个**已终态**的 attempt（succeeded/failed/cancelled）。
 */
function latestTerminalAttempt(
  nodes: NodeRunRepository,
  runId: string,
  key: string,
): NodeRunRecord | null {
  const attempts = nodes.listByRunAndKey(runId, key)
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (attempt && ['succeeded', 'failed', 'cancelled'].includes(attempt.status)) return attempt
  }
  return null
}

function reachableFrom(definition: WorkflowDefinition, from: string): Set<string> {
  const graph = buildGraph(definition)
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    for (const edge of graph.out.get(key) ?? []) queue.push(edge.target)
  }
  return seen
}

function canReach(definition: WorkflowDefinition, from: string, to: string): boolean {
  return reachableFrom(definition, from).has(to)
}

/** 从 target 到 scopeEnd 之间（含 scopeEnd、不含 target）的全部节点，按定义顺序。 */
function nodesBetween(
  definition: WorkflowDefinition,
  targetKey: string,
  scopeEndKey: string,
): WorkflowNode[] {
  const graph = buildGraph(definition)
  const forward = reachableFrom(definition, targetKey)
  const backward = new Set<string>()
  const queue = [scopeEndKey]
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined || backward.has(key)) continue
    backward.add(key)
    for (const edge of graph.inn.get(key) ?? []) queue.push(edge.source)
  }
  return definition.nodes.filter(
    (node) => node.key !== targetKey && forward.has(node.key) && backward.has(node.key),
  )
}

function scopeEndOf(request: ReworkRequestRecord, approvalNodeKey: string | null): string | null {
  const fromReport = request.testReport?.scopeEndNodeKey
  if (typeof fromReport === 'string') return fromReport
  return approvalNodeKey
}

/**
 * ReworkPolicy（WORKFLOW §10.2 / DATABASE §2.7.1）。
 *
 * 触发源：结构化测试报告 pass=false，或 HumanApproval 的 request_changes 决策。
 * 状态机：requested → in_rework → completed｜cancelled｜exhausted。
 * 轮次按 target NodeRun 统计，unique(target_node_run_id, round) 是幂等键。
 *
 * 事务约定：`requestForTestFailure` / `onTestResult` / `onApprovalReentered` 自己开事务；
 * `requestForApprovalChange` 由 ApprovalService.decide 在既有事务内调用（不嵌套 BEGIN）。
 */
export class ReworkService {
  private readonly now: () => string

  constructor(private readonly deps: ReworkServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** 结构化测试报告入口：pass=false 时按 relatedTasks 创建并启动返工。 */
  requestForTestFailure(input: {
    runId: string
    reportNodeRunId: string
    reportNodeKey: string
    report: Record<string, unknown>
    scopeEndNodeKey?: string
  }): ReworkRequestRecord[] {
    const events: ReworkEvent[] = []
    const result = transaction(this.deps.db, () =>
      this.requestForTestFailureInTransaction(input, events),
    )
    this.publish(events)
    return result
  }

  private requestForTestFailureInTransaction(
    input: {
      runId: string
      reportNodeRunId: string
      reportNodeKey: string
      report: Record<string, unknown>
      scopeEndNodeKey?: string
    },
    events?: ReworkEvent[],
  ): ReworkRequestRecord[] {
    if (input.report.pass !== false) return []
    const run = this.requireRun(input.runId)
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const reportNode = definition.nodes.find((node) => node.key === input.reportNodeKey)
    if (
      reportNode === undefined ||
      reportNode.type !== 'agent_task' ||
      reportNode.config.outputContract.profile !== 'test_result'
    ) {
      throw new ReworkPolicyError(
        'INVALID_REPORT',
        `node ${input.reportNodeKey} is not an agent_task with a test_result output contract`,
      )
    }

    const scopeEndNodeKey = input.scopeEndNodeKey ?? input.reportNodeKey
    const related = Array.isArray(input.report.relatedTasks)
      ? input.report.relatedTasks.filter((item): item is string => typeof item === 'string')
      : []
    const targets = related.filter((key) => {
      const node = definition.nodes.find((candidate) => candidate.key === key)
      return node?.type === 'agent_task' && canReach(definition, key, scopeEndNodeKey)
    })

    const created: ReworkRequestRecord[] = []
    for (const targetKey of targets) {
      const targetNode = this.targetNodeForTask(run.id, targetKey)
      if (!targetNode) continue
      const report = {
        ...input.report,
        reportNodeKey: input.reportNodeKey,
        scopeEndNodeKey,
      }
      const record = this.requestOne(
        {
          run,
          definition,
          targetNode,
          targetNodeKey: targetKey,
          triggerType: 'test_failure',
          triggerApprovalId: null,
          testReport: report,
          createdBy: 'system',
          actor: { type: 'system' },
        },
        events,
      )
      created.push(record)
    }
    return created
  }

  /**
   * request_changes 入口：由 ApprovalService.decide 在既有事务内调用。
   * before_execute 没有已执行的目标 NodeRun，无法定位返工对象，返回 null。
   */
  requestForApprovalChange(input: {
    runId: string
    approvalId: string
    approvalNodeRunId: string
    targetNodeRunId: string | null
    decidedBy?: string
  }): ReworkRequestRecord | null {
    if (input.targetNodeRunId === null) return null
    const run = this.requireRun(input.runId)
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const requestedTarget = this.deps.nodes.get(input.targetNodeRunId)
    if (!requestedTarget) {
      throw new ReworkPolicyError('NOT_FOUND', 'rework target node run not found')
    }
    // 目标取该任务最新一个已终态的 attempt；round 由 nextRoundForTask 跨 attempt 累计，
    // 因此重试产生新 attempt 不会把轮次重置为 1。
    const targetNode =
      this.targetNodeForTask(run.id, requestedTarget.workflowNodeKey) ?? requestedTarget
    const approvalNodeRun = this.deps.nodes.get(input.approvalNodeRunId)
    if (!approvalNodeRun) {
      throw new ReworkPolicyError('NOT_FOUND', 'approval node run not found')
    }

    const record = this.requestOne({
      run,
      definition,
      targetNode,
      targetNodeKey: targetNode.workflowNodeKey,
      triggerType: 'request_changes',
      triggerApprovalId: input.approvalId,
      testReport: null,
      createdBy: 'approval',
      actor: input.decidedBy ? { type: 'user', id: input.decidedBy } : { type: 'system' },
    })
    if (record.status === 'in_rework' || record.status === 'requested') {
      this.deps.approvals.linkReworkRequest(input.approvalId, record.id)
    }
    return record
  }

  /**
   * Condition falseBranch=rework 的触发接缝：按 reportNodeKey 的最新结构化报告创建返工。
   * scopeEnd 是 Condition 自己——返工后 Condition 必须重新求值。
   */
  request(input: {
    runId: string
    nodeRunId: string
    nodeKey: string
    reportNodeKey: string
  }): void {
    const events: ReworkEvent[] = []
    transaction(this.deps.db, () => {
      // 条件再次为 false = 上一轮返工没有修好；先收尾上一轮，再开下一轮。
      this.completeForScopeInTransaction(input.runId, input.nodeKey, events)
      const reportNode = latestTerminalAttempt(this.deps.nodes, input.runId, input.reportNodeKey)
      if (!reportNode || reportNode.outputSnapshot === null) {
        throw new ReworkPolicyError(
          'INVALID_REPORT',
          `condition ${input.nodeKey} cannot find a structured report on ${input.reportNodeKey}`,
        )
      }
      this.requestForTestFailureInTransaction({
        runId: input.runId,
        reportNodeRunId: reportNode.id,
        reportNodeKey: input.reportNodeKey,
        report: reportNode.outputSnapshot,
        scopeEndNodeKey: input.nodeKey,
      })
    })
    this.publish(events)
  }

  /** Condition 重新求值为 true：完成它触发的返工。 */
  onConditionCompleted(nodeRunId: string): void {
    const nodeRun = this.deps.nodes.get(nodeRunId)
    if (!nodeRun) return
    const events: ReworkEvent[] = []
    this.completeForScopeInTransaction(nodeRun.workflowRunId, nodeRun.workflowNodeKey, events)
    this.publish(events)
  }

  /** 测试节点完成：先收尾本轮返工，再按最新报告决定是否开启下一轮。 */
  onTestResult(input: {
    runId: string
    reportNodeRunId: string
    reportNodeKey: string
    output: Record<string, unknown>
  }): { completed: string[]; requested: string[] } {
    const events: ReworkEvent[] = []
    const result = transaction(this.deps.db, () => {
      const completed = this.completeForScopeInTransaction(input.runId, input.reportNodeKey, events)
      const requested =
        input.output.pass === false
          ? this.requestForTestFailureInTransaction({
              runId: input.runId,
              reportNodeRunId: input.reportNodeRunId,
              reportNodeKey: input.reportNodeKey,
              report: input.output,
              scopeEndNodeKey: input.reportNodeKey,
            })
          : []
      return { completed, requested: requested.map((record) => record.id) }
    })
    this.publish(events)
    return result
  }

  /** 审批节点重新进入等待：request_changes 触发的返工到此完成。 */
  onApprovalReentered(nodeRunId: string): string[] {
    const nodeRun = this.deps.nodes.get(nodeRunId)
    if (!nodeRun) return []
    const events: ReworkEvent[] = []
    const completed = this.completeForScopeInTransaction(
      nodeRun.workflowRunId,
      nodeRun.workflowNodeKey,
      events,
    )
    this.publish(events)
    return completed
  }

  /** 启动返工：requested → in_rework，并为 target 及必要下游创建新 attempt。 */
  start(requestId: string, scopeEndNodeKey?: string): ReworkRequestRecord {
    const events: ReworkEvent[] = []
    const result = transaction(this.deps.db, () =>
      this.startInTransaction(requestId, scopeEndNodeKey, events),
    )
    this.publish(events)
    return result
  }

  /** 由既有事务调用（ApprovalService 内部）。 */
  startInTransaction(
    requestId: string,
    scopeEndNodeKey?: string,
    events?: ReworkEvent[],
  ): ReworkRequestRecord {
    const request = this.requireRequest(requestId)
    if (request.status === 'in_rework') return request
    if (request.status !== 'requested') {
      throw new ReworkPolicyError(
        'INVALID_STATE',
        `rework request ${requestId} is ${request.status}, cannot start`,
      )
    }
    const run = this.requireRun(request.workflowRunId)
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const targetNode = this.deps.nodes.get(request.targetNodeRunId)
    if (!targetNode) throw new ReworkPolicyError('NOT_FOUND', 'rework target node run not found')

    const approvalNodeKey = request.triggerApprovalId
      ? this.approvalNodeKey(request.triggerApprovalId)
      : null
    const scopeEnd = scopeEndNodeKey ?? scopeEndOf(request, approvalNodeKey)
    if (scopeEnd === null) {
      throw new ReworkPolicyError('INVALID_REPORT', 'rework request has no scope end node')
    }
    if (!canReach(definition, targetNode.workflowNodeKey, scopeEnd)) {
      throw new ReworkPolicyError(
        'SCOPE_NOT_REACHABLE',
        `scope end ${scopeEnd} is not reachable from ${targetNode.workflowNodeKey}`,
      )
    }

    const region = nodesBetween(definition, targetNode.workflowNodeKey, scopeEnd)
    const now = this.now()
    const branchMap = new Map<string, string | null>()

    const targetAttempt = this.createNextAttempt(
      run.id,
      targetNode,
      now,
      this.reworkBranch(targetNode.branchRunId, request, now, branchMap),
    )
    for (const node of region) {
      const latest = latestAttempt(this.deps.nodes, run.id, node.key)
      if (!latest) continue
      this.createNextAttempt(
        run.id,
        latest,
        now,
        this.reworkBranch(latest.branchRunId, request, now, branchMap),
      )
    }

    this.deps.reworks.linkReworkNodeRun(request.id, targetAttempt.id, now)
    if (!this.deps.reworks.transition(request.id, ['requested'], 'in_rework', now)) {
      throw new ReworkPolicyError(
        'INVALID_STATE',
        `rework request ${requestId} changed concurrently`,
      )
    }
    this.auditAction(
      'workflow.rework.started',
      request,
      { type: 'system' },
      {
        targetNodeKey: targetNode.workflowNodeKey,
      },
    )
    this.emit(
      {
        type: 'rework.started',
        runId: run.id,
        reworkRequestId: request.id,
        targetNodeKey: targetNode.workflowNodeKey,
        round: request.round,
      },
      events,
    )
    return this.requireRequest(request.id)
  }

  finish(
    requestId: string,
    status: Extract<ReworkRequestRecord['status'], 'completed' | 'cancelled' | 'exhausted'>,
  ): ReworkRequestRecord {
    return transaction(this.deps.db, () => {
      const request = this.requireRequest(requestId)
      if (!this.deps.reworks.transition(requestId, [request.status], status, this.now())) {
        throw new ReworkPolicyError(
          'INVALID_STATE',
          `rework request ${requestId} changed concurrently`,
        )
      }
      return this.requireRequest(requestId)
    })
  }

  /**
   * 老板显式「继续返工」：在已超限请求之后创建下一轮，并立即启动。
   * 轮次上限按最新请求的 maxRounds 递增，后续 requestOne 会采用较大的上限。
   */
  continueExhausted(requestId: string, actor: ReworkActor, extraRounds = 1): ReworkRequestRecord {
    if (!Number.isInteger(extraRounds) || extraRounds < 1 || extraRounds > 10) {
      throw new ReworkPolicyError('INVALID_STATE', 'extraRounds must be an integer in [1, 10]')
    }
    const request = this.requireRequest(requestId)
    if (request.status !== 'exhausted') {
      // 幂等：已经有人继续过，直接返回正在进行的请求。
      const latest = this.deps.reworks.latestByTarget(request.targetNodeRunId)
      if (latest && (latest.status === 'requested' || latest.status === 'in_rework')) return latest
      throw new ReworkPolicyError(
        'INVALID_STATE',
        `rework request ${requestId} is ${request.status}, cannot continue`,
      )
    }
    const targetNode = this.deps.nodes.get(request.targetNodeRunId)
    if (!targetNode) throw new ReworkPolicyError('NOT_FOUND', 'rework target node run not found')
    const now = this.now()
    const created = this.deps.reworks.create(
      {
        id: newId('rwk'),
        workflowRunId: request.workflowRunId,
        branchRunId: request.branchRunId,
        targetNodeRunId: request.targetNodeRunId,
        triggerType: request.triggerType,
        triggerApprovalId: request.triggerApprovalId,
        testReport: request.testReport,
        round: request.round + 1,
        maxRounds: request.maxRounds + extraRounds,
        status: 'requested',
        createdBy: 'user',
      },
      now,
    )
    this.auditAction('workflow.rework.continued', created, actor, {
      fromRound: request.round,
      extraRounds,
    })
    this.deps.events?.publish({
      type: 'rework.requested',
      runId: created.workflowRunId,
      reworkRequestId: created.id,
      targetNodeKey: targetNode.workflowNodeKey,
      round: created.round,
    })
    return this.start(created.id)
  }

  /**
   * 老板接管：记录接管审计，分支保持暂停，后续由人工处理。
   * exhausted 是状态机终态，不伪造 cancelled；接管是人工确认，不改变自动返工记录。
   */
  takeOverExhausted(requestId: string, actor: ReworkActor): ReworkRequestRecord {
    const request = this.requireRequest(requestId)
    if (request.status !== 'exhausted') {
      throw new ReworkPolicyError(
        'INVALID_STATE',
        `rework request ${requestId} is ${request.status}, cannot take over`,
      )
    }
    this.auditAction('workflow.rework.taken_over', request, actor, {})
    return request
  }

  private requestOne(input: RequestOneInput, events?: ReworkEvent[]): ReworkRequestRecord {
    const latest = this.deps.reworks.latestByTarget(input.targetNode.id)
    // 老板可以显式「继续返工」提高该任务的轮次上限；取定义值与最新请求上限的较大者。
    const maxRounds = Math.max(
      input.definition.settings.reworkPolicy.maxRounds,
      latest?.maxRounds ?? 0,
    )
    if (latest && (latest.status === 'requested' || latest.status === 'in_rework')) return latest
    if (latest && latest.status === 'exhausted') return latest

    // 该任务已有更新的一轮在跑（新 attempt 尚未终态）时，不允许对旧报告再开新一轮。
    const newest = latestAttempt(this.deps.nodes, input.run.id, input.targetNodeKey)
    if (
      newest &&
      newest.id !== input.targetNode.id &&
      ['blocked', 'ready', 'running', 'waiting_approval'].includes(newest.status)
    ) {
      if (latest) return latest
      throw new ReworkPolicyError(
        'INVALID_STATE',
        `task ${input.targetNodeKey} has a newer attempt in progress but no rework record`,
      )
    }

    // round 按「被返工任务」累计，而不是按某一条 NodeRun：返工后重测会产生新 attempt，
    // 若按 target NodeRun 计数会从 1 重新开始。unique(target_node_run_id, round) 仍是幂等键。
    const round = this.nextRoundForTask(input.run.id, input.targetNodeKey)
    if (round > maxRounds) {
      const exhausted = this.deps.reworks.create(
        {
          id: newId('rwk'),
          workflowRunId: input.run.id,
          branchRunId: input.targetNode.branchRunId,
          targetNodeRunId: input.targetNode.id,
          triggerType: input.triggerType,
          triggerApprovalId: input.triggerApprovalId,
          testReport: input.testReport,
          round,
          maxRounds,
          status: 'exhausted',
          createdBy: input.createdBy,
        },
        this.now(),
      )
      this.pauseBranchForExhaustion(input.targetNode.branchRunId, exhausted, input.actor)
      this.auditAction('workflow.rework.exhausted', exhausted, input.actor, {
        targetNodeKey: input.targetNodeKey,
      })
      this.emit(
        {
          type: 'rework.exhausted',
          runId: input.run.id,
          reworkRequestId: exhausted.id,
          targetNodeKey: input.targetNodeKey,
          round,
        },
        events,
      )
      return exhausted
    }

    const created = this.deps.reworks.create(
      {
        id: newId('rwk'),
        workflowRunId: input.run.id,
        branchRunId: input.targetNode.branchRunId,
        targetNodeRunId: input.targetNode.id,
        triggerType: input.triggerType,
        triggerApprovalId: input.triggerApprovalId,
        testReport: input.testReport,
        round,
        maxRounds,
        createdBy: input.createdBy,
      },
      this.now(),
    )
    this.auditAction('workflow.rework.requested', created, input.actor, {
      targetNodeKey: input.targetNodeKey,
    })
    this.emit(
      {
        type: 'rework.requested',
        runId: input.run.id,
        reworkRequestId: created.id,
        targetNodeKey: input.targetNodeKey,
        round,
      },
      events,
    )
    return this.startInTransaction(created.id, undefined, events)
  }

  private completeForScopeInTransaction(
    runId: string,
    scopeEndNodeKey: string,
    events: ReworkEvent[],
  ): string[] {
    const completed: string[] = []
    for (const request of this.deps.reworks.listByRun(runId)) {
      if (request.status !== 'in_rework') continue
      if (scopeEndOf(request, this.approvalNodeKeyOrNull(request)) !== scopeEndNodeKey) continue
      if (!this.deps.reworks.transition(request.id, ['in_rework'], 'completed', this.now()))
        continue
      completed.push(request.id)
      this.auditAction('workflow.rework.completed', request, { type: 'system' })
      events.push({
        type: 'rework.completed',
        runId,
        reworkRequestId: request.id,
        targetNodeKey: request.targetNodeRunId,
        round: request.round,
      })
    }
    return completed
  }

  /** 返工目标取该任务最新一个已终态的 NodeRun attempt（即真正失败/待返工的那次执行）。 */
  private targetNodeForTask(runId: string, targetKey: string): NodeRunRecord | null {
    return latestTerminalAttempt(this.deps.nodes, runId, targetKey)
  }

  /** 同一任务的轮次跨 NodeRun attempt 累计。 */
  private nextRoundForTask(runId: string, targetKey: string): number {
    let max = 0
    for (const request of this.deps.reworks.listByRun(runId)) {
      const target = this.deps.nodes.get(request.targetNodeRunId)
      if (target?.workflowNodeKey === targetKey) max = Math.max(max, request.round)
    }
    return max + 1
  }

  private createNextAttempt(
    runId: string,
    current: NodeRunRecord,
    now: string,
    branchRunId: string | null = current.branchRunId,
  ): NodeRunRecord {
    if (
      current.status === 'running' ||
      current.status === 'ready' ||
      current.status === 'waiting_approval'
    ) {
      throw new ReworkPolicyError(
        'SCOPE_BUSY',
        `node ${current.workflowNodeKey} is ${current.status}; cannot start rework`,
      )
    }
    return this.deps.nodes.create(
      {
        id: newId('nrn'),
        workflowRunId: runId,
        workflowNodeKey: current.workflowNodeKey,
        branchRunId,
        status: 'blocked',
        attempt: current.attempt + 1,
        inputSnapshot: current.inputSnapshot,
      },
      now,
    )
  }

  /**
   * 返工分支：active 直接复用、paused/blocked 恢复；completed/failed/cancelled 不能原地重开，
   * 因此创建一个带后缀的新 BranchRun（同 run 内 branchKey 唯一）。这样 F-1 的分支终结语义
   * 不被破坏，而参考模板「Join 之后 Testing 失败 → 返工分支内任务」仍可执行。
   */
  private reworkBranch(
    branchRunId: string | null,
    request: ReworkRequestRecord,
    now: string,
    cache: Map<string, string | null>,
  ): string | null {
    if (branchRunId === null) return null
    const cached = cache.get(branchRunId)
    if (cached !== undefined) return cached
    const branch = this.deps.branches.get(branchRunId)
    if (!branch) return null

    let resultId: string
    if (branch.status === 'active') {
      resultId = branch.id
    } else if (branch.status === 'paused') {
      this.deps.branches.resume(branch.id, now)
      this.auditAction(
        'workflow.branch.resumed',
        request,
        { type: 'system' },
        {
          branchKey: branch.branchKey,
        },
      )
      resultId = branch.id
    } else if (branch.status === 'blocked') {
      this.deps.branches.transition(branch.id, ['blocked'], 'active', now)
      this.auditAction(
        'workflow.branch.activated',
        request,
        { type: 'system' },
        {
          branchKey: branch.branchKey,
        },
      )
      resultId = branch.id
    } else {
      const suffix = `${request.round}-${request.id.slice(-8)}`
      const created = this.deps.branches.create(
        {
          id: newId('brn'),
          workflowRunId: branch.workflowRunId,
          branchKey: `${branch.branchKey}#rwk-${suffix}`,
          status: 'active',
        },
        now,
      )
      resultId = created.id
    }
    cache.set(branchRunId, resultId)
    return resultId
  }

  private pauseBranchForExhaustion(
    branchRunId: string | null,
    request: ReworkRequestRecord,
    actor: ReworkActor,
  ): void {
    if (branchRunId === null) return
    const branch = this.deps.branches.get(branchRunId)
    if (branch?.status !== 'active') return
    if (!this.deps.branches.pause(branch.id, 'rework_exhausted', this.now())) return
    this.deps.audit?.append({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'workflow.branch.paused',
      targetType: 'branch_run',
      targetId: branch.id,
      details: {
        runId: request.workflowRunId,
        branchKey: branch.branchKey,
        reason: 'rework_exhausted',
        reworkRequestId: request.id,
        from: 'active',
        to: 'paused',
      },
      now: this.now(),
    })
  }

  private auditAction(
    action: string,
    request: ReworkRequestRecord,
    actor: ReworkActor,
    extra: Record<string, unknown> = {},
  ): void {
    this.deps.audit?.append({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action,
      targetType: 'rework_request',
      targetId: request.id,
      details: {
        runId: request.workflowRunId,
        branchRunId: request.branchRunId,
        targetNodeRunId: request.targetNodeRunId,
        round: request.round,
        triggerType: request.triggerType,
        ...extra,
      },
      now: this.now(),
    })
  }

  private approvalNodeKey(approvalId: string): string | null {
    const approval = this.deps.approvals.get(approvalId)
    if (!approval) return null
    return this.deps.nodes.get(approval.nodeRunId)?.workflowNodeKey ?? null
  }

  private approvalNodeKeyOrNull(request: ReworkRequestRecord): string | null {
    return request.triggerApprovalId ? this.approvalNodeKey(request.triggerApprovalId) : null
  }

  private requireRun(runId: string): WorkflowRunRecord {
    const run = this.deps.runs.get(runId)
    if (!run) throw new ReworkPolicyError('NOT_FOUND', `workflow run ${runId} not found`)
    return run
  }

  private requireRequest(id: string): ReworkRequestRecord {
    const request = this.deps.reworks.get(id)
    if (!request) throw new ReworkPolicyError('NOT_FOUND', `rework request ${id} not found`)
    return request
  }

  private emit(event: ReworkEvent, events?: ReworkEvent[]): void {
    if (events) {
      events.push(event)
      return
    }
    this.deps.events?.publish(event)
  }

  private publish(events: ReworkEvent[]): void {
    for (const event of events) this.emit(event)
  }
}
