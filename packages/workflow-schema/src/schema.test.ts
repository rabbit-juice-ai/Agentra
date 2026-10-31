import { describe, expect, it } from 'vitest'
import { findUnknownNodeTypes, WorkflowDefinitionSchema } from './schema'

function validDefinition() {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task',
        type: 'agent_task',
        position: { x: 0, y: 1 },
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'do the thing',
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

describe('WorkflowDefinitionSchema', () => {
  it('applies defaults for settings and node fields', () => {
    const parsed = WorkflowDefinitionSchema.parse(validDefinition())
    expect(parsed.settings).toEqual({
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    })
    const task = parsed.nodes[1]
    expect(task?.type).toBe('agent_task')
    if (task?.type !== 'agent_task') throw new Error('expected an agent_task node')
    expect(task.label).toBe('')
    expect(task.config.workingDirectoryPolicy).toBe('work_root')
    expect(task.config.outputContract).toEqual({ profile: 'generic', fields: [] })
    expect(task.config.artifacts[0]?.required).toBe(true)
  })

  it('rejects unknown fields in config (strict)', () => {
    const def = validDefinition()
    const task = def.nodes[1] as Record<string, unknown>
    ;(task.config as Record<string, unknown>).permissionProfile = { allow: [] }
    const result = WorkflowDefinitionSchema.safeParse(def)
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level fields', () => {
    const def = { ...validDefinition(), branches: [] }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects test_result with custom fields', () => {
    const def = validDefinition()
    const task = def.nodes[1] as Record<string, unknown>
    ;(task.config as Record<string, unknown>).outputContract = {
      profile: 'test_result',
      fields: [{ name: 'x', type: 'string', required: true }],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('accepts test_result with no custom fields', () => {
    const def = validDefinition()
    const task = def.nodes[1] as Record<string, unknown>
    ;(task.config as Record<string, unknown>).outputContract = { profile: 'test_result' }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects out-of-range settings', () => {
    const def = validDefinition()
    ;(def as Record<string, unknown>).settings = { reworkPolicy: { maxRounds: 3 } }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects unknown schemaVersion', () => {
    const def = { ...validDefinition(), schemaVersion: 2 }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('enforces key pattern', () => {
    const def = validDefinition()
    ;(def.nodes[0] as Record<string, unknown>).key = 'Start Node'
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })
})

describe('findUnknownNodeTypes', () => {
  it('detects types outside the whitelist', () => {
    const def = validDefinition()
    ;(def.nodes[1] as Record<string, unknown>).type = 'retry_loop'
    expect(findUnknownNodeTypes(def)).toEqual([{ nodeKey: 'task', type: 'retry_loop' }])
  })

  it('returns empty for the known seven types', () => {
    expect(findUnknownNodeTypes(validDefinition())).toEqual([])
  })

  it('tolerates malformed input', () => {
    expect(findUnknownNodeTypes(null)).toEqual([])
    expect(findUnknownNodeTypes({ nodes: 'nope' })).toEqual([])
  })
})
