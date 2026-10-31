import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { describe, expect, it } from 'vitest'
import { evaluateReadiness, type NodeStateView, ROOT_BRANCH_KEY, resolveBranchKeys } from './graph'
import type { NodeRunStatus } from './state-machine'

function parallelDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'prd',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 1 },
        config: { assignmentSelector: { workRole: 'product' }, taskPrompt: 'x' },
      },
      { key: 'split_1', type: 'parallel_split', label: '', position: { x: 0, y: 2 }, config: {} },
      {
        key: 'ui',
        type: 'agent_task',
        label: '',
        position: { x: -1, y: 3 },
        config: { assignmentSelector: { workRole: 'ui' }, taskPrompt: 'x' },
      },
      {
        key: 'backend',
        type: 'agent_task',
        label: '',
        position: { x: 1, y: 3 },
        config: { assignmentSelector: { workRole: 'backend' }, taskPrompt: 'x' },
      },
      {
        key: 'join_1',
        type: 'join',
        label: '',
        position: { x: 0, y: 4 },
        config: { pairWith: 'split_1' },
      },
      {
        key: 'qa',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 5 },
        config: { assignmentSelector: { workRole: 'qa' }, taskPrompt: 'x' },
      },
      { key: 'end_1', type: 'end', label: '', position: { x: 0, y: 6 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'prd' },
      { key: 'e2', source: 'prd', target: 'split_1' },
      { key: 'e3', source: 'split_1', target: 'ui', branchKey: 'ui' },
      { key: 'e4', source: 'split_1', target: 'backend', branchKey: 'backend' },
      { key: 'e5', source: 'ui', target: 'join_1' },
      { key: 'e6', source: 'backend', target: 'join_1' },
      { key: 'e7', source: 'join_1', target: 'qa' },
      { key: 'e8', source: 'qa', target: 'end_1' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

function conditionDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'cond',
        type: 'condition',
        label: '',
        position: { x: 0, y: 1 },
        config: {
          predicate: {
            kind: 'comparison',
            op: '==',
            left: { kind: 'field', path: 'nodes.start.status' },
            right: { kind: 'literal', value: 'succeeded' },
          },
          falseBranch: 'edge',
        },
      },
      { key: 'end_1', type: 'end', label: '', position: { x: 0, y: 2 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'cond' },
      { key: 'e2', source: 'cond', target: 'end_1', when: true },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

function states(entries: Record<string, NodeStateView>): Map<string, NodeStateView> {
  return new Map(Object.entries(entries))
}

function allBlocked(definition: WorkflowDefinition): Map<string, NodeStateView> {
  return states(
    Object.fromEntries(
      definition.nodes.map((node) => [
        node.key,
        { status: 'blocked' as NodeRunStatus, output: null },
      ]),
    ),
  )
}

describe('resolveBranchKeys', () => {
  it('maps split regions to <splitKey>/<branchKey> and everything else to root', () => {
    const keys = resolveBranchKeys(parallelDefinition())
    expect(keys.get('start')).toBe(ROOT_BRANCH_KEY)
    expect(keys.get('prd')).toBe(ROOT_BRANCH_KEY)
    expect(keys.get('split_1')).toBe(ROOT_BRANCH_KEY)
    expect(keys.get('ui')).toBe('split_1/ui')
    expect(keys.get('backend')).toBe('split_1/backend')
    expect(keys.get('join_1')).toBe(ROOT_BRANCH_KEY)
    expect(keys.get('qa')).toBe(ROOT_BRANCH_KEY)
    expect(keys.get('end_1')).toBe(ROOT_BRANCH_KEY)
  })
})

describe('evaluateReadiness · 基本推进', () => {
  it('promotes start first and then follows succeeded predecessors', () => {
    const definition = parallelDefinition()
    const blocked = allBlocked(definition)
    expect(evaluateReadiness(definition, blocked).ready).toEqual(['start'])

    const afterStart = new Map(blocked)
    afterStart.set('start', { status: 'succeeded', output: null })
    expect(evaluateReadiness(definition, afterStart).ready).toEqual(['prd'])
  })

  it('keeps downstream blocked while a predecessor is still running', () => {
    const definition = parallelDefinition()
    const state = allBlocked(definition)
    state.set('start', { status: 'succeeded', output: null })
    state.set('prd', { status: 'running', output: null })
    const result = evaluateReadiness(definition, state)
    expect(result.ready).toEqual([])
    expect(result.pending.get('split_1')).toContain('predecessor_pending')
  })

  it('reports failed predecessors instead of silently skipping them', () => {
    const definition = parallelDefinition()
    const state = allBlocked(definition)
    state.set('start', { status: 'succeeded', output: null })
    state.set('prd', { status: 'failed', output: null })
    const result = evaluateReadiness(definition, state)
    expect(result.failedPredecessors.get('split_1')).toEqual(['prd'])
    expect(result.ready).toEqual([])
  })
})

describe('evaluateReadiness · join', () => {
  it('waits for every branch to succeed', () => {
    const definition = parallelDefinition()
    const state = allBlocked(definition)
    for (const key of ['start', 'prd', 'split_1', 'ui']) {
      state.set(key, { status: 'succeeded', output: null })
    }
    state.set('backend', { status: 'running', output: null })

    expect(evaluateReadiness(definition, state).ready).not.toContain('join_1')

    state.set('backend', { status: 'succeeded', output: null })
    expect(evaluateReadiness(definition, state).ready).toContain('join_1')
  })
})

describe('evaluateReadiness · condition 出边', () => {
  it('routes only the taken when-edge', () => {
    const definition = conditionDefinition()
    const state = allBlocked(definition)
    state.set('start', { status: 'succeeded', output: null })
    state.set('cond', { status: 'succeeded', output: { when: true } })

    expect(evaluateReadiness(definition, state).ready).toContain('end_1')

    state.set('cond', { status: 'succeeded', output: { when: false } })
    const notTaken = evaluateReadiness(definition, state)
    expect(notTaken.ready).not.toContain('end_1')
    expect(notTaken.pending.get('end_1')).toBe('no_taken_edge')
  })

  it('treats a missing condition outcome as pending, not as false', () => {
    const definition = conditionDefinition()
    const state = allBlocked(definition)
    state.set('start', { status: 'succeeded', output: null })
    state.set('cond', { status: 'succeeded', output: null })

    const result = evaluateReadiness(definition, state)
    expect(result.ready).not.toContain('end_1')
    expect(result.pending.get('end_1')).toContain('condition_outcome_missing')
  })
})
