import type { Execution } from '@agentra/protocol'
import type { Database } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkStatus } from '../db/repositories/work-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import type { ApprovalService } from './approval-service'
import {
  type ControlEventSink,
  type ControlNodeDeps,
  completeConditionNode,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
  enterHumanApproval,
  type ReworkTrigger,
} from './control-nodes'
import type { DispatchContext } from './dispatch-gates'
import type { WorkflowExecutionBridge } from './execution-bridge'
import type { WorkflowFairDispatcher } from './fair-dispatcher'
import type { PublishedDefinitionProvider } from './published-definition-provider'
import type { CreateWorkflowRunInput, WorkflowRunService } from './run-service'
import type { WorkflowScheduler } from './scheduler'
import { isTerminalBranchStatus, isTerminalNodeStatus, isTerminalRunStatus } from './state-machine'

export type WorkflowEngineLogger = {
  info?(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export type WorkflowEngineDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  approvals: ApprovalService
  audit?: AuditRepository
  scheduler: WorkflowScheduler
  /** 生产装配使用公平调度器；未提供时退化为单 Run tick。 */
  dispatcher?: WorkflowFairDispatcher
  bridge: WorkflowExecutionBridge
  rework: ReworkTrigger
  runService: WorkflowRunService
  executions: { getNodeRunId(executionId: string): string | null }
  eventSink?: ControlEventSink
  logger?: WorkflowEngineLogger
  /** S55-2B：维护模式门禁；缺省视为 normal（测试/旧装配兼容）。 */
  maintenance?: { isSchedulerAllowed(): boolean }
  /** S55-2B：workflow-kick 在途计数；缺省不跟踪。 */
  drain?: DrainCoordinator
  now?: () => string
}

/**
 * 节点类型分发（S4-7 装配）：
 * - 控制节点同步收尾；
 * - AgentTask 交给执行桥启动真实 Execution；
 * - Execution 终态回来后桥接写节点，再踢一次调度器推进下游。
 *
 * 执行入口仍不暴露 RPC；本类只在 Core 内部使用。
 */
export class WorkflowEngine {
  private readonly controlDeps: ControlNodeDeps
  private readonly now: () => string

  constructor(private readonly deps: WorkflowEngineDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.controlDeps = {
      db: deps.db,
      runs: deps.runs,
      branches: deps.branches,
      nodes: deps.nodes,
      definitions: deps.definitions,
      approvals: deps.approvals,
      ...(deps.audit ? { audit: deps.audit } : {}),
      // S5-1 收尾：审批等待暂停统一走 scheduler.pauseBranch（三档处置 + 单一审计来源），
      // 消除「waiting_approval 直调 Repository」与「pauseBranch」两条暂停路径的分歧。
      branchPause: {
        pause: (runId, branchKey, reason) => deps.scheduler.pauseBranch(runId, branchKey, reason),
      },
      ...(deps.eventSink ? { eventSink: deps.eventSink } : {}),
      reworkTrigger: deps.rework,
      now: this.now,
    }
  }

  /** 内部创建 Run；不暴露 RPC（执行入口仍属后续装配批次）。 */
  createRun(input: CreateWorkflowRunInput) {
    const run = this.deps.runService.createRun(input)
    void this.kick(run.id)
    return run
  }

  /** 生产启动：先原子持久化 Run，再调度；失败保留同一个 Run，重试不重复创建。 */
  async startRun(input: CreateWorkflowRunInput) {
    if (!this.isDispatchAllowed())
      throw new Error('workflow dispatch is unavailable during maintenance')
    const run = this.deps.runService.createRun(input)
    let schedulingError: string | null = null
    try {
      await this.kick(run.id, true)
    } catch {
      schedulingError = '调度未完成；Run 已保存，请按相同请求重试或查看运行状态。'
    }
    return { run: this.deps.runs.get(run.id) ?? run, schedulingError }
  }

  /** WorkService 的事务内级联；不改分支自己的暂停原因，不调用异步进程操作。 */
  syncWorkState(workId: string, to: WorkStatus, now: string): void {
    const runs = this.deps.runs.listByWork(workId).filter((r) => !isTerminalRunStatus(r.status))
    if (to === 'completed' && runs.length)
      throw new Error('Work still has unfinished workflow runs; terminate or finish them first')
    for (const run of runs) {
      if (to === 'paused' && (run.status === 'running' || run.status === 'waiting_human')) {
        this.deps.runs.transition(run.id, [run.status], 'paused', now, {
          runtimeState: { ...run.runtimeState, pausedByWork: true },
        })
      } else if (
        to === 'active' &&
        run.status === 'paused' &&
        run.runtimeState.pausedByWork === true
      ) {
        this.deps.runs.transition(run.id, ['paused'], 'running', now, {
          runtimeState: { ...run.runtimeState, pausedByWork: false },
        })
      } else if (to === 'cancelled') {
        this.deps.runs.transition(run.id, [run.status], 'cancelled', now)
        for (const branch of this.deps.branches.listByRun(run.id)) {
          if (!isTerminalBranchStatus(branch.status))
            this.deps.branches.transition(branch.id, [branch.status], 'cancelled', now)
        }
        for (const node of this.deps.nodes.listByRun(run.id)) {
          if (!isTerminalNodeStatus(node.status))
            this.deps.nodes.transition(node.id, [node.status], 'cancelled', now)
        }
        this.deps.approvals.cancelPendingForRun(run.id, now)
      }
    }
  }

  async onNodeStarted(context: DispatchContext): Promise<void> {
    const nodeRunId = context.nodeRun.id
    this.deps.logger?.info?.('workflow node started', {
      runId: context.run.id,
      branchRunId: context.nodeRun.branchRunId,
      nodeRunId,
      nodeKey: context.node.key,
      nodeType: context.node.type,
    })
    switch (context.node.type) {
      case 'start':
        completeStartNode(this.controlDeps, nodeRunId)
        return
      case 'parallel_split':
        completeSplitNode(this.controlDeps, nodeRunId)
        return
      case 'condition':
        completeConditionNode(this.controlDeps, nodeRunId)
        return
      case 'join':
        completeJoinNode(this.controlDeps, nodeRunId)
        return
      case 'end':
        completeEndNode(this.controlDeps, nodeRunId)
        return
      case 'human_approval':
        await enterHumanApproval(this.controlDeps, nodeRunId)
        return
      case 'agent_task':
        await this.deps.bridge.onNodeStarted(context)
        return
    }
  }

  /** Execution 进入终态：桥接回写节点；若绑定了 NodeRun，再推进该 Run。 */
  onExecutionFinished(execution: Execution): void {
    this.deps.bridge.onExecutionFinished(execution)
    const nodeRunId = this.deps.executions.getNodeRunId(execution.id)
    if (!nodeRunId) return
    const nodeRun = this.deps.nodes.get(nodeRunId)
    if (!nodeRun) return
    this.deps.logger?.info?.('workflow execution finished', {
      executionId: execution.id,
      runId: nodeRun.workflowRunId,
      branchRunId: nodeRun.branchRunId,
      nodeRunId: nodeRun.id,
      nodeKey: nodeRun.workflowNodeKey,
    })
    void this.kick(nodeRun.workflowRunId)
  }

  async kick(runId: string, propagateError = false): Promise<void> {
    if (!this.isDispatchAllowed() || this.deps.runs.get(runId)?.status !== 'running') return
    const lease = this.deps.drain?.acquire('workflow-kick', `kick:${runId}`)
    try {
      if (this.deps.dispatcher) {
        await this.deps.dispatcher.tickAll()
      } else {
        await this.deps.scheduler.runUntilIdle(runId)
      }
    } catch (error) {
      this.deps.logger?.warn('workflow engine tick failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (propagateError) throw error
    } finally {
      lease?.release()
    }
  }

  private isDispatchAllowed(): boolean {
    return !this.deps.maintenance || this.deps.maintenance.isSchedulerAllowed()
  }
}
