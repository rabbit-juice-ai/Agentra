import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type {
  AssignmentRecord,
  AssignmentRepository,
} from '../db/repositories/assignment-repository'

export type WorkflowAssignmentErrorCode =
  | 'assignment_unresolved'
  | 'assignment_ambiguous'
  | 'assignment_inactive'

export class WorkflowAssignmentError extends Error {
  constructor(
    readonly code: WorkflowAssignmentErrorCode,
    readonly nodeKey: string,
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message)
    this.name = 'WorkflowAssignmentError'
  }
}

/**
 * Assignment 解析（C-8 双阶段）：
 * - Run 创建时 `precheck()` 对全部 agent_task 节点做**预检**：任一 0 命中/多命中即整次 Run 失败；
 * - 节点启动前 `resolveForNode()` **复核 active**：失效则该节点 failed，不自动改绑其他 Agent。
 */
export class WorkflowAssignmentResolver {
  constructor(private readonly assignments: AssignmentRepository) {}

  resolveForNode(workId: string, node: WorkflowNode): AssignmentRecord {
    if (node.type !== 'agent_task') {
      throw new Error(`assignment resolution is only defined for agent_task, got ${node.type}`)
    }
    const selector = node.config.assignmentSelector
    const matches = this.assignments
      .listByWork(workId)
      .filter(
        (assignment) =>
          assignment.workRole === selector.workRole &&
          (selector.agentProfileId === undefined || assignment.agentId === selector.agentProfileId),
      )
    const active = matches.filter((assignment) => assignment.status === 'active')

    if (active.length === 1) return active[0] as AssignmentRecord
    if (active.length > 1) {
      throw new WorkflowAssignmentError(
        'assignment_ambiguous',
        node.key,
        `work ${workId} has ${active.length} active assignments for role "${selector.workRole}"; pin agentProfileId to disambiguate`,
        active.map((assignment) => assignment.agentId),
      )
    }
    if (matches.length > 0) {
      throw new WorkflowAssignmentError(
        'assignment_inactive',
        node.key,
        `work ${workId} has no active assignment for role "${selector.workRole}" (found ${matches
          .map((assignment) => assignment.status)
          .join(', ')})`,
        matches.map((assignment) => assignment.agentId),
      )
    }
    throw new WorkflowAssignmentError(
      'assignment_unresolved',
      node.key,
      `work ${workId} has no assignment for role "${selector.workRole}"`,
    )
  }

  /** 全量预检：返回 nodeKey → assignment；任一失败抛错（调用方须在任何写入之前调用）。 */
  precheck(workId: string, definition: WorkflowDefinition): Map<string, AssignmentRecord> {
    const resolved = new Map<string, AssignmentRecord>()
    for (const node of definition.nodes) {
      if (node.type !== 'agent_task') continue
      resolved.set(node.key, this.resolveForNode(workId, node))
    }
    return resolved
  }
}
