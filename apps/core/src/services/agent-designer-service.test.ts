import type { AgentProfile, Execution, RuntimeProviderRecord, Skill } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { AgentDesignerService } from './agent-designer-service'
import { toolPermissionsForAccessMode } from './agent-service'

const NOW = '2026-11-07T00:00:00.000Z'

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const accessMode = overrides.accessMode ?? 'analyze'
  return {
    id: 'agt-designer',
    name: 'Agent 设计师',
    avatar: '✨',
    description: '',
    systemPrompt: '',
    skillIds: [],
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: 'claude-code',
    maxConcurrency: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  }
}

function provider(overrides: Partial<RuntimeProviderRecord> = {}): RuntimeProviderRecord {
  return {
    id: 'claude-code',
    providerType: 'cli',
    providerName: 'Claude Code',
    executablePath: '/usr/local/bin/claude',
    version: '2.1.318',
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'native',
      checkpoint: 'unsupported',
      permissionRequests: 'native',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    healthStatus: 'healthy',
    authMethod: 'oauth_token',
    healthDetail: null,
    lastDiscoveredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skl-1',
    name: '需求评审清单',
    description: '评审需求时使用',
    instructions: '检查目标、边界与验收标准。',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'exe-designer',
    sessionId: 'ses-designer',
    providerId: 'claude-code',
    agentId: 'agt-designer',
    externalExecutionId: null,
    processId: null,
    status: 'running',
    workingDirectory: '/tmp/agentra/scratch/exe-designer',
    startedAt: NOW,
    endedAt: null,
    exitCode: null,
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function harness(
  output: unknown,
  status: Execution['status'] = 'succeeded',
  options: { agents?: AgentProfile[]; providers?: RuntimeProviderRecord[]; skills?: Skill[] } = {},
) {
  const created: AgentProfile[] = []
  let started = false
  const service = new AgentDesignerService({
    agents: {
      list: () => options.agents ?? [],
      create: (params, createOptions) => {
        const createdAgent = agent({
          id: 'agt-designer',
          name: params.name,
          avatar: params.avatar ?? '✨',
          description: params.description ?? '',
          systemPrompt: params.systemPrompt ?? '',
          skillIds: params.skillIds ?? [],
          accessMode: params.accessMode ?? 'analyze',
          systemKind: createOptions?.systemKind ?? null,
          model: params.model ?? null,
          defaultProviderId: params.defaultProviderId,
          maxConcurrency: params.maxConcurrency ?? 1,
        })
        created.push(createdAgent)
        return createdAgent
      },
      update: (params) => {
        const base =
          created.find((item) => item.id === params.id) ??
          (options.agents ?? []).find((item) => item.id === params.id) ??
          agent()
        return {
          ...base,
          id: params.id,
          name: params.name ?? base.name,
          avatar: params.avatar ?? base.avatar,
          description: params.description ?? base.description,
          systemPrompt: params.systemPrompt ?? base.systemPrompt,
          skillIds: params.skillIds ?? base.skillIds,
          accessMode: params.accessMode ?? base.accessMode,
          model: params.model === undefined ? base.model : params.model,
          defaultProviderId:
            params.defaultProviderId === undefined
              ? base.defaultProviderId
              : params.defaultProviderId,
          maxConcurrency: params.maxConcurrency ?? base.maxConcurrency,
          status: params.status ?? base.status,
        }
      },
    },
    executions: {
      start: async () => {
        started = true
        return execution()
      },
      get: () => execution({ status }),
      cancel: async () => execution({ status: 'cancelled' }),
    },
    providers: { list: () => options.providers ?? [provider()] },
    skills: { list: () => options.skills ?? [skill()] },
    extractOutput: () => output as Record<string, unknown>,
    pollIntervalMs: 0,
    timeoutMs: 100,
  })
  return { service, created, started: () => started }
}

describe('AgentDesignerService', () => {
  it('generates a structured draft and filters unknown skills', async () => {
    const h = harness(
      {
        name: '  项目经理  ',
        avatar: '🧭',
        description: '负责需求拆解、排期与验收标准；在需要规划任务时调用。',
        systemPrompt: '你是项目经理。先澄清目标与边界，再拆解任务。',
        accessMode: 'analyze',
        skillIds: ['skl-1', 'skl-missing', 'skl-1'],
        maxConcurrency: 9,
      },
      'succeeded',
    )
    const result = await h.service.generateDraft('项目经理')
    expect(h.started()).toBe(true)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      systemKind: 'agent_designer',
      accessMode: 'analyze',
      defaultProviderId: 'claude-code',
      model: 'sonnet',
    })
    expect(result.source).toBe('ai')
    expect(result.designerExecutionId).toBe('exe-designer')
    expect(result.draft).toMatchObject({
      name: '项目经理',
      avatar: '🧭',
      accessMode: 'analyze',
      skillIds: ['skl-1'],
      maxConcurrency: 9,
    })
  })

  it('reuses an existing agent designer instead of creating a duplicate', async () => {
    const existing = agent({ id: 'agt-designer-existing', systemKind: 'agent_designer' })
    const h = harness(
      {
        name: '测试工程师',
        avatar: '🧪',
        description: '负责验收。',
        systemPrompt: '你是测试工程师。',
        accessMode: 'analyze',
        skillIds: [],
        maxConcurrency: 5,
      },
      'succeeded',
      { agents: [existing] },
    )
    const result = await h.service.generateDraft('测试工程师')
    expect(result.source).toBe('ai')
    expect(h.created).toHaveLength(0)
  })

  it('falls back to a deterministic draft when the designer execution fails', async () => {
    const h = harness({}, 'failed', { skills: [skill()] })
    const result = await h.service.generateDraft('项目经理')
    expect(result.source).toBe('fallback')
    expect(result.designerExecutionId).toBeNull()
    expect(result.reason).toContain('failed')
    expect(result.draft).toMatchObject({
      name: '项目经理',
      avatar: '🧭',
      accessMode: 'analyze',
      maxConcurrency: 5,
    })
  })

  it('falls back for invalid model output and uses edit mode for engineering roles', async () => {
    const h = harness({ not: 'a draft' }, 'succeeded', {
      skills: [skill({ id: 'skl-fe', name: '前端规范' })],
    })
    const result = await h.service.generateDraft('前端工程师 前端规范')
    expect(result.source).toBe('fallback')
    expect(result.draft.accessMode).toBe('edit')
    expect(result.draft.avatar).toBe('🧑‍💻')
    expect(result.draft.skillIds).toEqual(['skl-fe'])
  })
})
