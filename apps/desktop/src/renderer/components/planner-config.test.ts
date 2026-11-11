import { describe, expect, it } from 'vitest'
import { plannerDraftMatches } from './planner-config'

const saved = {
  name: '规划助手',
  avatar: '🧭',
  providerId: 'claude-code',
  model: 'sonnet',
}

function draft(overrides: Partial<typeof saved> = {}): typeof saved {
  return { ...saved, ...overrides }
}

describe('plannerDraftMatches', () => {
  it('treats identical config as unchanged', () => {
    expect(plannerDraftMatches(draft(), saved)).toBe(true)
  })

  it('detects a name-only change', () => {
    expect(plannerDraftMatches(draft({ name: '新名字' }), saved)).toBe(false)
  })

  it('detects an avatar-only change', () => {
    expect(plannerDraftMatches(draft({ avatar: '🤖' }), saved)).toBe(false)
  })

  it('detects provider and model changes', () => {
    expect(plannerDraftMatches(draft({ providerId: 'codex' }), saved)).toBe(false)
    expect(plannerDraftMatches(draft({ model: 'opus' }), saved)).toBe(false)
  })

  it('treats a blank model and surrounding name whitespace as unchanged', () => {
    expect(plannerDraftMatches(draft({ model: '   ' }), { ...saved, model: null })).toBe(true)
    expect(plannerDraftMatches(draft({ name: '  规划助手  ' }), saved)).toBe(true)
  })
})
