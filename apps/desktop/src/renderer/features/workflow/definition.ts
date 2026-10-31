import type {
  DefinitionEdge,
  DefinitionNode,
  NodeType,
  WorkflowDefinition,
  WorkflowFlowEdge,
  WorkflowFlowNode,
} from './types'
import { KEY_PATTERN, NODE_TYPES } from './types'

const KEY_PREFIX: Record<NodeType, string> = {
  start: 'start',
  end: 'end',
  agent_task: 'task',
  parallel_split: 'split',
  join: 'join',
  human_approval: 'approval',
  condition: 'condition',
}

/** 生成未被占用的 key（`<prefix>_<n>`），保证符合定义 Schema 的字符集。 */
export function nextKey(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${prefix}_${index}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`cannot allocate key for prefix "${prefix}"`)
}

export function defaultConfig(type: NodeType, existing: DefinitionNode[]): Record<string, unknown> {
  switch (type) {
    case 'start':
    case 'end':
    case 'parallel_split':
      return {}
    case 'agent_task':
      return {
        assignmentSelector: { workRole: 'dev' },
        taskPrompt: 'describe the task',
        artifacts: [],
      }
    case 'human_approval': {
      const task = existing.find((node) => node.type === 'agent_task')
      return {
        target: { nodeKey: task?.key ?? '', phase: 'after_execute' },
        instructions: '',
      }
    }
    case 'join': {
      const split = existing.find((node) => node.type === 'parallel_split')
      return { pairWith: split?.key ?? '' }
    }
    case 'condition': {
      const source = existing.find((node) => node.type === 'agent_task') ?? existing[0]
      return {
        predicate: {
          kind: 'comparison',
          op: '==',
          left: { kind: 'field', path: `nodes.${source?.key ?? 'start'}.status` },
          right: { kind: 'literal', value: 'succeeded' },
        },
        falseBranch: 'edge',
      }
    }
  }
}

export function createNode(
  type: NodeType,
  position: { x: number; y: number },
  existing: DefinitionNode[],
): DefinitionNode {
  return {
    key: nextKey(
      KEY_PREFIX[type],
      existing.map((node) => node.key),
    ),
    type,
    label: '',
    position: { x: position.x, y: position.y },
    config: defaultConfig(type, existing),
  }
}

/** 新连线的默认 when / branchKey：condition 出边必须带 when，split 出边必须带 branchKey。 */
export function defaultEdgeAttributes(
  sourceType: NodeType | undefined,
  sourceKey: string,
  edges: DefinitionEdge[],
): { when?: boolean; branchKey?: string } {
  if (sourceType === 'condition') {
    const usedTrue = edges.some((edge) => edge.source === sourceKey && edge.when === true)
    return { when: !usedTrue }
  }
  if (sourceType === 'parallel_split') {
    const used = edges
      .filter((edge) => edge.source === sourceKey && edge.branchKey !== undefined)
      .map((edge) => edge.branchKey as string)
    return { branchKey: nextKey('branch', used) }
  }
  return {}
}

export function edgeLabel(edge: DefinitionEdge): string | undefined {
  const parts: string[] = []
  if (edge.when !== undefined) parts.push(`when=${edge.when}`)
  if (edge.branchKey !== undefined) parts.push(`branch=${edge.branchKey}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function toFlowNodes(definition: WorkflowDefinition): WorkflowFlowNode[] {
  return definition.nodes.map((node) => ({
    id: node.key,
    type: 'workflowNode',
    position: { x: node.position.x, y: node.position.y },
    data: { node },
  }))
}

export function toFlowEdges(definition: WorkflowDefinition): WorkflowFlowEdge[] {
  return definition.edges.map((edge) => ({
    id: edge.key,
    source: edge.source,
    target: edge.target,
    data: { edge },
    label: edgeLabel(edge),
  }))
}

/**
 * 画布 → 定义。节点/边的其它字段原样保留（包括服务端填充的默认值），
 * 只覆盖 position 与 source/target，保证「保存 → 重开」逐字段一致。
 * position 不做取整：坐标是用户定义的一部分，静默改写会造成「导入后变成另一个定义」。
 */
export function fromFlow(
  flowNodes: WorkflowFlowNode[],
  flowEdges: WorkflowFlowEdge[],
  settings: Record<string, unknown> | undefined,
  schemaVersion = 1,
): WorkflowDefinition {
  const definition: WorkflowDefinition = {
    schemaVersion,
    nodes: flowNodes.map((node) => ({
      ...node.data.node,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: flowEdges.map((edge) => ({
      ...edge.data?.edge,
      key: edge.id,
      source: edge.source,
      target: edge.target,
    })) as DefinitionEdge[],
  }
  if (settings !== undefined) definition.settings = settings
  return definition
}

export function definitionToJson(definition: WorkflowDefinition): string {
  return JSON.stringify(definition, null, 2)
}

export type ParseResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; message: string }

/**
 * 导入时的本地结构检查（JSON 可解析、必备字段形状正确）。
 * **未知字段不在这里放行**：交给服务端 `workflow.version.validate` 的严格 Schema 拒绝，
 * 避免客户端维护第二份白名单。
 */
export function parseDefinitionJson(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '定义必须是 JSON 对象' }
  }
  const candidate = raw as Record<string, unknown>
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    return { ok: false, message: '定义必须包含 nodes 与 edges 两个数组' }
  }
  const keys = new Set<string>()
  for (const [index, value] of candidate.nodes.entries()) {
    if (typeof value !== 'object' || value === null) {
      return { ok: false, message: `nodes[${index}] 必须是对象` }
    }
    const node = value as Record<string, unknown>
    if (typeof node.key !== 'string' || !KEY_PATTERN.test(node.key)) {
      return { ok: false, message: `nodes[${index}].key 不符合 [a-z0-9_-]{1,64}` }
    }
    if (!(NODE_TYPES as readonly string[]).includes(String(node.type))) {
      return { ok: false, message: `nodes[${index}].type 不在 7 种 MVP 节点内` }
    }
    if (keys.has(node.key)) {
      return { ok: false, message: `节点 key 重复：${node.key}` }
    }
    keys.add(node.key)
    const position = node.position
    if (typeof position !== 'object' || position === null) {
      return { ok: false, message: `nodes[${index}].position 必须是对象` }
    }
    const { x, y } = position as Record<string, unknown>
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { ok: false, message: `nodes[${index}].position 必须包含数字 x/y` }
    }
    if (typeof node.config !== 'object' || node.config === null) {
      return { ok: false, message: `nodes[${index}].config 必须是对象` }
    }
  }
  for (const [index, value] of candidate.edges.entries()) {
    if (typeof value !== 'object' || value === null) {
      return { ok: false, message: `edges[${index}] 必须是对象` }
    }
    const edge = value as Record<string, unknown>
    if (typeof edge.key !== 'string' || !KEY_PATTERN.test(edge.key)) {
      return { ok: false, message: `edges[${index}].key 不符合 [a-z0-9_-]{1,64}` }
    }
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      return { ok: false, message: `edges[${index}] 必须包含 source 与 target` }
    }
    if (!keys.has(edge.source) || !keys.has(edge.target)) {
      return { ok: false, message: `edges[${index}] 指向不存在的节点` }
    }
  }
  return { ok: true, definition: raw as WorkflowDefinition }
}
