import type { AgentProfile, Execution } from '@agentra/protocol'
import { PlanDraft } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { PlannerService } from './planner-service'

const NOW = '2026-11-06T00:00:00.000Z'

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'agt-frontend',
    name: 'Frontend Agent',
    role: 'dev',
    description: '负责前端实现',
    systemPrompt: '',
    skills: [],
    capabilities: {
      taskTypes: ['frontend'],
      inputTypes: [],
      outputTypes: [],
      canVerify: [],
      canApprove: [],
      excludedTaskTypes: [],
    },
    model: null,
    toolPermissions: { version: 1, allow: ['Read'], deny: [] },
    defaultProviderId: null,
    maxConcurrency: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
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
  role: 'review',
  capabilities: {
    taskTypes: ['testing'],
    inputTypes: [],
    outputTypes: [],
    canVerify: ['frontend', 'backend'],
    canApprove: [],
    excludedTaskTypes: [],
  },
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
        requiredCapabilities: ['frontend'],
      },
      {
        key: 'verify',
        title: 'Verify',
        description: 'verify it',
        responsibilityRole: 'testing',
        requiredCapabilities: ['frontend'],
        dependsOn: ['build'],
        verification: { verifies: ['build'] },
      },
    ],
    ...overrides,
  })
}

function harness(output: unknown, status: Execution['status'] = 'succeeded') {
  const created: AgentProfile[] = []
  let started = false
  const service = new PlannerService({
    agents: {
      list: () => [FRONTEND, QA],
      create: (params) => {
        const createdAgent = agent({
          id: 'agt-planner',
          name: params.name,
          role: params.role,
          description: params.description ?? '',
          systemPrompt: params.systemPrompt ?? '',
          capabilities: {
            taskTypes: ['planning'],
            inputTypes: ['goal'],
            outputTypes: ['plan'],
            canVerify: [],
            canApprove: [],
            excludedTaskTypes: [],
          },
          toolPermissions: { version: 1, allow: ['Read'], deny: [] },
          model: params.model ?? null,
        })
        created.push(createdAgent)
        return createdAgent
      },
      update: (params) => {
        const base =
          created.find((item) => item.id === params.id) ??
          agent({
            id: params.id,
            name: 'Planner Agent',
            role: 'planner',
            model: params.model ?? null,
          })
        return {
          ...base,
          id: params.id,
          name: params.name ?? base.name,
          role: params.role ?? base.role,
          description: params.description ?? base.description,
          systemPrompt: params.systemPrompt ?? base.systemPrompt,
          skills: params.skills ?? base.skills,
          capabilities: params.capabilities
            ? { ...base.capabilities, ...params.capabilities }
            : base.capabilities,
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
    extractOutput: () => output as Record<string, unknown>,
    pollIntervalMs: 0,
    timeoutMs: 100,
  })
  return { service, created, started: () => started }
}

describe('PlannerService', () => {
  it('runs a planner agent and returns a validated plan with assignments', async () => {
    const h = harness(plan())
    const result = await h.service.generate({ goal: 'build a feature' })
    expect(h.started()).toBe(true)
    expect(h.created).toHaveLength(1)
    expect(result.validation.valid).toBe(true)
    expect(result.validation.assignments).toEqual([
      { taskKey: 'build', agentId: 'agt-frontend', agentName: 'Frontend Agent' },
      { taskKey: 'verify', agentId: 'agt-qa', agentName: 'QA Agent' },
    ])
    expect(result.plannerExecutionId).toBe('exe-plan')
    expect(result.source).toBe('planner')
    expect(result.fallbackReason).toBeNull()
  })

  it('falls back to a capability-matched draft when the planner fails or output is invalid', async () => {
    const failed = harness(plan(), 'failed')
    const fromFailure = await failed.service.generate({ goal: 'build' })
    expect(fromFailure.source).toBe('fallback')
    expect(fromFailure.plannerExecutionId).toBeNull()
    expect(fromFailure.fallbackReason).toContain('failed')
    expect(fromFailure.validation.valid).toBe(true)
    expect(fromFailure.plan.tasks.map((task) => task.key)).toEqual(['frontend', 'verify'])

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
      { taskKey: 'frontend', agentId: 'agt-frontend', agentName: 'Frontend Agent' },
      { taskKey: 'verify', agentId: 'agt-qa', agentName: 'QA Agent' },
    ])
  })

  it('rejects unknown suggested agents and capability gaps', () => {
    const { service } = harness(plan())
    const unknown = service.validate(
      plan({
        tasks: [
          {
            key: 'build',
            title: 'Build',
            description: 'build it',
            responsibilityRole: 'frontend',
            suggestedAgentId: 'agt-missing',
          },
        ],
      }),
      [FRONTEND, QA],
    )
    expect(unknown.valid).toBe(false)
    expect(unknown.violations.map((violation) => violation.code)).toContain('unknown_agent')

    const gap = service.validate(
      plan({
        tasks: [
          {
            key: 'build',
            title: 'Build',
            description: 'build it',
            responsibilityRole: 'backend',
            requiredCapabilities: ['backend'],
          },
        ],
      }),
      [FRONTEND, QA],
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
            dependsOn: ['b'],
          },
          {
            key: 'b',
            title: 'B',
            description: 'b',
            responsibilityRole: 'frontend',
            dependsOn: ['a'],
          },
          {
            key: 'verify',
            title: 'Verify',
            description: 'verify',
            responsibilityRole: 'testing',
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
