import type { Execution } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import { type Database, transaction } from '../db/database'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import type { CheckpointService } from '../services/checkpoint-service'
import type { WorktreeService } from '../services/worktree-service'
import { WorkflowAssignmentError, type WorkflowAssignmentResolver } from './assignment-resolver'
import type { DispatchContext } from './dispatch-gates'
import { isTestReportConsumedByCondition } from './graph'
import type { PublishedDefinitionProvider } from './published-definition-provider'
import type { NodeFailureCategory } from './types'

/** 桥接只依赖这两个能力；测试用替身即可，不需要真实进程。 */
export type ExecutionStarter = {
  startForNode(
    nodeRunId: string,
    params: { agentId: string; workId: string; prompt: string; worktreeId?: string },
  ): Promise<Execution>
  getNodeRunId(executionId: string): string | null
}

export type OutputExtractor = (executionId: string) => Record<string, unknown> | null

const TEST_RESULT_FIELDS: { name: string; type: OutputFieldType }[] = [
  { name: 'pass', type: 'boolean' },
  { name: 'failureReason', type: 'string' },
  { name: 'relatedTasks', type: 'string_array' },
  { name: 'impactScope', type: 'string' },
  { name: 'relatedArtifacts', type: 'string_array' },
]

type OutputFieldType = 'string' | 'number' | 'boolean' | 'string_array'

function matchesType(value: unknown, type: OutputFieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string_array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }
}

/** 输出契约校验：返回 null 表示通过，否则返回可诊断的失败原因。 */
export function validateOutputContract(
  contract: {
    profile: 'generic' | 'test_result'
    fields: { name: string; type: OutputFieldType; required: boolean }[]
  },
  output: Record<string, unknown> | null,
): string | null {
  const required =
    contract.profile === 'test_result'
      ? TEST_RESULT_FIELDS
      : contract.fields
          .filter((field) => field.required)
          .map((field) => ({ name: field.name, type: field.type }))

  for (const field of required) {
    if (output === null || !(field.name in output)) {
      return `missing required output field "${field.name}"`
    }
    if (!matchesType(output[field.name], field.type)) {
      return `output field "${field.name}" does not match type ${field.type}`
    }
  }
  // fail-closed：测试失败但说不出失败任务，是必须人工介入的状态，不能静默当作「无需返工」。
  if (contract.profile === 'test_result' && output?.pass === false) {
    const related = output.relatedTasks
    if (!Array.isArray(related) || related.length === 0) {
      return 'test_result pass=false requires at least one relatedTasks entry'
    }
  }
  return null
}

export type ExecutionBridgeLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

/** 测试报告完成后的返工触发接缝（S4-6 ReworkPolicy）。 */
export type TestResultReworkPort = {
  onTestResult(input: {
    runId: string
    reportNodeRunId: string
    reportNodeKey: string
    output: Record<string, unknown>
  }): void
}

/**
 * 任务生命周期事件接缝：AgentTask 执行的关键节点回写到任务群聊线程。
 * sink 内部失败必须自吞（记日志），不得影响引擎状态机。
 */
export type TaskEventSink = {
  onTaskStarted(event: TaskEvent & { kind: 'started' }): void
  onTaskSucceeded(event: TaskEvent & { kind: 'succeeded' }): void
  onTaskFailed(event: TaskEvent & { kind: 'failed' }): void
  onTaskCancelled(event: TaskEvent & { kind: 'cancelled' }): void
  onVerificationReport(event: TaskEvent & { kind: 'verification' }): void
}

export type ExecutionBridgeDeps = {
  db: Database
  runs: WorkflowRunRepository
  nodes: NodeRunRepository
  works: WorkRepository
  worktrees: WorktreeService
  definitions: PublishedDefinitionProvider
  resolver: WorkflowAssignmentResolver
  /** 运行期显式改派（P5）；返回 null 表示沿用节点固定的 assignmentSelector。 */
  assignmentOverride?: (runId: string, nodeKey: string) => string | null
  executions: ExecutionStarter
  outputs?: OutputExtractor
  workInterrupted?: (executionId: string) => boolean
  inputPrompt?: (context: DispatchContext) => string
  commitOutput?: (
    execution: Execution,
    node: Extract<WorkflowNode, { type: 'agent_task' }>,
    output: Record<string, unknown>,
    saveNode: (snapshot: Record<string, unknown>) => void,
  ) => void
  rework?: TestResultReworkPort
  taskEvents?: TaskEventSink
  /** Phase 1B-2B：恢复执行识别与 NodeRun 终态观察器。 */
  recoveryExecution?: {
    isRecoveryExecution(executionId: string): boolean
    onWorkflowNodeTerminal?(input: {
      nodeRunId: string
      status: 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_required'
      reasonCode?: string
      executionId?: string
    }): void
  }
  checkpoints?: Pick<CheckpointService, 'createForExecution'>
  logger?: ExecutionBridgeLogger
  now?: () => string
}

/**
 * AgentTask 执行桥：把调度器的 ready→running 接成真实 Execution，并在执行终态时回写节点。
 * 控制节点（start/end/condition/join/split/human_approval）的运行时不在这里，属 S4-5。
 */
export class WorkflowExecutionBridge {
  private readonly now: () => string

  constructor(private readonly deps: ExecutionBridgeDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async onNodeStarted(context: DispatchContext): Promise<void> {
    const { node, nodeRun, run } = context
    if (node.type !== 'agent_task') {
      this.fail(
        nodeRun,
        node.key,
        'internal',
        `node type "${node.type}" runtime is not implemented in S4-4`,
      )
      return
    }

    let assignment: { id: string; agentId: string }
    try {
      const overrideAgentId = this.deps.assignmentOverride?.(run.id, node.key) ?? undefined
      assignment = this.deps.resolver.resolveForNode(run.workId, node, overrideAgentId)
    } catch (error) {
      if (error instanceof WorkflowAssignmentError) {
        this.fail(nodeRun, node.key, error.code, error.message)
        return
      }
      throw error
    }

    const work = this.deps.works.get(run.workId)
    if (!work) {
      this.fail(nodeRun, node.key, 'internal', `work not found: ${run.workId}`)
      return
    }

    let worktreeId: string | undefined
    if (node.config.workingDirectoryPolicy === 'worktree') {
      if (!work.repositoryPath) {
        this.fail(nodeRun, node.key, 'internal', 'work has no repository_path for worktree policy')
        return
      }
      const branchName = `agentra/${run.id.slice(-12)}/${node.key}/${nodeRun.attempt}`
      try {
        const existing = this.deps.worktrees
          .list(work.id)
          .find((worktree) => worktree.status === 'active' && worktree.branchName === branchName)
        worktreeId =
          existing?.id ??
          this.deps.worktrees.create({
            workId: work.id,
            assignmentId: assignment.id,
            branchName,
          }).id
      } catch (error) {
        this.fail(
          nodeRun,
          node.key,
          'internal',
          `worktree preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
    }

    try {
      await this.deps.executions.startForNode(nodeRun.id, {
        agentId: assignment.agentId,
        workId: run.workId,
        prompt: this.deps.inputPrompt?.(context) ?? node.config.taskPrompt,
        ...(worktreeId ? { worktreeId } : {}),
      })
      this.emitTaskEvent({
        kind: 'started',
        runId: run.id,
        nodeKey: node.key,
        nodeRunId: nodeRun.id,
        attempt: nodeRun.attempt,
        agentId: assignment.agentId,
      })
    } catch (error) {
      this.fail(nodeRun, node.key, providerFailureCategory(error), describe(error))
    }
  }

  /** Execution 进入终态后的回调：成功 → 校验输出契约；失败 → 重试或 failed。 */
  onExecutionFinished(execution: Execution): void {
    const nodeRunId = this.deps.executions.getNodeRunId(execution.id)
    if (!nodeRunId) return
    const nodeRun = this.deps.nodes.get(nodeRunId)
    if (nodeRun === null || nodeRun.status !== 'running') return
    const isRecoveryExecution =
      this.deps.recoveryExecution?.isRecoveryExecution(execution.id) === true

    const run = this.deps.runs.get(nodeRun.workflowRunId)
    if (!run) return
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const node = definition.nodes.find((candidate) => candidate.key === nodeRun.workflowNodeKey)
    if (node === undefined || node.type !== 'agent_task') return

    const now = this.now()
    if (this.deps.workInterrupted?.(execution.id)) {
      // 中断回合不是完整交付；用户恢复 Work 后才允许用新 attempt 续接。
      this.deps.nodes.transition(nodeRun.id, ['running'], 'reconciliation_required', now)
      this.notifyWorkflowNodeTerminal(
        nodeRun.id,
        'reconciliation_required',
        'WORK_INTERRUPTED',
        execution.id,
      )
      return
    }
    if (execution.status === 'cancelled') {
      const cancelled = this.deps.nodes.transition(nodeRun.id, ['running'], 'cancelled', now)
      if (!cancelled) this.warnUnchanged(nodeRun, node.key, 'cancelled', execution.id)
      else {
        this.notifyWorkflowNodeTerminal(
          nodeRun.id,
          'cancelled',
          'execution_cancelled',
          execution.id,
        )
        this.emitTaskEvent({
          kind: 'cancelled',
          runId: run.id,
          nodeKey: node.key,
          nodeRunId: nodeRun.id,
          attempt: nodeRun.attempt,
          agentId: execution.agentId,
        })
      }
      this.createCheckpointForExecution(execution, run, now)
      return
    }
    if (execution.status !== 'succeeded') {
      if (isRecoveryExecution) {
        const marked = this.deps.nodes.fail(
          nodeRun.id,
          ['running'],
          { category: 'internal', nodeKey: node.key, message: `execution ${execution.status}` },
          now,
        )
        if (marked)
          this.notifyWorkflowNodeTerminal(
            nodeRun.id,
            'failed',
            `execution_${execution.status}`,
            execution.id,
          )
      } else {
        this.retryOrFail(
          nodeRun,
          node,
          definition,
          `execution ${execution.status}`,
          { executionId: execution.id, exitCode: execution.exitCode },
          now,
        )
      }
      this.emitTaskEvent({
        kind: 'failed',
        runId: run.id,
        nodeKey: node.key,
        nodeRunId: nodeRun.id,
        attempt: nodeRun.attempt,
        agentId: execution.agentId,
        category: 'execution_failure',
        message: `execution ${execution.status}`,
        willRetry:
          nodeRun.attempt <
          (node.config.retryPolicy?.maxAttempts ?? definition.settings.defaults.maxAttempts),
      })
      this.createCheckpointForExecution(execution, run, now)
      return
    }

    let output: Record<string, unknown> | null
    try {
      output = this.deps.outputs?.(execution.id) ?? null
    } catch {
      this.deps.nodes.fail(
        nodeRun.id,
        ['running'],
        {
          category: 'output_contract_violation',
          nodeKey: node.key,
          message: 'Output extraction failed (empty, invalid or oversized output)',
          details: { executionId: execution.id },
        },
        now,
      )
      this.notifyWorkflowNodeTerminal(
        nodeRun.id,
        'failed',
        'output_contract_violation',
        execution.id,
      )
      this.emitTaskEvent({
        kind: 'failed',
        runId: run.id,
        nodeKey: node.key,
        nodeRunId: nodeRun.id,
        attempt: nodeRun.attempt,
        agentId: execution.agentId,
        category: 'output_contract_violation',
        message: 'Output extraction failed (empty, invalid or oversized output)',
        willRetry: false,
      })
      return
    }
    const violation = validateOutputContract(node.config.outputContract, output)
    if (violation) {
      const marked = this.deps.nodes.fail(
        nodeRun.id,
        ['running'],
        {
          category: 'output_contract_violation',
          nodeKey: node.key,
          message: violation,
          details: { executionId: execution.id },
        },
        now,
      )
      if (!marked) this.warnUnchanged(nodeRun, node.key, 'output_contract_violation', execution.id)
      else {
        this.notifyWorkflowNodeTerminal(
          nodeRun.id,
          'failed',
          'output_contract_violation',
          execution.id,
        )
        this.emitTaskEvent({
          kind: 'failed',
          runId: run.id,
          nodeKey: node.key,
          nodeRunId: nodeRun.id,
          attempt: nodeRun.attempt,
          agentId: execution.agentId,
          category: 'output_contract_violation',
          message: violation,
          willRetry: false,
        })
      }
      return
    }

    const saveNode = (snapshot: Record<string, unknown>) => {
      if (
        !this.deps.nodes.transition(nodeRun.id, ['running'], 'succeeded', now, {
          outputSnapshot: snapshot,
        })
      ) {
        throw new Error('Node state changed during output commit')
      }
    }
    try {
      if (this.deps.commitOutput) this.deps.commitOutput(execution, node, output ?? {}, saveNode)
      else saveNode(output ?? {})
    } catch {
      this.deps.nodes.fail(
        nodeRun.id,
        ['running'],
        {
          category: 'output_contract_violation',
          nodeKey: node.key,
          message: 'Artifact/output commit failed; downstream execution blocked',
          details: { executionId: execution.id },
        },
        now,
      )
      this.notifyWorkflowNodeTerminal(nodeRun.id, 'failed', 'output_commit_failed', execution.id)
      this.emitTaskEvent({
        kind: 'failed',
        runId: run.id,
        nodeKey: node.key,
        nodeRunId: nodeRun.id,
        attempt: nodeRun.attempt,
        agentId: execution.agentId,
        category: 'output_contract_violation',
        message: 'Artifact/output commit failed; downstream execution blocked',
        willRetry: false,
      })
      return
    }
    this.emitTaskEvent({
      kind: 'succeeded',
      runId: run.id,
      nodeKey: node.key,
      nodeRunId: nodeRun.id,
      attempt: nodeRun.attempt,
      agentId: execution.agentId,
    })
    this.notifyWorkflowNodeTerminal(nodeRun.id, 'succeeded', 'execution_succeeded', execution.id)
    if (this.createCheckpointForExecution(execution, run, now)) return
    if (output && node.config.outputContract.profile === 'test_result') {
      this.emitTaskEvent({
        kind: 'verification',
        runId: run.id,
        nodeKey: node.key,
        nodeRunId: nodeRun.id,
        attempt: nodeRun.attempt,
        agentId: execution.agentId,
        passed: output.pass === true,
        failureReason: typeof output.failureReason === 'string' ? output.failureReason : '',
        relatedTasks: Array.isArray(output.relatedTasks)
          ? output.relatedTasks.filter((item): item is string => typeof item === 'string')
          : [],
      })
    }
    // 契约通过后才允许触发返工；契约失败在上面的分支已经 failed 并 return。
    if (
      output &&
      node.config.outputContract.profile === 'test_result' &&
      this.deps.rework &&
      !isTestReportConsumedByCondition(definition, node.key)
    ) {
      try {
        this.deps.rework.onTestResult({
          runId: run.id,
          reportNodeRunId: nodeRun.id,
          reportNodeKey: node.key,
          output,
        })
      } catch (error) {
        this.deps.logger?.warn('rework trigger failed', {
          nodeRunId: nodeRun.id,
          nodeKey: node.key,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private notifyWorkflowNodeTerminal(
    nodeRunId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_required',
    reasonCode: string,
    executionId: string,
  ): void {
    try {
      this.deps.recoveryExecution?.onWorkflowNodeTerminal?.({
        nodeRunId,
        status,
        reasonCode,
        executionId,
      })
    } catch (error) {
      this.deps.logger?.warn('workflow node terminal observer failed', {
        nodeRunId,
        status,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private createCheckpointForExecution(
    execution: Execution,
    run: WorkflowRunRecord,
    now: string,
  ): boolean {
    if (!this.deps.checkpoints) return false
    try {
      const result = this.deps.checkpoints.createForExecution(execution.id, 'node')
      if (result.blocked) {
        this.deps.runs.transition(run.id, ['running'], 'reconciliation_required', now)
        this.deps.logger?.warn('high-risk checkpoint blocked workflow progression', {
          executionId: execution.id,
          runId: run.id,
          checkpointId: result.checkpointId,
          reasons: result.reasons,
        })
        return true
      }
      return false
    } catch (error) {
      this.deps.runs.transition(run.id, ['running'], 'reconciliation_required', now)
      this.deps.logger?.warn('checkpoint creation failed; workflow run blocked', {
        executionId: execution.id,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return true
    }
  }

  private retryOrFail(
    nodeRun: NodeRunRecord,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    message: string,
    details: Record<string, unknown>,
    now: string,
  ): void {
    if (node.type !== 'agent_task') return
    const maxAttempts =
      node.config.retryPolicy?.maxAttempts ?? definition.settings.defaults.maxAttempts
    // R1（S55-2B-1B）：失败迁移与 retry-attempt 创建必须原子，且 create 仅在
    // fail CAS 真正成功时执行——重复补偿/并发观察不会产生第二条 attempt。
    const retry =
      nodeRun.attempt >= maxAttempts
        ? null
        : {
            id: newId('nrn'),
            workflowRunId: nodeRun.workflowRunId,
            workflowNodeKey: nodeRun.workflowNodeKey,
            branchRunId: nodeRun.branchRunId,
            status: 'ready' as const,
            attempt: nodeRun.attempt + 1,
            inputSnapshot: nodeRun.inputSnapshot,
          }
    const result = transaction(this.deps.db, () => {
      const marked = this.deps.nodes.fail(
        nodeRun.id,
        ['running'],
        { category: 'internal', nodeKey: node.key, message, details },
        now,
      )
      if (!marked) return { marked, created: false }
      if (retry) {
        this.deps.nodes.create(retry, now)
        return { marked, created: true }
      }
      return { marked, created: false }
    })
    if (!result.marked) this.warnUnchanged(nodeRun, node.key, 'failed')
  }

  private fail(
    nodeRun: NodeRunRecord,
    nodeKey: string,
    category: NodeFailureCategory,
    message: string,
  ): void {
    const marked = this.deps.nodes.fail(
      nodeRun.id,
      ['running'],
      { category, nodeKey, message },
      this.now(),
    )
    if (!marked) this.warnUnchanged(nodeRun, nodeKey, category)
  }

  private warnUnchanged(
    nodeRun: NodeRunRecord,
    nodeKey: string,
    target: string,
    executionId?: string,
  ): void {
    this.deps.logger?.warn('node state changed concurrently; transition skipped', {
      runId: nodeRun.workflowRunId,
      branchRunId: nodeRun.branchRunId,
      nodeRunId: nodeRun.id,
      nodeKey,
      target,
      ...(executionId ? { executionId } : {}),
    })
  }

  /** 任务事件 → sink（群聊线程）。sink 异常自吞，不影响引擎状态机。 */
  private emitTaskEvent(event: TaskEvent): void {
    const sink = this.deps.taskEvents
    if (!sink) return
    try {
      switch (event.kind) {
        case 'started':
          sink.onTaskStarted(event)
          break
        case 'succeeded':
          sink.onTaskSucceeded(event)
          break
        case 'failed':
          sink.onTaskFailed(event)
          break
        case 'cancelled':
          sink.onTaskCancelled(event)
          break
        case 'verification':
          sink.onVerificationReport(event)
          break
      }
    } catch (error) {
      this.deps.logger?.warn('task event sink failed', {
        runId: event.runId,
        nodeKey: event.nodeKey,
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** 任务事件判别联合：started/succeeded/failed/cancelled/verification。 */
export type TaskEvent =
  | {
      kind: 'started'
      runId: string
      nodeKey: string
      nodeRunId: string
      attempt: number
      agentId: string | null
    }
  | {
      kind: 'succeeded'
      runId: string
      nodeKey: string
      nodeRunId: string
      attempt: number
      agentId: string | null
    }
  | {
      kind: 'failed'
      runId: string
      nodeKey: string
      nodeRunId: string
      attempt: number
      agentId: string | null
      category: string
      message: string
      willRetry: boolean
    }
  | {
      kind: 'cancelled'
      runId: string
      nodeKey: string
      nodeRunId: string
      attempt: number
      agentId: string | null
    }
  | {
      kind: 'verification'
      runId: string
      nodeKey: string
      nodeRunId: string
      attempt: number
      agentId: string | null
      passed: boolean
      failureReason: string
      relatedTasks: string[]
    }

function providerFailureCategory(error: unknown): NodeFailureCategory {
  const code = (error as { code?: unknown } | null)?.code
  if (
    code === 'CLI_UNAVAILABLE' ||
    code === 'CLI_NOT_AUTHENTICATED' ||
    code === 'AGENT_TOOLS_NOT_CONFIGURED'
  ) {
    return 'provider_unavailable'
  }
  return 'internal'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
