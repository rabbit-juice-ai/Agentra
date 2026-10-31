import { Handle, type NodeProps, Position } from '@xyflow/react'
import { colors } from '../../components/styles'
import type { NodeType, WorkflowFlowNode } from './types'
import { NODE_TYPE_LABELS } from './types'

const TYPE_ACCENT: Record<NodeType, string> = {
  start: colors.green,
  end: colors.muted,
  agent_task: colors.blue,
  parallel_split: colors.amber,
  join: colors.amber,
  human_approval: '#8250df',
  condition: '#bf3989',
}

export function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { node, violation } = data
  const accent = TYPE_ACCENT[node.type]
  const hasTarget = node.type !== 'start'
  const hasSource = node.type !== 'end'

  return (
    <div
      data-testid={`workflow-node-${node.key}`}
      data-node-type={node.type}
      data-violation={violation ? 'true' : undefined}
      style={{
        minWidth: 150,
        padding: '8px 12px',
        borderRadius: 8,
        background: colors.panel,
        border: `2px solid ${violation ? colors.red : selected ? colors.blue : accent}`,
        boxShadow: violation ? `0 0 0 3px #ffebe9` : '0 1px 2px rgba(31,35,40,0.08)',
      }}
    >
      {hasTarget && <Handle type="target" position={Position.Top} />}
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: accent }}>
        {NODE_TYPE_LABELS[node.type].toUpperCase()}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
        {node.label && node.label.length > 0 ? node.label : node.key}
      </div>
      <div style={{ fontSize: 10, color: colors.muted }}>{node.key}</div>
      {violation && (
        <div
          data-testid={`workflow-node-violation-${node.key}`}
          style={{ marginTop: 4, fontSize: 10, color: colors.red }}
        >
          {violation}
        </div>
      )}
      {hasSource && <Handle type="source" position={Position.Bottom} />}
    </div>
  )
}
