import { isCapabilityUsable, type ProviderCapabilities } from '@agentra/runtime-sdk'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'

export type PauseDisposition = 'interrupted' | 'awaiting_completion' | 'none'

export type BranchPauseExecutor = {
  /** 中断执行（interrupt 能力可用时）。返回 interrupted=false 表示已终态。 */
  interrupt(executionId: string): Promise<{ interrupted: boolean }>
}

export type BranchPauseOutcome = {
  executions: {
    executionId: string
    nodeRunId: string | null
    providerId: string
    disposition: PauseDisposition
    detail?: string
  }[]
}

export type BranchPauseLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

/**
 * S4-07 三档暂停策略（ARCHITECTURE §12 / 阶段 4 验收 S4-07）。
 *
 * 按 Provider 能力声明分档：
 * - interrupt 可用（native/emulated）：调 execution.interrupt；
 *   - resume 也可用 → 分支恢复时可续（native 档）；
 *   - resume 不可用 → 恢复时不 resume，重新派发新 attempt（上下文档：Session 已保留上下文）；
 * - interrupt 不支持：不打断，当前步骤自然结束后闸门不再派发（awaiting_completion 档）。
 *
 * 顺序保证：分支状态已先落库（paused），执行处置在状态生效之后执行；失败不回滚状态，
 * 只记录告警与审计——闸门已阻止新派发，最坏情况是本轮未中断成功，恢复路径兜底。
 */
export async function applyBranchPausePolicy(input: {
  branchRunId: string
  executions: ExecutionRepository
  nodeRuns: NodeRunRepository
  executor: BranchPauseExecutor
  audit?: AuditRepository
  logger?: BranchPauseLogger
  runId: string
  branchKey: string
  now: string
}): Promise<BranchPauseOutcome> {
  const active = input.executions.listActiveByBranch(input.branchRunId)
  const outcome: BranchPauseOutcome = { executions: [] }

  for (const execution of active) {
    const usable = isCapabilityUsable(
      execution.capabilities as unknown as ProviderCapabilities,
      'interrupt',
    )
    const nodeRunId = input.executions.getNodeRunId(execution.id)
    if (!usable) {
      outcome.executions.push({
        executionId: execution.id,
        nodeRunId,
        providerId: execution.providerId,
        disposition: 'awaiting_completion',
      })
      input.audit?.append({
        actorType: 'system',
        actorId: null,
        action: 'workflow.execution.awaiting_completion',
        targetType: 'execution',
        targetId: execution.id,
        details: {
          runId: input.runId,
          branchRunId: input.branchRunId,
          branchKey: input.branchKey,
          nodeRunId,
          providerId: execution.providerId,
          interrupt: 'unsupported',
        },
        now: input.now,
      })
      continue
    }

    try {
      const result = await input.executor.interrupt(execution.id)
      outcome.executions.push({
        executionId: execution.id,
        nodeRunId,
        providerId: execution.providerId,
        disposition: 'interrupted',
        detail: result.interrupted ? undefined : 'execution already finished',
      })
      input.audit?.append({
        actorType: 'system',
        actorId: null,
        action: 'workflow.execution.interrupted',
        targetType: 'execution',
        targetId: execution.id,
        details: {
          runId: input.runId,
          branchRunId: input.branchRunId,
          branchKey: input.branchKey,
          nodeRunId,
          providerId: execution.providerId,
          interrupted: result.interrupted,
          resumeUsable: isCapabilityUsable(
            execution.capabilities as unknown as ProviderCapabilities,
            'resume',
          ),
        },
        now: input.now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 中断失败不能让分支暂停半途而废：状态已落库，记录并按 awaiting 兜底。
      input.logger?.warn('branch pause interrupt failed', {
        executionId: execution.id,
        runId: input.runId,
        branchRunId: input.branchRunId,
        nodeRunId,
        error: message,
      })
      outcome.executions.push({
        executionId: execution.id,
        nodeRunId,
        providerId: execution.providerId,
        disposition: 'awaiting_completion',
        detail: message,
      })
      input.audit?.append({
        actorType: 'system',
        actorId: null,
        action: 'workflow.execution.awaiting_completion',
        targetType: 'execution',
        targetId: execution.id,
        details: {
          runId: input.runId,
          branchRunId: input.branchRunId,
          branchKey: input.branchKey,
          nodeRunId,
          providerId: execution.providerId,
          reason: 'interrupt_failed',
          error: message,
        },
        now: input.now,
      })
    }
  }
  return outcome
}
