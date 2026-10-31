import { describe, expect, it } from 'vitest'
import { canonicalize, computeChecksum } from './checksum'
import { type WorkflowDefinition, WorkflowDefinitionSchema } from './schema'

type Json = Record<string, unknown>

function rawDefinition(): Json {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task',
        type: 'agent_task',
        label: 'Task',
        position: { x: 0, y: 1 },
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'do it',
          artifacts: [{ name: 'report', type: 'markdown' }],
        },
      },
      { key: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task' },
      { key: 'e2', source: 'task', target: 'end' },
    ],
  }
}

function itemAt(def: Json, field: 'nodes' | 'edges', index: number): Json {
  const items = def[field] as Json[]
  const item = items[index]
  if (!item) throw new Error(`missing ${field}[${index}]`)
  return item
}

function parsed(mutate: (def: Json) => void = () => {}): WorkflowDefinition {
  const def = rawDefinition()
  mutate(def)
  return WorkflowDefinitionSchema.parse(def)
}

const reference = computeChecksum(parsed())

describe('checksum 等价类 E1–E5（必须相同）', () => {
  it('E1: object key order does not matter', () => {
    const a = JSON.parse(
      '{"schemaVersion":1,"nodes":[{"key":"start","type":"start","position":{"x":0,"y":0},"config":{}},{"key":"task","type":"agent_task","label":"Task","position":{"x":0,"y":1},"config":{"taskPrompt":"do it","assignmentSelector":{"workRole":"dev"},"artifacts":[{"type":"markdown","name":"report"}]}},{"key":"end","type":"end","position":{"x":0,"y":2},"config":{}}],"edges":[{"key":"e1","source":"start","target":"task"},{"key":"e2","source":"task","target":"end"}]}',
    )
    expect(computeChecksum(WorkflowDefinitionSchema.parse(a))).toBe(reference)
  })

  it('E2: whitespace in the serialized form does not matter', () => {
    const compact = JSON.stringify(rawDefinition())
    const pretty = JSON.stringify(rawDefinition(), null, 2)
    expect(computeChecksum(WorkflowDefinitionSchema.parse(JSON.parse(compact)))).toBe(reference)
    expect(computeChecksum(WorkflowDefinitionSchema.parse(JSON.parse(pretty)))).toBe(reference)
  })

  it('E3: 1, 1.0 and 1e0 are the same number', () => {
    const variants = ['0', '0.0', '0e0'].map((literal) =>
      JSON.parse(
        `{"schemaVersion":1,"nodes":[{"key":"start","type":"start","position":{"x":${literal},"y":0},"config":{}},{"key":"task","type":"agent_task","label":"Task","position":{"x":0,"y":1},"config":{"assignmentSelector":{"workRole":"dev"},"taskPrompt":"do it","artifacts":[{"name":"report","type":"markdown"}]}},{"key":"end","type":"end","position":{"x":0,"y":2},"config":{}}],"edges":[{"key":"e1","source":"start","target":"task"},{"key":"e2","source":"task","target":"end"}]}`,
      ),
    )
    for (const variant of variants) {
      expect(computeChecksum(WorkflowDefinitionSchema.parse(variant))).toBe(reference)
    }
  })

  it('E4: NFC and NFD spellings hash identically', () => {
    const nfc = computeChecksum(
      parsed((def) => {
        itemAt(def, 'nodes', 1).label = 'café'
      }),
    )
    const nfd = computeChecksum(
      parsed((def) => {
        itemAt(def, 'nodes', 1).label = 'café'
      }),
    )
    expect(nfd).toBe(nfc)
  })

  it('E5: array order of nodes and edges does not matter', () => {
    const reordered = computeChecksum(
      parsed((def) => {
        def.nodes = [...(def.nodes as Json[])].reverse()
        def.edges = [...(def.edges as Json[])].reverse()
      }),
    )
    expect(reordered).toBe(reference)
  })
})

describe('checksum 必须不同 D1–D5', () => {
  it('D1: different node key', () => {
    const other = computeChecksum(
      parsed((def) => {
        itemAt(def, 'nodes', 1).key = 'task2'
        itemAt(def, 'edges', 0).target = 'task2'
        itemAt(def, 'edges', 1).source = 'task2'
      }),
    )
    expect(other).not.toBe(reference)
  })

  it('D2: different taskPrompt', () => {
    const other = computeChecksum(
      parsed((def) => {
        ;(itemAt(def, 'nodes', 1).config as Json).taskPrompt = 'do something else'
      }),
    )
    expect(other).not.toBe(reference)
  })

  it('D3: different edge wiring', () => {
    const other = computeChecksum(
      parsed((def) => {
        itemAt(def, 'edges', 1).target = 'start'
      }),
    )
    expect(other).not.toBe(reference)
  })

  it('D4: different settings', () => {
    const other = computeChecksum(
      parsed((def) => {
        def.settings = { reworkPolicy: { maxRounds: 1 } }
      }),
    )
    expect(other).not.toBe(reference)
  })

  it('D5: different label / position', () => {
    const label = computeChecksum(
      parsed((def) => {
        itemAt(def, 'nodes', 1).label = 'Renamed'
      }),
    )
    const position = computeChecksum(
      parsed((def) => {
        ;(itemAt(def, 'nodes', 1).position as Json).x = 42
      }),
    )
    expect(label).not.toBe(reference)
    expect(position).not.toBe(reference)
  })
})

describe('canonicalize', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalize({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}')
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
  })

  it('drops undefined object properties', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})
