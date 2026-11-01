import type { Execution } from '@agentra/protocol'
import type { Database } from '../db/database'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
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
import type { PublishedDefinitionProvider } from './published-definition-provider'
import type { CreateWorkflowRunInput, WorkflowRunService } from './run-service'
import type { WorkflowScheduler } from './scheduler'

export type WorkflowEngineLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

export type WorkflowEngineDeps = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  approvals: ApprovalService
  scheduler: WorkflowScheduler
  bridge: WorkflowExecutionBridge
  rework: ReworkTrigger
  runService: WorkflowRunService
  executions: { getNodeRunId(executionId: string): string | null }
  eventSink?: ControlEventSink
  logger?: WorkflowEngineLogger
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
      ...(deps.eventSink ? { eventSink: deps.eventSink } : {}),
      reworkTrigger: deps.rework,
      now: this.now,
    }
  }

  /** 内部创建 Run；不暴露 RPC（执行入口仍属后续装配批次）。 */
  createRun(input: CreateWorkflowRunInput) {
    return this.deps.runService.createRun(input)
  }

  async onNodeStarted(context: DispatchContext): Promise<void> {
    const nodeRunId = context.nodeRun.id
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
        enterHumanApproval(this.controlDeps, nodeRunId)
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
    void this.kick(nodeRun.workflowRunId)
  }

  async kick(runId: string): Promise<void> {
    try {
      await this.deps.scheduler.runUntilIdle(runId)
    } catch (error) {
      this.deps.logger?.warn('workflow engine tick failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
