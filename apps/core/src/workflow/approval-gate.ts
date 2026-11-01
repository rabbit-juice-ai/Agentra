import type { WorkflowDefinition } from '@agentra/workflow-schema'
import type { ApprovalRepository } from '../db/repositories/approval-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { DispatchContext } from './dispatch-gates'

/**
 * A12 before_execute 门禁的判定源：
 * pending before_execute 审批（按 node key 定位审批节点）→ config.target.nodeKey
 * 即被保护任务。保护中的 agent_task 不得创建 Execution。
 */
export function createApprovalGateChecker(deps: {
  runs: WorkflowRunRepository
  nodes: NodeRunRepository
  approvals: ApprovalRepository
  definitions: { get(versionId: string): { definition: WorkflowDefinition } }
}) {
  return {
    isBlockedByPendingApproval(context: DispatchContext): boolean {
      if (context.node.type !== 'agent_task') return false
      const { definition } = deps.definitions.get(context.run.workflowVersionId)
      const approvalNodeKeys = new Set(
        definition.nodes
          .filter(
            (node) =>
              node.type === 'human_approval' && node.config.target.phase === 'before_execute',
          )
          .map((node) => node.key),
      )
      if (approvalNodeKeys.size === 0) return false

      const pending = deps.approvals.listPendingByRun(context.run.id)
      for (const approval of pending) {
        const approvalNodeRun = deps.nodes.get(approval.nodeRunId)
        if (!approvalNodeRun) continue
        if (!approvalNodeKeys.has(approvalNodeRun.workflowNodeKey)) continue
        const approvalNode = definition.nodes.find(
          (node) => node.key === approvalNodeRun.workflowNodeKey,
        )
        if (
          approvalNode &&
          approvalNode.type === 'human_approval' &&
          approvalNode.config.target.nodeKey === context.node.key
        ) {
          return true
        }
      }
      return false
    },
  }
}
