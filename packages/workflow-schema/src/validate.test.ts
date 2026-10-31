import { describe, expect, it } from 'vitest'
import { validateWorkflowDefinition } from './validate'
import type { Violation } from './violations'

type Json = Record<string, unknown>

function baseDefinition(): Json {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      nodes: [
        { key: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          key: 'prd',
          type: 'agent_task',
          position: { x: 0, y: 1 },
          config: {
            assignmentSelector: { workRole: 'product' },
            taskPrompt: 'write prd',
            artifacts: [{ name: 'prd', type: 'markdown' }],
          },
        },
        { key: 'split', type: 'parallel_split', position: { x: 0, y: 2 }, config: {} },
        {
          key: 'ui',
          type: 'agent_task',
          position: { x: -1, y: 3 },
          config: {
            assignmentSelector: { workRole: 'ui' },
            taskPrompt: 'design ui',
            artifacts: [{ name: 'design', type: 'image' }],
          },
        },
        {
          key: 'backend',
          type: 'agent_task',
          position: { x: 1, y: 3 },
          config: {
            assignmentSelector: { workRole: 'backend' },
            taskPrompt: 'build api',
            artifacts: [{ name: 'api', type: 'code' }],
          },
        },
        {
          key: 'ui_approval',
          type: 'human_approval',
          position: { x: -1, y: 4 },
          config: { target: { nodeKey: 'ui', phase: 'after_execute' } },
        },
        {
          key: 'frontend',
          type: 'agent_task',
          position: { x: -1, y: 5 },
          config: {
            assignmentSelector: { workRole: 'frontend' },
            taskPrompt: 'build ui',
            inputArtifactRefs: [{ nodeKey: 'ui', artifactName: 'design' }],
          },
        },
        { key: 'join', type: 'join', position: { x: 0, y: 6 }, config: { pairWith: 'split' } },
        {
          key: 'testing',
          type: 'agent_task',
          position: { x: 0, y: 7 },
          config: {
            assignmentSelector: { workRole: 'qa' },
            taskPrompt: 'run tests',
            outputContract: { profile: 'test_result' },
          },
        },
        {
          key: 'condition',
          type: 'condition',
          position: { x: 0, y: 8 },
          config: {
            predicate: {
              kind: 'comparison',
              op: '==',
              left: { kind: 'field', path: 'nodes.testing.output.pass' },
              right: { kind: 'literal', value: true },
            },
            falseBranch: { kind: 'rework', reportNodeKey: 'testing' },
          },
        },
        { key: 'end', type: 'end', position: { x: 0, y: 9 }, config: {} },
      ],
      edges: [
        { key: 'e_start_prd', source: 'start', target: 'prd' },
        { key: 'e_prd_split', source: 'prd', target: 'split' },
        { key: 'e_split_ui', source: 'split', target: 'ui', branchKey: 'ui' },
        { key: 'e_split_backend', source: 'split', target: 'backend', branchKey: 'backend' },
        { key: 'e_ui_approval', source: 'ui', target: 'ui_approval' },
        { key: 'e_approval_frontend', source: 'ui_approval', target: 'frontend' },
        { key: 'e_frontend_join', source: 'frontend', target: 'join' },
        { key: 'e_backend_join', source: 'backend', target: 'join' },
        { key: 'e_join_testing', source: 'join', target: 'testing' },
        { key: 'e_testing_condition', source: 'testing', target: 'condition' },
        { key: 'e_condition_end', source: 'condition', target: 'end', when: true },
      ],
    }),
  ) as Json
}

function node(def: Json, key: string): Json {
  const nodes = def.nodes as Json[]
  const found = nodes.find((item) => item.key === key)
  if (!found) throw new Error(`missing node ${key}`)
  return found
}

function edge(def: Json, key: string): Json {
  const edges = def.edges as Json[]
  const found = edges.find((item) => item.key === key)
  if (!found) throw new Error(`missing edge ${key}`)
  return found
}

function violationsOf(def: Json): Violation[] {
  const result = validateWorkflowDefinition(def)
  if (result.ok) return []
  if (result.kind === 'error') throw new Error(`unexpected error outcome: ${result.code}`)
  return result.violations
}

function codes(def: Json): string[] {
  return violationsOf(def).map((item) => item.violation)
}

describe('validateWorkflowDefinition — 基线', () => {
  it('accepts the reference definition', () => {
    const result = validateWorkflowDefinition(baseDefinition())
    expect(result.ok).toBe(true)
  })

  it('returns UNKNOWN_NODE_TYPE as an error code, not a violation', () => {
    const def = baseDefinition()
    ;(node(def, 'testing') as Json).type = 'retry_loop'
    const result = validateWorkflowDefinition(def)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.code).toBe('UNKNOWN_NODE_TYPE')
    expect(result.nodeKey).toBe('testing')
    expect(result).not.toHaveProperty('violations')
  })

  it('maps strict config errors to node_config_invalid', () => {
    const def = baseDefinition()
    ;((node(def, 'ui') as Json).config as Json).permissionProfile = {}
    expect(codes(def)).toContain('node_config_invalid')
  })
})

describe('图规则 1–12', () => {
  it('rule 1: requires exactly one start', () => {
    const def = baseDefinition()
    ;(node(def, 'start') as Json).type = 'agent_task'
    ;(node(def, 'start') as Json).config = {
      assignmentSelector: { workRole: 'x' },
      taskPrompt: 'x',
    }
    expect(codes(def)).toContain('start_invalid')
  })

  it('rule 1: multiple starts carry nodeKey so the UI can locate them (F-2)', () => {
    const def = baseDefinition()
    ;(def.nodes as Json[]).push({
      key: 'start_2',
      type: 'start',
      position: { x: 5, y: 5 },
      config: {},
    })
    const startViolations = violationsOf(def).filter((item) => item.violation === 'start_invalid')
    expect(startViolations.length).toBeGreaterThan(0)
    expect(startViolations[0]?.nodeKey).toBe('start')
    expect(startViolations[0]?.message).toContain('start_2')
  })

  it('rule 2: requires at least one end', () => {
    const def = baseDefinition()
    ;(node(def, 'end') as Json).type = 'agent_task'
    ;(node(def, 'end') as Json).config = {
      assignmentSelector: { workRole: 'x' },
      taskPrompt: 'x',
    }
    expect(codes(def)).toContain('end_invalid')
  })

  it('rule 3: reports unreachable nodes', () => {
    const def = baseDefinition()
    ;(def.nodes as Json[]).push({
      key: 'orphan',
      type: 'agent_task',
      position: { x: 9, y: 9 },
      config: { assignmentSelector: { workRole: 'x' }, taskPrompt: 'x' },
    })
    ;(def.edges as Json[]).push({ key: 'e_orphan_end', source: 'orphan', target: 'end' })
    expect(codes(def)).toContain('unreachable_node')
  })

  it('rule 4: reports cycles', () => {
    const def = baseDefinition()
    ;(def.edges as Json[]).push({ key: 'e_back', source: 'testing', target: 'prd' })
    expect(codes(def)).toContain('cycle')
  })

  it('rule 5: reports self-loops and duplicate edges', () => {
    const def = baseDefinition()
    ;(def.edges as Json[]).push({ key: 'e_self', source: 'prd', target: 'prd' })
    ;(def.edges as Json[]).push({ key: 'e_dup', source: 'start', target: 'prd' })
    const found = codes(def)
    expect(found).toContain('edge_invalid')
  })

  it('rule 6: reports duplicate keys', () => {
    const def = baseDefinition()
    ;(def.nodes as Json[]).push({
      key: 'prd',
      type: 'agent_task',
      position: { x: 5, y: 5 },
      config: { assignmentSelector: { workRole: 'x' }, taskPrompt: 'x' },
    })
    expect(codes(def)).toContain('key_duplicate')
  })

  it('rule 7: reports degree violations', () => {
    const def = baseDefinition()
    const edges = def.edges as Json[]
    def.edges = edges.filter((item) => item.key !== 'e_join_testing')
    expect(codes(def)).toContain('degree_invalid')
  })

  it('rule 8: condition needs exactly one when=true edge', () => {
    const def = baseDefinition()
    ;(edge(def, 'e_condition_end') as Json).when = false
    expect(codes(def)).toContain('condition_invalid')
  })

  it('rule 9: split out-edges need branchKey', () => {
    const def = baseDefinition()
    delete (edge(def, 'e_split_ui') as Json).branchKey
    expect(codes(def)).toContain('branch_invalid')
  })

  it('rule 9: every branch must reach the paired join', () => {
    const def = baseDefinition()
    const edges = def.edges as Json[]
    def.edges = edges.filter((item) => item.key !== 'e_backend_join')
    ;(def.edges as Json[]).push({ key: 'e_backend_end2', source: 'backend', target: 'end' })
    expect(codes(def)).toContain('branch_invalid')
  })

  it('rule 9: pairing must be unique', () => {
    const def = baseDefinition()
    ;(node(def, 'join') as Json).config = { pairWith: 'prd' }
    expect(codes(def)).toContain('branch_invalid')
  })

  it('rule 10: inputArtifactRefs must reference a declared ancestor artifact', () => {
    const def = baseDefinition()
    ;((node(def, 'frontend') as Json).config as Json).inputArtifactRefs = [
      { nodeKey: 'ui', artifactName: 'missing' },
    ]
    expect(codes(def)).toContain('agent_task_invalid')
  })

  it('rule 11: approval target must be an agent_task', () => {
    const def = baseDefinition()
    ;((node(def, 'ui_approval') as Json).config as Json).target = {
      nodeKey: 'join',
      phase: 'after_execute',
    }
    expect(codes(def)).toContain('approval_invalid')
  })

  it('rule 11: before_execute approval must sit upstream of its target', () => {
    const def = baseDefinition()
    ;((node(def, 'ui_approval') as Json).config as Json).target = {
      nodeKey: 'ui',
      phase: 'before_execute',
    }
    expect(codes(def)).toContain('approval_invalid')
  })

  it('rule 12: rejects out-of-range settings', () => {
    const def = baseDefinition()
    def.settings = { concurrency: { maxParallelNodes: 99 } }
    expect(codes(def)).toContain('settings_invalid')
  })

  it('collects multiple violations instead of short-circuiting', () => {
    const def = baseDefinition()
    ;(node(def, 'start') as Json).type = 'agent_task'
    ;(node(def, 'start') as Json).config = {
      assignmentSelector: { workRole: 'x' },
      taskPrompt: 'x',
    }
    ;(def.nodes as Json[]).push({
      key: 'prd',
      type: 'end',
      position: { x: 0, y: 0 },
      config: {},
    })
    const found = codes(def)
    expect(found).toContain('start_invalid')
    expect(found).toContain('key_duplicate')
  })
})

describe('条件表达式', () => {
  it('rejects paths outside the whitelist', () => {
    const def = baseDefinition()
    ;((node(def, 'condition') as Json).config as Json).predicate = {
      kind: 'comparison',
      op: '==',
      left: { kind: 'field', path: 'workflow.status' },
      right: { kind: 'literal', value: 'ok' },
    }
    expect(codes(def)).toContain('expression_invalid')
  })

  it('rejects output fields not declared by the source node', () => {
    const def = baseDefinition()
    ;((node(def, 'condition') as Json).config as Json).predicate = {
      kind: 'comparison',
      op: '==',
      left: { kind: 'field', path: 'nodes.testing.output.unknown' },
      right: { kind: 'literal', value: true },
    }
    expect(codes(def)).toContain('expression_invalid')
  })

  it('accepts the five fixed test_result fields', () => {
    const def = baseDefinition()
    for (const field of ['failureReason', 'relatedTasks', 'impactScope', 'relatedArtifacts']) {
      ;((node(def, 'condition') as Json).config as Json).predicate = {
        kind: 'comparison',
        op: '!=',
        left: { kind: 'field', path: `nodes.testing.output.${field}` },
        right: { kind: 'literal', value: 'x' },
      }
      expect(validateWorkflowDefinition(def).ok).toBe(true)
    }
  })

  it('rejects expressions deeper than 10', () => {
    const def = baseDefinition()
    let predicate: Json = {
      kind: 'comparison',
      op: '==',
      left: { kind: 'field', path: 'nodes.testing.output.pass' },
      right: { kind: 'literal', value: true },
    }
    for (let index = 0; index < 10; index += 1) {
      predicate = { kind: 'not', operand: predicate }
    }
    ;((node(def, 'condition') as Json).config as Json).predicate = predicate
    expect(codes(def)).toContain('expression_invalid')
  })

  it('requires numeric literals for ordering operators', () => {
    const def = baseDefinition()
    ;((node(def, 'condition') as Json).config as Json).predicate = {
      kind: 'comparison',
      op: '>',
      left: { kind: 'field', path: 'nodes.testing.output.impactScope' },
      right: { kind: 'literal', value: 'x' },
    }
    expect(codes(def)).toContain('expression_invalid')
  })

  it('rejects a rework report node without test_result profile', () => {
    const def = baseDefinition()
    ;((node(def, 'testing') as Json).config as Json).outputContract = { profile: 'generic' }
    const found = codes(def)
    expect(found).toContain('condition_invalid')
    expect(found).toContain('expression_invalid')
  })
})

describe('结构解析与图规则的边界', () => {
  it('skips graph rules when the definition cannot be parsed', () => {
    const def = baseDefinition()
    def.edges = 'not-an-array'
    const found = codes(def)
    expect(found).toContain('edge_invalid')
  })

  it('reports unsupported schemaVersion as settings_invalid', () => {
    const def = baseDefinition()
    def.schemaVersion = 2
    expect(codes(def)).toContain('settings_invalid')
  })
})
