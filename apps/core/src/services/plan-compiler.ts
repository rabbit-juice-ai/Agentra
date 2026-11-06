import type { PlanAssignment, PlanDraft, PlanTask } from '@agentra/protocol'
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agentra/workflow-schema'

export type PlanTaskAssignment = {
  agentId: string
  workRole: string
}

export type PlanCompilerInput = {
  plan: PlanDraft
  /** taskKey → 实际执行 Agent 与 Work 角色（由 PlanService 确保 Assignment 后传入）。 */
  taskAssignments: Record<string, PlanTaskAssignment>
}

export class PlanCompileError extends Error {
  constructor(
    message: string,
    readonly violations: unknown[] = [],
  ) {
    super(message)
    this.name = 'PlanCompileError'
  }
}

const START_KEY = 'start'
const END_KEY = 'end'

function promptForTask(task: PlanTask): string {
  const lines = [task.description]
  if (task.acceptanceCriteria.length > 0) {
    lines.push('', '验收标准：', ...task.acceptanceCriteria.map((item) => `- ${item}`))
  }
  if (task.inputs.length > 0) {
    lines.push('', `输入：${task.inputs.join('、')}`)
  }
  if (task.outputs.length > 0) {
    lines.push('', `必须产出：${task.outputs.join('、')}`)
  }
  if (task.verification) {
    lines.push(
      '',
      `你负责验收以下任务：${task.verification.verifies.join('、')}。`,
      '如果失败，relatedTasks 必须使用这些任务 key；同时输出 failureReason、impactScope、relatedArtifacts。',
    )
  }
  return lines.join('\n')
}

function agentTaskNode(
  task: PlanTask,
  assignment: PlanTaskAssignment,
  position: { x: number; y: number },
  inputRefs: { nodeKey: string; artifactName: string }[],
): WorkflowNode {
  return {
    key: task.key,
    type: 'agent_task',
    label: task.title,
    position,
    config: {
      assignmentSelector: {
        workRole: assignment.workRole,
        agentProfileId: assignment.agentId,
      },
      taskPrompt: promptForTask(task),
      inputArtifactRefs: inputRefs,
      artifacts: task.outputs.map((name) => ({ name, type: 'text', required: true })),
      workingDirectoryPolicy: 'work_root',
      outputContract: task.verification
        ? { profile: 'test_result', fields: [] }
        : { profile: 'generic', fields: [] },
    },
  } as WorkflowNode
}

function approvalNode(task: PlanTask, position: { x: number; y: number }): WorkflowNode {
  return {
    key: `${task.key}-approval`,
    type: 'human_approval',
    label: `${task.title} · 老板审批`,
    position,
    config: {
      target: { nodeKey: task.key, phase: 'after_execute' },
      reworkTargetNodeKey: task.key,
      instructions: `请确认「${task.title}」的结果后再继续。`,
    },
  } as WorkflowNode
}

function conditionNode(task: PlanTask, position: { x: number; y: number }): WorkflowNode {
  return {
    key: `${task.key}-check`,
    type: 'condition',
    label: `${task.title} · 验收判断`,
    position,
    config: {
      predicate: {
        kind: 'comparison',
        op: '==',
        left: { kind: 'field', path: `nodes.${task.key}.output.pass` },
        right: { kind: 'literal', value: true },
      },
      falseBranch: { kind: 'rework', reportNodeKey: task.key },
    },
  } as WorkflowNode
}

/**
 * Plan → 现有 7 节点 WorkflowDefinition。
 * 并行不显式建 split/join：同一层的多个节点由 Scheduler 按依赖自然并行。
 * 验收任务生成 test_result + Condition(falseBranch=rework)，直接复用现有 ReworkPolicy。
 */
export function compilePlanDefinition(input: PlanCompilerInput): WorkflowDefinition {
  const { plan, taskAssignments } = input
  const tasks = plan.tasks
  const taskByKey = new Map(tasks.map((task) => [task.key, task]))
  if (taskByKey.has(START_KEY) || taskByKey.has(END_KEY)) {
    throw new PlanCompileError('计划任务 key 不能使用保留字 start/end')
  }

  const verificationByTask = new Map<string, PlanTask>()
  for (const task of tasks) {
    if (!task.verification) continue
    if (verificationByTask.has(task.key)) {
      throw new PlanCompileError(`验收任务 key 重复：${task.key}`)
    }
    verificationByTask.set(task.key, task)
  }

  const nodes: WorkflowNode[] = [
    {
      key: START_KEY,
      type: 'start',
      label: '开始',
      position: { x: 60, y: 40 },
      config: {},
    } as WorkflowNode,
    {
      key: END_KEY,
      type: 'end',
      label: '结束',
      position: { x: 60, y: 700 },
      config: {},
    } as WorkflowNode,
  ]
  const edges: WorkflowEdge[] = []
  const edgeKeys = new Set<string>()
  const addEdge = (source: string, target: string, when?: boolean): void => {
    const id = `${source}->${target}`
    if (edgeKeys.has(id)) return
    edgeKeys.add(id)
    const edge: WorkflowEdge = {
      key: `e${edges.length}`,
      source,
      target,
    }
    if (when !== undefined) edge.when = when
    edges.push(edge)
  }

  const assignmentFor = (task: PlanTask): PlanTaskAssignment => {
    const assignment = taskAssignments[task.key]
    if (!assignment) {
      throw new PlanCompileError(`任务 ${task.key} 没有可用的 Agent Assignment`)
    }
    return assignment
  }

  const artifactSource = new Map<string, string>()
  for (const task of tasks) {
    for (const output of task.outputs) {
      if (!artifactSource.has(output)) artifactSource.set(output, task.key)
    }
  }

  // 1) 节点
  tasks.forEach((task, index) => {
    const position = { x: 100 + (index % 3) * 240, y: 140 + Math.floor(index / 3) * 130 }
    const inputRefs = task.inputs.flatMap((input) => {
      const source = artifactSource.get(input)
      return source && source !== task.key ? [{ nodeKey: source, artifactName: input }] : []
    })
    nodes.push(agentTaskNode(task, assignmentFor(task), position, inputRefs))
    if (task.approvalRequired) {
      nodes.push(approvalNode(task, { x: position.x + 260, y: position.y }))
    }
    if (task.verification) {
      nodes.push(conditionNode(task, { x: position.x, y: position.y + 70 }))
    }
  })

  const effectiveSource = (taskKey: string): string => {
    const task = taskByKey.get(taskKey)
    if (!task) throw new PlanCompileError(`未知任务：${taskKey}`)
    if (task.verification) return `${task.key}-check`
    if (task.approvalRequired) return `${task.key}-approval`
    return task.key
  }

  const dependents = new Map<string, Set<string>>()
  const incoming = new Set<string>()
  const addDependent = (sourceTaskKey: string, targetTaskKey: string): void => {
    const set = dependents.get(sourceTaskKey) ?? new Set<string>()
    set.add(targetTaskKey)
    dependents.set(sourceTaskKey, set)
    incoming.add(targetTaskKey)
    addEdge(
      effectiveSource(sourceTaskKey),
      targetTaskKey,
      taskByKey.get(sourceTaskKey)?.verification ? true : undefined,
    )
  }

  // 2) 依赖、验收目标、输入 artifact 形成边
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskByKey.has(dependency)) {
        throw new PlanCompileError(`任务 ${task.key} 依赖未知任务 ${dependency}`)
      }
      addDependent(dependency, task.key)
    }
    for (const verified of task.verification?.verifies ?? []) {
      if (!taskByKey.has(verified)) {
        throw new PlanCompileError(`验收任务 ${task.key} 指向未知任务 ${verified}`)
      }
      addDependent(verified, task.key)
    }
    for (const input of task.inputs) {
      const source = artifactSource.get(input)
      if (source && source !== task.key) addDependent(source, task.key)
    }
  }

  // 3) 审批节点与验收条件节点
  for (const task of tasks) {
    if (task.approvalRequired) addEdge(task.key, `${task.key}-approval`)
    if (!task.verification) continue
    const beforeCondition = task.approvalRequired ? `${task.key}-approval` : task.key
    addEdge(beforeCondition, `${task.key}-check`)
  }

  // 4) 无入边的任务从 start 开始
  for (const task of tasks) {
    if (!incoming.has(task.key)) addEdge(START_KEY, task.key)
  }

  // 5) 无下游的任务（或条件）落到 end
  for (const task of tasks) {
    const downstream = dependents.get(task.key)
    const hasDownstream = downstream !== undefined && downstream.size > 0
    if (hasDownstream) continue
    if (task.verification) addEdge(`${task.key}-check`, END_KEY, true)
    else if (task.approvalRequired) addEdge(`${task.key}-approval`, END_KEY)
    else addEdge(task.key, END_KEY)
  }

  const definition = { schemaVersion: 1, nodes, edges } as unknown
  const validation = validateWorkflowDefinition(definition)
  if (!validation.ok) {
    throw new PlanCompileError(
      validation.kind === 'violations'
        ? `计划编译后的工作流未通过校验：${validation.violations.length} 处问题`
        : `计划编译后的工作流未通过校验：${validation.message}`,
      validation.kind === 'violations' ? validation.violations : [],
    )
  }
  return validation.definition
}

/** 便于测试/调用方把 validation.assignments 转成 taskAssignments。 */
export function assignmentsToTaskMap(
  assignments: PlanAssignment[],
  rolesByAgent: Map<string, string>,
): Record<string, PlanTaskAssignment> {
  const map: Record<string, PlanTaskAssignment> = {}
  for (const assignment of assignments) {
    if (!assignment.agentId) continue
    const workRole = rolesByAgent.get(assignment.agentId)
    if (!workRole) continue
    map[assignment.taskKey] = { agentId: assignment.agentId, workRole }
  }
  return map
}
