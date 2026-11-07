import { describe, expect, it } from 'vitest'
import { modelsForProvider } from './model-catalog'

describe('model catalog', () => {
  it('returns candidates for known providers', () => {
    expect(modelsForProvider('Claude Code').map((model) => model.id)).toEqual([
      'sonnet',
      'opus',
      'haiku',
    ])
    expect(modelsForProvider('Antigravity CLI').map((model) => model.id)).toContain(
      'gemini-3.8-flash-high',
    )
  })

  it('returns an empty list for unknown providers and lets the form use a custom id', () => {
    expect(modelsForProvider('CodeBuddy')).toEqual([])
    expect(modelsForProvider('Not A Provider')).toEqual([])
  })

  it('returns copies so callers cannot mutate the shared catalog', () => {
    const first = modelsForProvider('Claude Code')
    const firstModel = first[0]
    expect(firstModel).toBeDefined()
    if (firstModel) firstModel.id = 'mutated'
    expect(modelsForProvider('Claude Code')[0]?.id).toBe('sonnet')
  })
})
