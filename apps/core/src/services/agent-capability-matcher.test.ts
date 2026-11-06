import type { AgentProfile } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import {
  findMatchingAgents,
  matchesAgentCapabilities,
  missingCapabilities,
} from './agent-capability-matcher'

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agt-1',
    name: 'Frontend Agent',
    role: 'dev',
    description: '负责前端界面',
    systemPrompt: '',
    skills: [],
    capabilities: {
      taskTypes: ['frontend', 'react'],
      inputTypes: ['spec'],
      outputTypes: ['code'],
      canVerify: [],
      canApprove: [],
      excludedTaskTypes: [],
    },
    model: null,
    toolPermissions: { version: 1, allow: ['Read'], deny: [] },
    defaultProviderId: null,
    maxConcurrency: 1,
    status: 'active',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  }
}

describe('agent capability matcher', () => {
  it('matches an execute task by task type and required capabilities', () => {
    expect(
      matchesAgentCapabilities(agent(), {
        taskType: 'frontend',
        requiredCapabilities: ['react'],
      }),
    ).toBe(true)
    expect(
      matchesAgentCapabilities(agent(), {
        taskType: 'backend',
      }),
    ).toBe(false)
    expect(
      matchesAgentCapabilities(agent(), {
        taskType: 'frontend',
        requiredCapabilities: ['react', 'typescript'],
      }),
    ).toBe(false)
  })

  it('honours excluded task types', () => {
    const excluded = agent({
      capabilities: {
        ...agent().capabilities,
        excludedTaskTypes: ['backend'],
      },
    })
    expect(matchesAgentCapabilities(excluded, { taskType: 'backend' })).toBe(false)
  })

  it('uses canVerify for verification tasks', () => {
    const qa = agent({
      id: 'agt-qa',
      name: 'QA Agent',
      capabilities: {
        taskTypes: ['testing'],
        inputTypes: [],
        outputTypes: [],
        canVerify: ['frontend', 'backend'],
        canApprove: [],
        excludedTaskTypes: [],
      },
    })
    expect(
      matchesAgentCapabilities(qa, {
        taskType: 'frontend',
        kind: 'verify',
      }),
    ).toBe(true)
    expect(
      matchesAgentCapabilities(qa, {
        taskType: 'design',
        kind: 'verify',
      }),
    ).toBe(false)
  })

  it('uses canApprove for approval responsibilities', () => {
    const lead = agent({
      capabilities: {
        ...agent().capabilities,
        canApprove: ['plan'],
      },
    })
    expect(matchesAgentCapabilities(lead, { taskType: 'plan', kind: 'approve' })).toBe(true)
    expect(matchesAgentCapabilities(lead, { taskType: 'plan', kind: 'execute' })).toBe(false)
  })

  it('finds only active matching agents and reports gaps', () => {
    const archived = agent({ id: 'agt-archived', status: 'archived' })
    const match = agent({ id: 'agt-match' })
    const other = agent({
      id: 'agt-other',
      capabilities: {
        ...agent().capabilities,
        taskTypes: ['backend'],
      },
    })
    expect(
      findMatchingAgents([archived, match, other], { taskType: 'frontend' }).map((item) => item.id),
    ).toEqual(['agt-match'])
    expect(
      missingCapabilities(other, {
        taskType: 'frontend',
        requiredCapabilities: ['react'],
      }),
    ).toEqual(['react'])
  })
})
