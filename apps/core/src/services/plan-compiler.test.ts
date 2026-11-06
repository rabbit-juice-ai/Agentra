import { PlanDraft } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { compilePlanDefinition } from './plan-compiler'

function plan(overrides: Record<string, unknown> = {}) {
  return PlanDraft.parse({
    agentraPlanVersion: 1,
    goal: 'build a feature',
    tasks: [
      {
        key: 'product-spec',
        title: 'Spec',
        description: 'write the spec',
        responsibilityRole: 'product',
        requiredCapabilities: ['product'],
        suggestedAgentId: 'agt-product',
        outputs: ['spec'],
      },
      {
        key: 'frontend',
        title: 'Frontend',
        description: 'build the UI',
        responsibilityRole: 'frontend',
        requiredCapabilities: ['frontend'],
        suggestedAgentId: 'agt-frontend',
        inputs: ['spec'],
        outputs: ['ui'],
        dependsOn: ['product-spec'],
      },
      {
        key: 'backend',
        title: 'Backend',
        description: 'build the API',
        responsibilityRole: 'backend',
        requiredCapabilities: ['backend'],
        suggestedAgentId: 'agt-backend',
        inputs: ['spec'],
        outputs: ['api'],
        dependsOn: ['product-spec'],
      },
      {
        key: 'verify',
        title: 'Verify',
        description: 'verify the result',
        responsibilityRole: 'testing',
        requiredCapabilities: ['frontend', 'backend'],
        suggestedAgentId: 'agt-qa',
        inputs: ['ui', 'api'],
        outputs: ['test-report'],
        dependsOn: ['frontend', 'backend'],
        verification: { verifies: ['frontend', 'backend'] },
      },
    ],
    ...overrides,
  })
}

const assignments = {
  'product-spec': { agentId: 'agt-product', workRole: 'plan-product' },
  frontend: { agentId: 'agt-frontend', workRole: 'plan-frontend' },
  backend: { agentId: 'agt-backend', workRole: 'plan-backend' },
  verify: { agentId: 'agt-qa', workRole: 'plan-qa' },
}

describe('compilePlanDefinition', () => {
  it('compiles a plan into a valid 7-node DAG with a test-result rework loop', () => {
    const definition = compilePlanDefinition({ plan: plan(), taskAssignments: assignments })
    const nodes = new Map(definition.nodes.map((node) => [node.key, node]))
    expect([...nodes.keys()]).toEqual(
      expect.arrayContaining([
        'start',
        'product-spec',
        'frontend',
        'backend',
        'verify',
        'verify-check',
        'end',
      ]),
    )
    const verify = nodes.get('verify')
    expect(verify?.type).toBe('agent_task')
    if (verify?.type === 'agent_task') {
      expect(verify.config.outputContract.profile).toBe('test_result')
      expect(verify.config.inputArtifactRefs).toEqual(
        expect.arrayContaining([
          { nodeKey: 'frontend', artifactName: 'ui' },
          { nodeKey: 'backend', artifactName: 'api' },
        ]),
      )
    }
    const check = nodes.get('verify-check')
    expect(check?.type).toBe('condition')
    if (check?.type === 'condition') {
      expect(check.config.falseBranch).toEqual({ kind: 'rework', reportNodeKey: 'verify' })
    }
    expect(definition.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'start', target: 'product-spec' }),
        expect.objectContaining({ source: 'product-spec', target: 'frontend' }),
        expect.objectContaining({ source: 'product-spec', target: 'backend' }),
        expect.objectContaining({ source: 'frontend', target: 'verify' }),
        expect.objectContaining({ source: 'backend', target: 'verify' }),
        expect.objectContaining({ source: 'verify', target: 'verify-check' }),
        expect.objectContaining({ source: 'verify-check', target: 'end', when: true }),
      ]),
    )
    const frontend = nodes.get('frontend')
    if (frontend?.type === 'agent_task') {
      expect(frontend.config.inputArtifactRefs).toEqual([
        { nodeKey: 'product-spec', artifactName: 'spec' },
      ])
      expect(frontend.config.assignmentSelector).toEqual({
        workRole: 'plan-frontend',
        agentProfileId: 'agt-frontend',
      })
    }
  })

  it('inserts an approval node when a task requires boss approval', () => {
    const definition = compilePlanDefinition({
      plan: plan({
        tasks: [
          {
            key: 'delivery',
            title: 'Delivery',
            description: 'ship it',
            responsibilityRole: 'frontend',
            requiredCapabilities: ['frontend'],
            suggestedAgentId: 'agt-frontend',
            approvalRequired: true,
          },
        ],
      }),
      taskAssignments: { delivery: { agentId: 'agt-frontend', workRole: 'plan-frontend' } },
    })
    const nodes = new Map(definition.nodes.map((node) => [node.key, node]))
    expect(nodes.get('delivery-approval')?.type).toBe('human_approval')
    expect(definition.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'delivery', target: 'delivery-approval' }),
        expect.objectContaining({ source: 'delivery-approval', target: 'end' }),
      ]),
    )
  })
})
