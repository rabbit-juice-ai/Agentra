import type { ConditionExpr, ConditionLiteral } from '@agentra/workflow-schema'
import { describe, expect, it } from 'vitest'
import { type ConditionContext, evaluateCondition } from './condition-evaluator'

function context(): ConditionContext {
  return new Map([
    [
      'task_1',
      { status: 'succeeded', attempt: 2, output: { pass: true, scope: 'api', note: null } },
    ],
    ['task_2', { status: 'failed', attempt: 1, output: null }],
  ])
}

const field = (path: string) => ({ kind: 'field' as const, path })
const literal = (value: ConditionLiteral | ConditionLiteral[]) => ({
  kind: 'literal' as const,
  value,
})

describe('evaluateCondition', () => {
  it('compares node status and attempt', () => {
    expect(
      evaluateCondition(
        {
          kind: 'comparison',
          op: '==',
          left: field('nodes.task_1.status'),
          right: literal('succeeded'),
        },
        context(),
      ),
    ).toEqual({ ok: true, value: true })
    expect(
      evaluateCondition(
        { kind: 'comparison', op: '>=', left: field('nodes.task_1.attempt'), right: literal(2) },
        context(),
      ),
    ).toEqual({ ok: true, value: true })
  })

  it('reads declared output fields', () => {
    expect(
      evaluateCondition(
        {
          kind: 'comparison',
          op: '==',
          left: field('nodes.task_1.output.pass'),
          right: literal(true),
        },
        context(),
      ),
    ).toEqual({ ok: true, value: true })
  })

  it('supports in / and / or / not', () => {
    const expr: ConditionExpr = {
      kind: 'logical',
      op: 'and' as const,
      operands: [
        {
          kind: 'comparison' as const,
          op: 'in' as const,
          left: field('nodes.task_1.output.scope'),
          right: literal(['api', 'web']),
        },
        {
          kind: 'not' as const,
          operand: {
            kind: 'comparison' as const,
            op: '==',
            left: field('nodes.task_2.status'),
            right: literal('succeeded'),
          },
        },
      ],
    }
    expect(evaluateCondition(expr, context())).toEqual({ ok: true, value: true })
  })

  it('allows null only with == / !=', () => {
    expect(
      evaluateCondition(
        {
          kind: 'comparison',
          op: '==',
          left: field('nodes.task_1.output.note'),
          right: literal(null),
        },
        context(),
      ),
    ).toEqual({ ok: true, value: true })
  })

  it('fails on missing output field instead of treating it as false', () => {
    const result = evaluateCondition(
      {
        kind: 'comparison',
        op: '==',
        left: field('nodes.task_2.output.pass'),
        right: literal(true),
      },
      context(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('missing')
  })

  it('fails on type mismatch', () => {
    const result = evaluateCondition(
      {
        kind: 'comparison',
        op: '==',
        left: field('nodes.task_1.output.pass'),
        right: literal('true'),
      },
      context(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('type mismatch')
  })

  it('rejects object/array equality instead of silently comparing references', () => {
    const result = evaluateCondition(
      {
        kind: 'comparison',
        op: '==',
        left: field('nodes.task_1.output.tags'),
        right: literal(['api']),
      },
      new Map([['task_1', { status: 'succeeded', attempt: 1, output: { tags: ['api'] } }]]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('primitive')
  })

  it('fails on non-numeric ordering comparison', () => {
    const result = evaluateCondition(
      { kind: 'comparison', op: '>', left: field('nodes.task_1.status'), right: literal(1) },
      context(),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects paths outside the whitelist', () => {
    const result = evaluateCondition(
      { kind: 'comparison', op: '==', left: field('workflow.status'), right: literal('ok') },
      context(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('whitelist')
  })
})
