import type { Edge, Node } from '@xyflow/react'

/** MVP 画布节点闭集：7 种，与 WORKFLOW §2 / DATABASE §2.5 的白名单逐字一致。 */
export const NODE_TYPES = [
  'start',
  'agent_task',
  'parallel_split',
  'join',
  'human_approval',
  'condition',
  'end',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  start: 'Start',
  agent_task: 'Agent Task',
  parallel_split: 'Parallel Split',
  join: 'Join',
  human_approval: 'Human Approval',
  condition: 'Condition',
  end: 'End',
}

/** key 规则与定义 Schema 一致：`[a-z0-9_-]{1,64}`。 */
export const KEY_PATTERN = /^[a-z0-9_-]{1,64}$/

export type DefinitionNode = {
  key: string
  type: NodeType
  label?: string
  position: { x: number; y: number }
  config: Record<string, unknown>
}

export type DefinitionEdge = {
  key: string
  source: string
  target: string
  branchKey?: string
  when?: boolean
}

export type WorkflowDefinition = {
  schemaVersion: number
  nodes: DefinitionNode[]
  edges: DefinitionEdge[]
  settings?: Record<string, unknown>
}

/** RPC 返回的 violation 形状（16 项闭集见 WORKFLOW §2，成员由服务端校验）。 */
export type Violation = {
  violation: string
  nodeKey?: string
  edgeKey?: string
  message: string
}

export type WorkflowNodeData = {
  node: DefinitionNode
  violation?: string
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowNode'>

export type WorkflowEdgeData = {
  edge: DefinitionEdge
}

export type WorkflowFlowEdge = Edge<WorkflowEdgeData>

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value)
}
