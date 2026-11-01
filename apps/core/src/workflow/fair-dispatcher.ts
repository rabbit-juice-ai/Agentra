import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { TickResult, WorkflowScheduler } from './scheduler'

export type FairDispatcherLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

export type FairDispatcherDeps = {
  runs: WorkflowRunRepository
  scheduler: WorkflowScheduler
  logger?: FairDispatcherLogger
  /** 防止调度器空转；达到上限时停止并告警。 */
  maxPasses?: number
}

export type FairTickReport = {
  passes: number
  /** 真实启动顺序（跨 Run 交错后的输出，可直接作为公平性证据）。 */
  started: TickResult['startedNodes']
  /** 每个 Run 本轮实际启动的节点数。 */
  startedByRun: Record<string, number>
  /** 因 per-agent 轮转限额被推迟的节点（保持 ready，下一轮补位）。 */
  deferredByAgent: { runId: string; nodeKey: string; agentId: string | null }[]
}

/**
 * 多 Run 公平调度（S4-8 / C-1）：
 * - 每轮按 Run 轮转起点，逐 Run 调用 scheduler.tick；
 * - 同一轮内每个 Agent 在每个 Run 最多启动 1 个节点（startsByAgent 跨 Run 共享），
 *   保证「同一 Agent 内多 Run 按 Run 轮转」；
 * - 有空槽即补位：重复轮次直到没有新的启动；不引入运行时长公平。
 */
export class WorkflowFairDispatcher {
  private readonly maxPasses: number
  /** 跨 tickAll 保留轮转起点：上一次最后启动的 Run 的下一个 Run 优先。 */
  private lastStartedRunId: string | null = null

  constructor(private readonly deps: FairDispatcherDeps) {
    this.maxPasses = deps.maxPasses ?? 100
  }

  async tickAll(): Promise<FairTickReport> {
    const started: TickResult['startedNodes'] = []
    const deferredByAgent: FairTickReport['deferredByAgent'] = []
    const startedByRun: Record<string, number> = {}
    let passes = 0

    while (passes < this.maxPasses) {
      const running = this.deps.runs.listRunning()
      if (running.length === 0) break
      const baseIndex = this.lastStartedRunId
        ? Math.max(0, running.findIndex((run) => run.id === this.lastStartedRunId) + 1)
        : 0
      const offset = (baseIndex + passes) % running.length
      const ordered = [...running.slice(offset), ...running.slice(0, offset)]
      const startsByAgent = new Map<string, number>()
      let passStarted = 0

      for (const run of ordered) {
        const result = await this.deps.scheduler.tick(run.id, {
          maxStartsPerAgent: 1,
          startsByAgent,
        })
        for (const start of result.startedNodes) {
          started.push(start)
          startedByRun[run.id] = (startedByRun[run.id] ?? 0) + 1
          passStarted += 1
        }
        for (const skipped of result.skippedGates) {
          if (skipped.gate !== 'agent_rotation') continue
          deferredByAgent.push({
            runId: run.id,
            nodeKey: skipped.nodeKey,
            agentId: skipped.agentId ?? null,
          })
        }
      }

      passes += 1
      if (passStarted === 0) break
    }

    if (started.length > 0) this.lastStartedRunId = started[started.length - 1]?.runId ?? null
    if (passes >= this.maxPasses) {
      this.deps.logger?.warn('fair dispatcher reached max passes', { passes: this.maxPasses })
    }
    return { passes, started, startedByRun, deferredByAgent }
  }
}
