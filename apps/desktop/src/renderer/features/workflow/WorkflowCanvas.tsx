import {
  Background,
  type Connection,
  Controls,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { colors } from '../../components/styles'
import type { WorkflowFlowEdge, WorkflowFlowNode } from './types'
import { WorkflowNodeView } from './WorkflowNodeView'

const nodeTypes: NodeTypes = { workflowNode: WorkflowNodeView }

type Props = {
  nodes: WorkflowFlowNode[]
  edges: WorkflowFlowEdge[]
  onNodesChange: OnNodesChange<WorkflowFlowNode>
  onEdgesChange: OnEdgesChange<WorkflowFlowEdge>
  onConnect: (connection: Connection) => void
  onNodeClick: (node: WorkflowFlowNode) => void
  onEdgeClick: (edge: WorkflowFlowEdge) => void
  onPaneClick: () => void
}

/** 画布模块：只在 Workflow tab 懒加载时进入 bundle。 */
export function WorkflowCanvas(props: Props) {
  return (
    <div
      data-testid="workflow-canvas"
      style={{
        height: 520,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        background: colors.panel,
        overflow: 'hidden',
      }}
    >
      <ReactFlow
        nodes={props.nodes}
        edges={props.edges}
        nodeTypes={nodeTypes}
        onNodesChange={props.onNodesChange}
        onEdgesChange={props.onEdgesChange}
        onConnect={props.onConnect}
        onNodeClick={(_event, node) => props.onNodeClick(node as WorkflowFlowNode)}
        onEdgeClick={(_event, edge) => props.onEdgeClick(edge as WorkflowFlowEdge)}
        onPaneClick={props.onPaneClick}
        fitView
        minZoom={0.3}
      >
        <Background gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  )
}
