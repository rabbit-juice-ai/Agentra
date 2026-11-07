import type { AgentProfile, Execution, RuntimeProviderRecord } from '@agentra/protocol'
import { PlanDraft } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { toolPermissionsForAccessMode } from './agent-service'
import { PlannerService } from './planner-service'

const NOW = '2026-11-06T00:00:00.000Z'

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  const accessMode = overrides.accessMode ?? 'edit'
  return {
    id: 'agt-frontend',
    name: 'Frontend Agent',
    avatar: '🧑‍💻',
    description: '负责前端实现',
    systemPrompt: '',
    skillIds: [],
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: 'claude-code',
    maxConcurrency: 5,
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
    version: '2.1.314',
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

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'exe-plan',
    sessionId: 'ses-plan',
    providerId: 'claude-code',
    agentId: 'agt-planner',
    externalExecutionId: null,
    processId: null,
    status: 'running',
    workingDirectory: '/tmp/agentra/scratch/exe-plan',
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

const FRONTEND = agent({})
const QA = agent({
  id: 'agt-qa',
  name: 'QA Agent',
  accessMode: 'analyze',
  description: '负责验收',
})

function plan(overrides: Record<string, unknown> = {}) {
  return PlanDraft.parse({
    agentraPlanVersion: 1,
    goal: 'build a feature',
    tasks: [
      {
        key: 'build',
        title: 'Build',
        description: 'build it',
        responsibilityRole: 'frontend',
        requiredAccessMode: 'edit',
      },
      {
        key: 'verify',
        title: 'Verify',
        description: 'verify it',
        responsibilityRole: 'testing',
        requiredAccessMode: 'analyze',
        dependsOn: ['build'],
        verification: { verifies: ['build'] },
      },
    ],
    ...overrides,
  })
}

function harness(
  output: unknown,
  status: Execution['status'] = 'succeeded',
  options: { agents?: AgentProfile[]; providers?: RuntimeProviderRecord[] } = {},
) {
  const created: AgentProfile[] = []
  const updates: string[] = []
  let started = false
  const service = new PlannerService({
    agents: {
      list: () => options.agents ?? [FRONTEND, QA],
      create: (params, createOptions) => {
        const createdAgent = agent({
          id: 'agt-planner',
          name: params.name,
          avatar: params.avatar ?? '🧭',
          description: params.description ?? '',
          systemPrompt: params.systemPrompt ?? '',
          skillIds: params.skillIds ?? [],
          accessMode: params.accessMode ?? 'analyze',
          systemKind: createOptions?.systemKind ?? null,
          model: params.model ?? null,
          defaultProviderId: params.defaultProviderId,
          maxConcurrency: params.maxConcurrency ?? 5,
        })
        created.push(createdAgent)
        return createdAgent
      },
      update: (params) => {
        updates.push(`update:${params.defaultProviderId ?? ''}:${params.model ?? ''}`)
        const base =
          created.find((item) => item.id === params.id) ??
          (options.agents ?? []).find((item) => item.id === params.id) ??
          agent({
            id: params.id,
            name: 'Planner Agent',
            accessMode: 'analyze',
            systemKind: 'planner',
            model: params.model ?? null,
          })
        const accessMode = params.accessMode ?? base.accessMode
        return {
          ...base,
          id: params.id,
          name: params.name ?? base.name,
          avatar: params.avatar ?? base.avatar,
          description: params.description ?? base.description,
          systemPrompt: params.systemPrompt ?? base.systemPrompt,
          skillIds: params.skillIds ?? base.skillIds,
          accessMode,
          toolPermissions: toolPermissionsForAccessMode(accessMode),
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
      list: () => [],
      cancel: async () => execution({ status: 'cancelled' }),
    },
    works: {
      get: () => {
        throw new Error('work should not be read in this test')
      },
    },
    providers: { list: () => options.providers ?? [provider()] },
    extractOutput: () => output as Record<string, unknown>,
    pollIntervalMs: 0,
    timeoutMs: 100,
  })
  return { service, created, updates, started: () => started }
}

describe('PlannerService', () => {
  it('runs a planner agent and returns a validated plan with access-matched assignments', async () => {
    const h = harness(plan())
    const result = await h.service.generate({ goal: 'build a feature' })
    expect(h.started()).toBe(true)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      systemKind: 'planner',
      accessMode: 'analyze',
      defaultProviderId: 'claude-code',
      model: 'sonnet',
    })
    expect(result.validation.valid).toBe(true)
    expect(result.validation.assignments).toEqual([
      { taskKey: 'build', agentId: 'agt-frontend', agentName: 'Frontend Agent' },
      { taskKey: 'verify', agentId: 'agt-qa', agentName: 'QA Agent' },
    ])
    expect(result.plannerExecutionId).toBe('exe-plan')
    expect(result.source).toBe('planner')
    expect(result.fallbackReason).toBeNull()
  })

  it('reuses an existing system planner instead of creating a duplicate', async () => {
    const existingPlanner = agent({
      id: 'agt-planner-existing',
      name: 'Planner Agent',
      avatar: '🧭',
      accessMode: 'analyze',
      systemKind: 'planner',
      model: 'sonnet',
    })
    const h = harness(plan(), 'succeeded', {
      agents: [FRONTEND, QA, existingPlanner],
    })
    const result = await h.service.generate({ goal: 'build a feature' })
    expect(result.source).toBe('planner')
    expect(h.created).toHaveLength(0)
    expect(h.updates).toEqual([])
  })

  it('prefers Claude Code for a new system planner', async () => {
    const h = harness(plan(), 'succeeded', {
      providers: [provider({ id: 'antigravity', providerName: 'Antigravity CLI' }), provider()],
    })
    await h.service.generate({ goal: 'build a feature' })
    expect(h.created[0]).toMatchObject({
      systemKind: 'planner',
      defaultProviderId: 'claude-code',
      model: 'sonnet',
    })
  })

  it('rebinds a system planner whose provider is unhealthy', async () => {
    const stalePlanner = agent({
      id: 'agt-planner-stale',
      name: 'Planner Agent',
      accessMode: 'analyze',
      systemKind: 'planner',
      defaultProviderId: 'antigravity',
      model: null,
    })
    const h = harness(plan(), 'succeeded', {
      agents: [FRONTEND, QA, stalePlanner],
      providers: [
        provider({
          id: 'antigravity',
          providerName: 'Antigravity CLI',
          healthStatus: 'unavailable',
        }),
        provider(),
      ],
    })
    await h.service.generate({ goal: 'build a feature' })
    expect(h.created).toHaveLength(0)
    expect(h.updates).toContain('update:claude-code:sonnet')
  })

  it('falls back to a capability-matched draft when the planner fails or output is invalid', async () => {
    const failed = harness(plan(), 'failed')
    const fromFailure = await failed.service.generate({ goal: 'build' })
    expect(fromFailure.source).toBe('fallback')
    expect(fromFailure.plannerExecutionId).toBeNull()
    expect(fromFailure.fallbackReason).toContain('failed')
    expect(fromFailure.validation.valid).toBe(true)
    expect(fromFailure.plan.tasks.map((task) => task.key)).toEqual([
      'product-spec',
      'frontend',
      'backend',
      'verify',
    ])
    expect(fromFailure.plan.tasks.map((task) => [task.key, task.requiredAccessMode])).toEqual([
      ['product-spec', 'analyze'],
      ['frontend', 'edit'],
      ['backend', 'edit'],
      ['verify', 'analyze'],
    ])

    const invalid = harness({ not: 'a plan' })
    const fromInvalid = await invalid.service.generate({ goal: 'build' })
    expect(fromInvalid.source).toBe('fallback')
    expect(fromInvalid.validation.valid).toBe(true)
  })

  it('supports a fast mode that never starts a planner execution', async () => {
    const h = harness(plan())
    const result = await h.service.generate({ goal: 'build', mode: 'fast' })
    expect(h.started()).toBe(false)
    expect(result.source).toBe('fallback')
    expect(result.plannerExecutionId).toBeNull()
    expect(result.validation.assignments).toEqual([
      { taskKey: 'product-spec', agentId: 'agt-qa', agentName: 'QA Agent' },
      { taskKey: 'frontend', agentId: 'agt-frontend', agentName: 'Frontend Agent' },
      { taskKey: 'backend', agentId: 'agt-frontend', agentName: 'Frontend Agent' },
      { taskKey: 'verify', agentId: 'agt-qa', agentName: 'QA Agent' },
    ])
  })

  it('rejects unknown suggested agents and access-mode mismatches', () => {
    const { service } = harness(plan())
    const unknown = service.validate(
      plan({
        tasks: [
          {
            key: 'build',
            title: 'Build',
            description: 'build it',
            responsibilityRole: 'frontend',
            requiredAccessMode: 'edit',
            suggestedAgentId: 'agt-missing',
          },
        ],
      }),
      [FRONTEND, QA],
    )
    expect(unknown.valid).toBe(false)
    expect(unknown.violations.map((violation) => violation.code)).toContain('unknown_agent')

    // 研发 Agent（edit）不能承接分析/验收任务。
    const mismatch = service.validate(
      plan({
        tasks: [
          {
            key: 'verify',
            title: 'Verify',
            description: 'verify',
            responsibilityRole: 'testing',
            requiredAccessMode: 'analyze',
            suggestedAgentId: 'agt-frontend',
          },
        ],
      }),
      [FRONTEND, QA],
    )
    expect(mismatch.valid).toBe(false)
    expect(mismatch.violations.map((violation) => violation.code)).toContain('access_mode_mismatch')

    // 测试 Agent（analyze）不能承接编辑任务。
    const reverse = service.validate(
      plan({
        tasks: [
          {
            key: 'build',
            title: 'Build',
            description: 'build',
            responsibilityRole: 'frontend',
            requiredAccessMode: 'edit',
            suggestedAgentId: 'agt-qa',
          },
        ],
      }),
      [FRONTEND, QA],
    )
    expect(reverse.violations.map((violation) => violation.code)).toContain('access_mode_mismatch')

    const gap = service.validate(
      plan({
        tasks: [
          {
            key: 'build',
            title: 'Build',
            description: 'build it',
            responsibilityRole: 'backend',
            requiredAccessMode: 'analyze',
          },
        ],
      }),
      [FRONTEND],
    )
    expect(gap.valid).toBe(false)
    expect(gap.violations.map((violation) => violation.code)).toContain('capability_gap')
  })

  it('rejects dependency cycles and missing verification targets', () => {
    const { service } = harness(plan())
    const invalid = service.validate(
      plan({
        tasks: [
          {
            key: 'a',
            title: 'A',
            description: 'a',
            responsibilityRole: 'frontend',
            requiredAccessMode: 'edit',
            dependsOn: ['b'],
          },
          {
            key: 'b',
            title: 'B',
            description: 'b',
            responsibilityRole: 'frontend',
            requiredAccessMode: 'edit',
            dependsOn: ['a'],
          },
          {
            key: 'verify',
            title: 'Verify',
            description: 'verify',
            responsibilityRole: 'testing',
            requiredAccessMode: 'analyze',
            verification: { verifies: ['missing'] },
          },
        ],
      }),
      [FRONTEND, QA],
    )
    expect(invalid.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['dependency_cycle', 'unknown_verification_target']),
    )
  })
})
