import type { Execution } from '@agentra/protocol'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import {
  type ExecutionRepository,
  isTerminalExecutionState,
} from '../db/repositories/execution-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { WorkflowFairDispatcher } from './fair-dispatcher'
import type { WorkflowScheduler } from './scheduler'

export type RecoveryLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

export type RecoveryReport = {
  runs: number
  branches: number
  nodesMarkedReconciliationRequired: { nodeRunId: string; nodeKey: string; runId: string }[]
  runsMarkedReconciliationRequired: string[]
  runsKicked: string[]
}

/**
 * S55-2B-1B：恢复选项。
 * - daemonAvailable=false（A4）：所有带非终态 Execution 的 running 节点标
 *   reconciliation_required，受影响 WorkflowRun 一并标记，全程禁 kick。
 * - unconfirmedExecutionIds（A3）：Daemon 明确查不到记录的活跃执行集合，
 *   其节点同样标 reconciliation_required（run 保持 running，W2 部分隔离）。
 */
export type RecoveryOptions = {
  daemonAvailable: boolean
  unconfirmedExecutionIds?: ReadonlySet<string>
  /** S55-2C：Restore 启动恢复禁止自动 kick（v17：不自动 dispatch）。 */
  allowKick?: boolean
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
 * Workflow 层启动恢复（S4-7）。
 *
 * - node running 但没有任何非终态 Execution → reconciliation_required（不自动重跑副作用任务）；
 * - node ready → 交给 scheduler 重新入队；
 * - 只有 run=running 才推进调度；paused / waiting_human / reconciliation_required 只加载不改写。
 *
 * 必须在 ExecutionService.reconcile() 之后调用：崩溃执行先由执行层补记账并通知桥接，
 * 这里再处理「没有执行可对账」的残留 running 节点。
 */
export class WorkflowRecoveryService {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly branches: BranchRunRepository,
    private readonly nodes: NodeRunRepository,
    private readonly executions: ExecutionRepository,
    private readonly scheduler: WorkflowScheduler,
    private readonly onExecutionFinished?: (execution: Execution) => void,
    private readonly logger?: RecoveryLogger,
    private readonly dispatcher?: WorkflowFairDispatcher,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async recover(options: RecoveryOptions = { daemonAvailable: true }): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      runs: 0,
      branches: 0,
      nodesMarkedReconciliationRequired: [],
      runsMarkedReconciliationRequired: [],
      runsKicked: [],
    }
    for (const run of this.runs.listUnfinished()) {
      report.runs += 1
      report.branches += this.branches.listByRun(run.id).length
      const latest = latestAttempts(this.nodes.listByRun(run.id))
      let markedThisRun = false
      for (const node of latest.values()) {
        if (node.status !== 'running') continue
        const active = this.executions.findActiveByNodeRun(node.id)
        if (active) {
          // S55-2B-1B（A3/A4）：Daemon 不可用，或执行证据不可确认 → 节点待人工对账。
          // 不判 crashed、不自动重跑副作用任务。
          if (
            !options.daemonAvailable ||
            options.unconfirmedExecutionIds?.has(active.id) === true
          ) {
            if (this.markReconciliationRequired(node, run.id, report)) markedThisRun = true
          }
          continue
        }

        // 执行已终态但节点没记账（进程在两者之间被杀）：先补记账，不标 reconciliation。
        const latestExecution = this.executions.findLatestByNodeRun(node.id)
        if (
          latestExecution &&
          isTerminalExecutionState(latestExecution.status) &&
          this.onExecutionFinished
        ) {
          try {
            this.onExecutionFinished(latestExecution)
          } catch (error) {
            this.logger?.warn('execution backfill failed', {
              executionId: latestExecution.id,
              nodeRunId: node.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          const updated = this.nodes.get(node.id)
          if (updated && updated.status !== 'running') continue
        }

        if (this.markReconciliationRequired(node, run.id, report)) markedThisRun = true
      }

      // S55-2B-1B（W3）：Daemon 不可用时，受影响 Run 一并进入 reconciliation_required，
      // 从状态上物理阻断后续派发；运行期（Daemon 可用）保持 W2 部分隔离。
      if (!options.daemonAvailable && markedThisRun && run.status === 'running') {
        const moved = this.runs.transition(
          run.id,
          ['running'],
          'reconciliation_required',
          this.now(),
        )
        if (moved) report.runsMarkedReconciliationRequired.push(run.id)
      }

      if (!options.daemonAvailable) continue
      if (run.status !== 'running') continue
      try {
        if (this.dispatcher) {
          report.runsKicked.push(run.id)
        } else {
          await this.scheduler.runUntilIdle(run.id)
          report.runsKicked.push(run.id)
        }
      } catch (error) {
        this.logger?.warn('workflow recovery tick failed', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (
      options.daemonAvailable &&
      options.allowKick !== false &&
      this.dispatcher &&
      report.runsKicked.length > 0
    ) {
      try {
        await this.dispatcher.tickAll()
      } catch (error) {
        this.logger?.warn('workflow recovery fair dispatch failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return report
  }

  private markReconciliationRequired(
    node: NodeRunRecord,
    runId: string,
    report: RecoveryReport,
  ): boolean {
    const moved = this.nodes.transition(node.id, ['running'], 'reconciliation_required', this.now())
    if (!moved) {
      this.logger?.warn('node reconciliation transition skipped; state changed concurrently', {
        nodeRunId: node.id,
        nodeKey: node.workflowNodeKey,
      })
      return false
    }
    report.nodesMarkedReconciliationRequired.push({
      nodeRunId: node.id,
      nodeKey: node.workflowNodeKey,
      runId,
    })
    return true
  }
}
