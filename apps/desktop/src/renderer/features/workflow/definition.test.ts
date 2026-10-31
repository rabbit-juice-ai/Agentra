import { describe, expect, it } from 'vitest'
import {
  createNode,
  defaultEdgeAttributes,
  fromFlow,
  parseDefinitionJson,
  toFlowEdges,
  toFlowNodes,
} from './definition'
import type { WorkflowDefinition } from './types'

function item<T>(items: T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`missing item ${index}`)
  return value
}

function fullDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task_1',
        type: 'agent_task',
        label: 'PRD',
        position: { x: 0, y: 100 },
        config: {
          assignmentSelector: { workRole: 'product' },
          taskPrompt: '写 PRD',
          artifacts: [{ name: 'prd', type: 'markdown', required: true }],
          workingDirectoryPolicy: 'work_root',
          outputContract: { profile: 'generic', fields: [] },
        },
      },
      { key: 'split_1', type: 'parallel_split', position: { x: 0, y: 200 }, config: {} },
      { key: 'join_1', type: 'join', position: { x: 0, y: 300 }, config: { pairWith: 'split_1' } },
      {
        key: 'approval_1',
        type: 'human_approval',
        position: { x: 0, y: 400 },
        config: { target: { nodeKey: 'task_1', phase: 'after_execute' }, instructions: '' },
      },
      {
        key: 'condition_1',
        type: 'condition',
        position: { x: 0, y: 500 },
        config: {
          predicate: {
            kind: 'comparison',
            op: '==',
            left: { kind: 'field', path: 'nodes.task_1.status' },
            right: { kind: 'literal', value: 'succeeded' },
          },
          falseBranch: { kind: 'rework', reportNodeKey: 'task_1' },
        },
      },
      { key: 'end_1', type: 'end', position: { x: 0, y: 600 }, config: {} },
    ],
    edges: [
      { key: 'edge_1', source: 'start', target: 'task_1' },
      { key: 'edge_2', source: 'task_1', target: 'split_1' },
      { key: 'edge_3', source: 'split_1', target: 'join_1', branchKey: 'branch_1' },
      { key: 'edge_4', source: 'split_1', target: 'join_1', branchKey: 'branch_2' },
      { key: 'edge_5', source: 'join_1', target: 'condition_1' },
      { key: 'edge_6', source: 'condition_1', target: 'end_1', when: true },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  }
}

describe('画布 ↔ 定义 双向转换', () => {
  it('round-trips every field of a full definition', () => {
    const definition = fullDefinition()
    const rebuilt = fromFlow(toFlowNodes(definition), toFlowEdges(definition), definition.settings)
    expect(rebuilt).toEqual(definition)
  })

  it('keeps node order, config detail and edge attributes', () => {
    const definition = fullDefinition()
    const rebuilt = fromFlow(toFlowNodes(definition), toFlowEdges(definition), definition.settings)
    expect(rebuilt.nodes.map((node) => node.key)).toEqual(definition.nodes.map((node) => node.key))
    expect(rebuilt.nodes[1]?.config).toEqual(definition.nodes[1]?.config)
    expect(rebuilt.edges[2]).toEqual(definition.edges[2])
  })

  it('rounds float positions (drag) without touching other fields', () => {
    const definition = fullDefinition()
    const flowNodes = toFlowNodes(definition)
    item(flowNodes, 0).position = { x: 10.4, y: 20.6 }
    const rebuilt = fromFlow(flowNodes, toFlowEdges(definition), definition.settings)
    expect(rebuilt.nodes[0]?.position).toEqual({ x: 10, y: 21 })
    expect(rebuilt.nodes[0]?.config).toEqual({})
  })
})

describe('默认值与 key 分配', () => {
  it('creates unique keys per type', () => {
    const existing: WorkflowDefinition['nodes'] = []
    const first = createNode('agent_task', { x: 0, y: 0 }, existing)
    existing.push(first)
    const second = createNode('agent_task', { x: 10, y: 10 }, existing)
    expect(first.key).toBe('task_1')
    expect(second.key).toBe('task_2')
    expect(first.key).toMatch(/^[a-z0-9_-]{1,64}$/)
  })

  it('gives condition out-edges alternating when values', () => {
    const edges: WorkflowDefinition['edges'] = []
    const first = defaultEdgeAttributes('condition', 'condition_1', edges)
    expect(first).toEqual({ when: true })
    edges.push({ key: 'edge_1', source: 'condition_1', target: 'a', when: true })
    expect(defaultEdgeAttributes('condition', 'condition_1', edges)).toEqual({ when: false })
  })

  it('allocates unique branchKey for split out-edges', () => {
    const edges: WorkflowDefinition['edges'] = [
      { key: 'edge_1', source: 'split_1', target: 'a', branchKey: 'branch_1' },
    ]
    expect(defaultEdgeAttributes('parallel_split', 'split_1', edges)).toEqual({
      branchKey: 'branch_2',
    })
    expect(defaultEdgeAttributes('agent_task', 'task_1', edges)).toEqual({})
  })
})

describe('导入解析', () => {
  it('accepts a structurally valid definition (unknown fields are left to the server)', () => {
    const definition = { ...fullDefinition(), unexpected: true }
    const result = parseDefinitionJson(JSON.stringify(definition))
    expect(result.ok).toBe(true)
    if (result.ok)
      expect((result.definition as unknown as { unexpected?: boolean }).unexpected).toBe(true)
  })

  it('rejects malformed JSON', () => {
    const result = parseDefinitionJson('{')
    expect(result.ok).toBe(false)
  })

  it('rejects missing nodes/edges arrays', () => {
    expect(parseDefinitionJson('{"schemaVersion":1}').ok).toBe(false)
  })

  it('rejects unknown node types', () => {
    const definition = fullDefinition()
    definition.nodes[1] = { ...item(definition.nodes, 1), type: 'retry_loop' as never }
    expect(parseDefinitionJson(JSON.stringify(definition)).ok).toBe(false)
  })

  it('rejects duplicate node keys', () => {
    const definition = fullDefinition()
    definition.nodes[2] = { ...item(definition.nodes, 2), key: 'task_1' }
    expect(parseDefinitionJson(JSON.stringify(definition)).ok).toBe(false)
  })

  it('rejects edges pointing to missing nodes', () => {
    const definition = fullDefinition()
    definition.edges[0] = { ...item(definition.edges, 0), target: 'missing' }
    expect(parseDefinitionJson(JSON.stringify(definition)).ok).toBe(false)
  })

  it('rejects keys outside the schema charset', () => {
    const definition = fullDefinition()
    definition.nodes[0] = { ...item(definition.nodes, 0), key: 'Start Node' }
    expect(parseDefinitionJson(JSON.stringify(definition)).ok).toBe(false)
  })
})
