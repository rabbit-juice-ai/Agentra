import type { Execution } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
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

export type ExecutionBridgeDeps = {
  runs: WorkflowRunRepository
  nodes: NodeRunRepository
  works: WorkRepository
  worktrees: WorktreeService
  definitions: PublishedDefinitionProvider
  resolver: WorkflowAssignmentResolver
  executions: ExecutionStarter
  outputs?: OutputExtractor
  rework?: TestResultReworkPort
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
      assignment = this.deps.resolver.resolveForNode(run.workId, node)
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
        prompt: node.config.taskPrompt,
        ...(worktreeId ? { worktreeId } : {}),
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

    const run = this.deps.runs.get(nodeRun.workflowRunId)
    if (!run) return
    const { definition } = this.deps.definitions.get(run.workflowVersionId)
    const node = definition.nodes.find((candidate) => candidate.key === nodeRun.workflowNodeKey)
    if (node === undefined || node.type !== 'agent_task') return

    const now = this.now()
    if (execution.status === 'cancelled') {
      const cancelled = this.deps.nodes.transition(nodeRun.id, ['running'], 'cancelled', now)
      if (!cancelled) this.warnUnchanged(nodeRun, node.key, 'cancelled', execution.id)
      return
    }
    if (execution.status !== 'succeeded') {
      this.retryOrFail(
        nodeRun,
        node,
        definition,
        `execution ${execution.status}`,
        { executionId: execution.id, exitCode: execution.exitCode },
        now,
      )
      return
    }

    const output = this.deps.outputs?.(execution.id) ?? null
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
      return
    }

    const succeeded = this.deps.nodes.transition(
      nodeRun.id,
      ['running'],
      'succeeded',
      now,
      output ? { outputSnapshot: output } : undefined,
    )
    if (!succeeded) {
      this.warnUnchanged(nodeRun, node.key, 'succeeded', execution.id)
      return
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
    const marked = this.deps.nodes.fail(
      nodeRun.id,
      ['running'],
      { category: 'internal', nodeKey: node.key, message, details },
      now,
    )
    if (!marked) this.warnUnchanged(nodeRun, node.key, 'failed')
    if (nodeRun.attempt >= maxAttempts) return

    // NodeRun 级重试：每次 attempt 一条新 NodeRun（与 D4 模型一致），交给下一次 tick 派发。
    this.deps.nodes.create(
      {
        id: newId('nrn'),
        workflowRunId: nodeRun.workflowRunId,
        workflowNodeKey: nodeRun.workflowNodeKey,
        branchRunId: nodeRun.branchRunId,
        status: 'ready',
        attempt: nodeRun.attempt + 1,
        inputSnapshot: nodeRun.inputSnapshot,
      },
      now,
    )
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
