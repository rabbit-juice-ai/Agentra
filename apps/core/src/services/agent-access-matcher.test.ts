import type { AgentProfile } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { findMatchingAgents, matchesAgentAccess } from './agent-access-matcher'

const NOW = '2026-11-07T00:00:00.000Z'

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agt-1',
    name: 'Agent',
    avatar: '🤖',
    description: '',
    systemPrompt: '',
    skillIds: [],
    accessMode: 'analyze',
    systemKind: null,
    model: null,
    toolPermissions: {
      version: 1,
      allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      deny: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    },
    defaultProviderId: 'claude-code',
    maxConcurrency: 5,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  }
}

describe('Agent 工作权限匹配', () => {
  it('只读分析 Agent 只承接 analyze 任务', () => {
    const analyzer = agent({ accessMode: 'analyze' })
    expect(matchesAgentAccess(analyzer, 'analyze')).toBe(true)
    expect(matchesAgentAccess(analyzer, 'edit')).toBe(false)
  })

  it('编辑 Agent 只承接 edit 任务（研发不能接分析/验收任务）', () => {
    const editor = agent({ accessMode: 'edit' })
    expect(matchesAgentAccess(editor, 'edit')).toBe(true)
    expect(matchesAgentAccess(editor, 'analyze')).toBe(false)
  })

  it('停用与归档 Agent 不参与匹配', () => {
    expect(matchesAgentAccess(agent({ status: 'disabled' }), 'analyze')).toBe(false)
    expect(matchesAgentAccess(agent({ status: 'archived' }), 'analyze')).toBe(false)
  })

  it('findMatchingAgents 按权限过滤并保持输入顺序', () => {
    const agents = [
      agent({ id: 'a1', accessMode: 'analyze' }),
      agent({ id: 'a2', accessMode: 'edit' }),
      agent({ id: 'a3', accessMode: 'analyze' }),
      agent({ id: 'a4', accessMode: 'edit', status: 'disabled' }),
    ]
    expect(findMatchingAgents(agents, 'analyze').map((item) => item.id)).toEqual(['a1', 'a3'])
    expect(findMatchingAgents(agents, 'edit').map((item) => item.id)).toEqual(['a2'])
  })
})
