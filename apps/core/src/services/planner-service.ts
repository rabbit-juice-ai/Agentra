import {
  AGENT_ACCESS_MODE_LABEL,
  type AgentAccessMode,
  type AgentCreateParams,
  type AgentProfile,
  type AgentUpdateParams,
  type Execution,
  type ExecutionStartParams,
  PlanDraft,
  type PlannerDraftResult,
  type PlanTask,
  type PlanValidationResult,
  type PlanViolation,
  RpcMethodError,
  type RuntimeProviderRecord,
  type Skill,
  type Work,
} from '@agentra/protocol'
import { findMatchingAgents, matchesAgentAccess } from './agent-access-matcher'

export type PlannerAgentPort = {
  list(): AgentProfile[]
  create(params: AgentCreateParams, options?: { systemKind?: 'planner' | null }): AgentProfile
  update(params: AgentUpdateParams): AgentProfile
}

export type PlannerExecutionPort = {
  start(params: ExecutionStartParams): Promise<Execution>
  get(executionId: string): Execution
  list(limit?: number): Execution[]
  cancel(params: { executionId: string }): Promise<Execution>
}

export type PlannerWork = Omit<Work, 'teamIds'>

export type PlannerWorkPort = {
  get(id: string): PlannerWork
}

export type PlannerProviderPort = {
  list(): RuntimeProviderRecord[]
}

export type PlannerSkillPort = {
  list(): Skill[]
}

export type PlannerTeam = {
  id: string
  name: string
  description: string
  instructions: string
  leaderAgentId: string | null
  status: string
}

export type PlannerTeamPort = {
  get(id: string): PlannerTeam | null
  list(): PlannerTeam[]
  listMembers(teamId: string): { agentId: string }[]
}

export type PlannerLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export type PlannerServiceDeps = {
  agents: PlannerAgentPort
  executions: PlannerExecutionPort
  works: PlannerWorkPort
  /** 系统 Planner Agent 必须显式绑定一个真实 Provider（不再自动兜底）。 */
  providers: PlannerProviderPort
  /** 可选：把技能名称放进 Planner Registry，便于理解每个 Agent 的专长。 */
  skills?: PlannerSkillPort
  /** 可选：团队 Registry；团队任务只校验归属，不在此决定最终成员。 */
  teams?: PlannerTeamPort
  /** 只接受 Agent 的结构化输出；不把聊天文本猜成计划。 */
  extractOutput: (executionId: string) => Record<string, unknown>
  logger?: PlannerLogger
  pollIntervalMs?: number
  timeoutMs?: number
  now?: () => string
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'crashed'])

const PLANNER_SYSTEM_PROMPT = `You are Agentra's Planner. You turn a human goal into a structured plan for a team of AI agents.
You do not execute tasks. You only produce a plan. Do not run shell commands or inspect the filesystem:
the goal, constraints and agent registry in the prompt are sufficient context.
Return one JSON document and no commentary. Your entire final message must be that JSON object.`

const PLANNER_AGENT_NAME = 'Planner Agent'
/** 规划任务用更快的模型；本地 Opus 默认模型对开放式规划容易长时间 thinking。 */
const PLANNER_MODEL = 'sonnet'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Planner：老板给目标 → 结构化 PlanDraft。
 * 它通过现有 ExecutionService 跑一个 Planner Agent，不新建 runtime，也不直接改业务库。
 */
export class PlannerService {
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(private readonly deps: PlannerServiceDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000
    this.timeoutMs = deps.timeoutMs ?? 90_000
  }

  async generate(input: {
    goal: string
    workId?: string
    constraints?: string[]
    mode?: 'ai' | 'fast'
  }): Promise<PlannerDraftResult> {
    const goal = input.goal.trim()
    if (goal.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'goal must not be blank')
    }
    const work = input.workId ? this.deps.works.get(input.workId) : null
    if (input.workId && !work) {
      throw new RpcMethodError('INVALID_PARAMS', `work not found: ${input.workId}`)
    }

    const agents = this.deps.agents.list().filter((agent) => agent.status === 'active')
    const constraints = input.constraints ?? []
    if (input.mode === 'fast') {
      return this.fallback(goal, work, constraints, agents, 'fast mode requested')
    }
    try {
      return await this.generateWithPlanner(goal, work, constraints, agents)
    } catch (error) {
      if (error instanceof RpcMethodError && error.code === 'INVALID_PARAMS') throw error
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.logger?.warn('planner failed; using capability fallback', { reason })
      return this.fallback(goal, work, constraints, agents, reason)
    }
  }

  private async generateWithPlanner(
    goal: string,
    work: PlannerWork | null,
    constraints: string[],
    agents: AgentProfile[],
  ): Promise<PlannerDraftResult> {
    const planner = this.ensurePlannerAgent()
    const registry = this.registrySnapshot(agents)
    const prompt = this.buildPrompt(goal, work, constraints, registry)
    const execution = await this.deps.executions.start({
      agentId: planner.id,
      prompt,
    })
    const finished = await this.waitForTerminal(execution.id)
    if (finished.status !== 'succeeded') {
      throw new RpcMethodError(
        'INTERNAL',
        `Planner execution ${finished.id} ended as ${finished.status}; no plan was produced`,
      )
    }

    let output: Record<string, unknown>
    try {
      output = this.deps.extractOutput(finished.id)
    } catch (error) {
      throw new RpcMethodError(
        'INTERNAL',
        `Planner output could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const parsed = PlanDraft.safeParse(output)
    if (!parsed.success) {
      throw new RpcMethodError(
        'INTERNAL',
        `Planner returned an invalid plan: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
          .join('; ')}`,
      )
    }

    const validation = this.validate(parsed.data, agents)
    this.deps.logger?.info('plan generated', {
      plannerExecutionId: finished.id,
      taskCount: parsed.data.tasks.length,
      valid: validation.valid,
    })
    return {
      plan: parsed.data,
      validation,
      plannerExecutionId: finished.id,
      source: 'planner',
      fallbackReason: null,
    }
  }

  private fallback(
    goal: string,
    _work: PlannerWork | null,
    constraints: string[],
    agents: AgentProfile[],
    reason: string,
  ): PlannerDraftResult {
    const plan = this.buildFallbackPlan(goal, constraints, agents)
    const validation = this.validate(plan, agents)
    this.deps.logger?.warn('plan generated by capability fallback', {
      reason,
      taskCount: plan.tasks.length,
      valid: validation.valid,
    })
    return {
      plan,
      validation,
      plannerExecutionId: null,
      source: 'fallback',
      fallbackReason: reason,
    }
  }

  /**
   * 不调用模型的确定性草稿：按工作权限找产品/前端/后端/QA，生成
   * product → (frontend ∥ backend) → verify 的最小闭环。
   * 这是兜底，不替代 Planner 模型；结果会明确标记 source=fallback。
   */
  private buildFallbackPlan(
    goal: string,
    constraints: string[],
    agents: AgentProfile[],
  ): PlanDraft {
    const active = agents.filter((agent) => agent.status === 'active')
    // Planner 自己是系统只读 Agent，不参与业务分工。
    const analyzers = active.filter(
      (agent) => agent.accessMode === 'analyze' && agent.systemKind !== 'planner',
    )
    const editors = active.filter((agent) => agent.accessMode === 'edit')
    const product = analyzers[0] ?? null
    const qa = analyzers.find((agent) => agent.id !== product?.id) ?? product
    const frontend = editors[0] ?? null
    const backend = editors[1] ?? editors[0] ?? null

    const tasks: PlanTask[] = []
    const capabilityGaps: PlanDraft['capabilityGaps'] = []

    if (product) {
      tasks.push({
        key: 'product-spec',
        title: '澄清需求与验收标准',
        description: '把目标转成可实现的需求、边界和验收标准。',
        responsibilityRole: 'product',
        requiredAccessMode: 'analyze',
        teamId: null,
        suggestedAgentId: product.id,
        inputs: ['goal'],
        outputs: ['spec'],
        acceptanceCriteria: ['需求覆盖目标与约束', '验收标准可执行'],
        dependsOn: [],
        parallelGroup: null,
        approvalRequired: false,
        verification: null,
      })
    } else {
      capabilityGaps.push({
        role: 'product',
        missingCapabilities: ['analyze'],
        reason: '没有只读分析权限的 Agent',
      })
    }

    const implementationDependencies = product ? ['product-spec'] : []
    if (frontend) {
      tasks.push({
        key: 'frontend',
        title: '前端实现',
        description: '按需求实现界面、交互和前端状态。',
        responsibilityRole: 'frontend',
        requiredAccessMode: 'edit',
        teamId: null,
        suggestedAgentId: frontend.id,
        inputs: product ? ['spec'] : ['goal'],
        outputs: ['ui'],
        acceptanceCriteria: ['界面可用', '关键交互有覆盖'],
        dependsOn: implementationDependencies,
        parallelGroup: 'implementation',
        approvalRequired: false,
        verification: null,
      })
    } else {
      capabilityGaps.push({
        role: 'frontend',
        missingCapabilities: ['edit'],
        reason: '没有编辑权限的 Agent',
      })
    }
    if (backend) {
      tasks.push({
        key: 'backend',
        title: '后端实现',
        description: '按需求实现 API、数据流和持久化。',
        responsibilityRole: 'backend',
        requiredAccessMode: 'edit',
        teamId: null,
        suggestedAgentId: backend.id,
        inputs: product ? ['spec'] : ['goal'],
        outputs: ['api'],
        acceptanceCriteria: ['接口可用', '错误路径有处理'],
        dependsOn: implementationDependencies,
        parallelGroup: 'implementation',
        approvalRequired: false,
        verification: null,
      })
    } else {
      capabilityGaps.push({
        role: 'backend',
        missingCapabilities: ['edit'],
        reason: '没有编辑权限的 Agent',
      })
    }

    const verificationDependencies = [
      frontend ? 'frontend' : null,
      backend ? 'backend' : null,
    ].filter((item): item is string => item !== null)
    if (qa && verificationDependencies.length > 0) {
      tasks.push({
        key: 'verify',
        title: '集成验收',
        description: '验证实现是否满足需求；失败时输出结构化测试报告和相关任务。',
        responsibilityRole: 'testing',
        requiredAccessMode: 'analyze',
        teamId: null,
        suggestedAgentId: qa.id,
        inputs: [frontend ? 'ui' : '', backend ? 'api' : ''].filter(Boolean),
        outputs: ['test-report'],
        acceptanceCriteria: ['覆盖主要验收标准', '失败时给出可复现的缺陷报告'],
        dependsOn: verificationDependencies,
        parallelGroup: null,
        approvalRequired: false,
        verification: { verifies: verificationDependencies },
      })
    } else if (verificationDependencies.length > 0) {
      capabilityGaps.push({
        role: 'testing',
        missingCapabilities: ['analyze'],
        reason: '没有只读分析权限的 Agent',
      })
    }

    if (tasks.length === 0) {
      tasks.push({
        key: 'delivery',
        title: '交付',
        description: '没有匹配的 Agent；需要先配置 Agent 工作权限或补充成员。',
        responsibilityRole: 'delivery',
        requiredAccessMode: 'edit',
        teamId: null,
        suggestedAgentId: null,
        inputs: [],
        outputs: [],
        acceptanceCriteria: ['至少有一个可执行的 Agent'],
        dependsOn: [],
        parallelGroup: null,
        approvalRequired: false,
        verification: null,
      })
    }

    return PlanDraft.parse({
      agentraPlanVersion: 1,
      goal,
      constraints,
      tasks,
      risks: ['由工作权限匹配生成的快速草稿，建议用 AI 规划复核'],
      capabilityGaps,
      approvalsRequired: [],
    })
  }

  /** 计划的结构化校验；返回可直接展示的 violations 与 assignment 建议。 */
  validate(plan: PlanDraft, agents: AgentProfile[]): PlanValidationResult {
    const violations: PlanViolation[] = []
    const active = agents.filter((agent) => agent.status === 'active')
    const byKey = new Map<string, PlanTask>()
    for (const task of plan.tasks) {
      if (byKey.has(task.key)) {
        violations.push({
          code: 'duplicate_task_key',
          taskKey: task.key,
          message: `任务 key "${task.key}" 重复`,
        })
      }
      byKey.set(task.key, task)
    }

    for (const task of plan.tasks) {
      for (const dependency of task.dependsOn) {
        if (!byKey.has(dependency)) {
          violations.push({
            code: 'unknown_dependency',
            taskKey: task.key,
            message: `依赖 "${dependency}" 不存在`,
          })
        }
        if (dependency === task.key) {
          violations.push({
            code: 'self_dependency',
            taskKey: task.key,
            message: '任务不能依赖自己',
          })
        }
      }
      if (task.verification) {
        for (const verified of task.verification.verifies) {
          if (!byKey.has(verified)) {
            violations.push({
              code: 'unknown_verification_target',
              taskKey: task.key,
              message: `验收目标 "${verified}" 不存在`,
            })
          }
          if (verified === task.key) {
            violations.push({
              code: 'self_verification',
              taskKey: task.key,
              message: '任务不能验收自己',
            })
          }
        }
      }
    }

    this.detectCycles(plan.tasks, byKey, violations)

    const assignments = plan.tasks.map((task) => {
      const requiredAccessMode: AgentAccessMode = task.requiredAccessMode
      if (task.teamId !== null) {
        const team = this.deps.teams?.get(task.teamId) ?? null
        if (!team) {
          violations.push({
            code: 'unknown_team',
            taskKey: task.key,
            message: `团队 "${task.teamId}" 不存在`,
          })
          return { taskKey: task.key, agentId: null, agentName: null }
        }
        if (team.status !== 'active') {
          violations.push({
            code: 'team_inactive',
            taskKey: task.key,
            message: `团队 "${team.name}" 当前状态为 ${team.status}，不能承接任务`,
          })
          return { taskKey: task.key, agentId: null, agentName: null }
        }
        // 团队任务的最终成员由队长在批准后派工；Planner 只能给非权威建议。
        if (task.suggestedAgentId) {
          const suggested = active.find((candidate) => candidate.id === task.suggestedAgentId)
          if (!suggested) {
            violations.push({
              code: 'unknown_agent',
              taskKey: task.key,
              message: `建议负责人 "${task.suggestedAgentId}" 不存在或未启用`,
            })
          } else {
            const member = this.deps.teams
              ?.listMembers(team.id)
              .some((item) => item.agentId === suggested.id)
            if (!member) {
              violations.push({
                code: 'agent_not_team_member',
                taskKey: task.key,
                message: `Agent "${suggested.name}" 不是团队 "${team.name}" 的成员`,
              })
            } else if (!matchesAgentAccess(suggested, requiredAccessMode)) {
              violations.push({
                code: 'access_mode_mismatch',
                taskKey: task.key,
                message: `Agent "${suggested.name}" 的工作权限是「${
                  AGENT_ACCESS_MODE_LABEL[suggested.accessMode]
                }」，但任务需要「${AGENT_ACCESS_MODE_LABEL[requiredAccessMode]}」`,
              })
            }
          }
        }
        return { taskKey: task.key, agentId: null, agentName: null }
      }

      let agent: AgentProfile | null = null
      if (task.suggestedAgentId) {
        agent = active.find((candidate) => candidate.id === task.suggestedAgentId) ?? null
        if (!agent) {
          violations.push({
            code: 'unknown_agent',
            taskKey: task.key,
            message: `建议负责人 "${task.suggestedAgentId}" 不存在或未启用`,
          })
        } else if (!matchesAgentAccess(agent, requiredAccessMode)) {
          violations.push({
            code: 'access_mode_mismatch',
            taskKey: task.key,
            message: `Agent "${agent.name}" 的工作权限是「${
              AGENT_ACCESS_MODE_LABEL[agent.accessMode]
            }」，但任务需要「${AGENT_ACCESS_MODE_LABEL[requiredAccessMode]}」`,
          })
        }
      } else {
        const candidates = findMatchingAgents(active, requiredAccessMode)
        if (candidates.length === 0) {
          violations.push({
            code: 'capability_gap',
            taskKey: task.key,
            message: `没有工作权限为「${AGENT_ACCESS_MODE_LABEL[requiredAccessMode]}」的 Agent，无法承接 ${
              task.responsibilityRole
            }`,
          })
        } else {
          agent = this.leastLoaded(candidates)
        }
      }
      if (agent && agent.toolPermissions.allow.length === 0) {
        violations.push({
          code: 'agent_tools_not_configured',
          taskKey: task.key,
          message: `Agent "${agent.name}" 没有允许的工具，无法执行`,
        })
      }
      return {
        taskKey: task.key,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
      }
    })

    return { valid: violations.length === 0, violations, assignments }
  }

  /** 系统 Planner 的稳定入口；聊天室与规划共用同一个 Agent。 */
  ensureAgent(): AgentProfile {
    return this.ensurePlannerAgent()
  }

  private ensurePlannerAgent(): AgentProfile {
    const existing = this.deps.agents
      .list()
      .find((agent) => agent.systemKind === 'planner' && agent.status === 'active')
    if (existing) {
      const provider = this.deps.providers
        .list()
        .find((item) => item.id === existing.defaultProviderId)
      // 系统 Planner 的 Provider 被卸载/不可用时，重新绑定到优先 Provider。
      if (provider?.healthStatus !== 'healthy') {
        const preferred = this.pickPlannerProvider()
        if (preferred.healthStatus === 'healthy') {
          return this.deps.agents.update({
            id: existing.id,
            defaultProviderId: preferred.id,
            model: preferred.providerName === 'Claude Code' ? PLANNER_MODEL : null,
          })
        }
      }
      // 旧 Planner Agent 没有模型时补上更快的默认模型；用户显式设置过则不覆盖。
      if (existing.model === null && provider?.providerName === 'Claude Code') {
        return this.deps.agents.update({ id: existing.id, model: PLANNER_MODEL })
      }
      return existing
    }
    const provider = this.pickPlannerProvider()
    return this.deps.agents.create(
      {
        name: PLANNER_AGENT_NAME,
        avatar: '🧭',
        description: '把老板目标拆成结构化任务计划；只读，不执行实现。',
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        accessMode: 'analyze',
        model: provider.providerName === 'Claude Code' ? PLANNER_MODEL : null,
        defaultProviderId: provider.id,
        maxConcurrency: 1,
      },
      { systemKind: 'planner' },
    )
  }

  /**
   * Planner 也必须是显式绑定；系统 Agent 优先使用 Claude Code（规划质量与 JSON 稳定性最好），
   * 否则退回第一个健康 Provider，最后才用任何已发现 Provider 让执行层给出明确失败。
   */
  private pickPlannerProvider(): RuntimeProviderRecord {
    const providers = this.deps.providers.list()
    const healthy = providers.filter((item) => item.healthStatus === 'healthy')
    const provider =
      healthy.find((item) => item.providerName === 'Claude Code') ??
      healthy[0] ??
      providers.find((item) => item.providerName === 'Claude Code') ??
      providers[0]
    if (!provider) {
      throw new RpcMethodError('INTERNAL', '没有可用的 Provider，无法创建 Planner Agent')
    }
    return provider
  }

  private registrySnapshot(agents: AgentProfile[]) {
    const activeExecutions = this.deps.executions.list(200)
    const load = new Map<string, number>()
    for (const execution of activeExecutions) {
      if (!execution.agentId) continue
      if (execution.status === 'running' || execution.status === 'pending') {
        load.set(execution.agentId, (load.get(execution.agentId) ?? 0) + 1)
      }
    }
    const skillNames = new Map(
      (this.deps.skills?.list() ?? []).map((skill) => [skill.id, skill.name]),
    )
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      description: agent.description,
      accessMode: agent.accessMode,
      accessModeLabel: AGENT_ACCESS_MODE_LABEL[agent.accessMode],
      skills: agent.skillIds
        .map((id) => skillNames.get(id))
        .filter((name): name is string => name !== undefined),
      model: agent.model,
      maxConcurrency: agent.maxConcurrency,
      activeExecutions: load.get(agent.id) ?? 0,
      defaultProviderId: agent.defaultProviderId,
    }))
  }

  private leastLoaded(candidates: AgentProfile[]): AgentProfile {
    const load = new Map<string, number>()
    for (const execution of this.deps.executions.list(200)) {
      if (!execution.agentId) continue
      if (execution.status === 'running' || execution.status === 'pending') {
        load.set(execution.agentId, (load.get(execution.agentId) ?? 0) + 1)
      }
    }
    return [...candidates].sort((left, right) => {
      return (load.get(left.id) ?? 0) - (load.get(right.id) ?? 0)
    })[0] as AgentProfile
  }

  private buildPrompt(
    goal: string,
    work: PlannerWork | null,
    constraints: string[],
    registry: ReturnType<PlannerService['registrySnapshot']>,
  ): string {
    const compactRegistry = registry.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description.slice(0, 160),
      accessMode: agent.accessMode,
      skills: agent.skills,
      model: agent.model,
      maxConcurrency: agent.maxConcurrency,
      activeExecutions: agent.activeExecutions,
    }))
    const compactTeams = (this.deps.teams?.list() ?? [])
      .filter((team) => team.status === 'active')
      .map((team) => ({
        id: team.id,
        name: team.name,
        description: team.description.slice(0, 160),
        leaderAgentId: team.leaderAgentId,
        members: (this.deps.teams?.listMembers(team.id) ?? []).map((member) => member.agentId),
      }))
    return `You are Agentra Planner. Return one JSON object, no commentary.

Goal: ${goal}
Constraints: ${constraints.length > 0 ? constraints.join('; ') : '(none)'}
Work: ${work ? `${work.name} (${work.status})` : '(none)'}
Agents: ${JSON.stringify(compactRegistry)}
Teams: ${JSON.stringify(compactTeams)}

Rules:
- Do not run tools or inspect the filesystem; produce the JSON plan directly.
- Your entire final message must be the JSON object, with no markdown fences or commentary.
- Use only the agent ids above, or null. Never invent an agent.
- Use only the team ids above, or null. Never invent a team.
- Every task must set requiredAccessMode to exactly "analyze" or "edit".
- "analyze" tasks are read-only: requirements/PRD analysis, research, review, verification, test reports.
- "edit" tasks change files: implementation, bug fixes, refactors, UI/API work.
- For a team task (teamId is not null): set suggestedAgentId to null. The team leader will assign team members after boss approval. Do not decide the final team member.
- If you do give a suggestedAgentId for a team task, it must be a member of that team and its accessMode must match; it is only a suggestion.
- For a personal task (teamId is null): suggestedAgentId must be an active agent whose accessMode matches requiredAccessMode.
- Task keys are unique; dependsOn must be acyclic.
- capabilityGaps must be [] unless a required role truly has no matching agent. If non-empty, each item is {"role":"frontend","missingCapabilities":["edit"],"reason":"..."}; never use bare strings.
- For multi-step delivery include one verification task with requiredAccessMode "analyze" and verification.verifies.

Shape:
{"agentraPlanVersion":1,"goal":"...","constraints":[],"tasks":[{"key":"kebab-key","title":"...","description":"...","responsibilityRole":"frontend","requiredAccessMode":"edit","teamId":null,"suggestedAgentId":"id-or-null","inputs":[],"outputs":[],"acceptanceCriteria":[],"dependsOn":[],"parallelGroup":null,"approvalRequired":false,"verification":null}],"risks":[],"capabilityGaps":[],"approvalsRequired":[]}`
  }

  private async waitForTerminal(executionId: string): Promise<Execution> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const execution = this.deps.executions.get(executionId)
      if (TERMINAL.has(execution.status)) return execution
      if (Date.now() >= deadline) {
        await this.deps.executions.cancel({ executionId }).catch(() => undefined)
        throw new RpcMethodError(
          'INTERNAL',
          `Planner execution ${executionId} timed out after ${this.timeoutMs}ms`,
        )
      }
      await sleep(this.pollIntervalMs)
    }
  }

  private detectCycles(
    tasks: PlanTask[],
    byKey: Map<string, PlanTask>,
    violations: PlanViolation[],
  ): void {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (key: string): void => {
      if (visited.has(key)) return
      if (visiting.has(key)) {
        violations.push({
          code: 'dependency_cycle',
          taskKey: key,
          message: `任务依赖形成环：${[...visiting].join(' → ')} → ${key}`,
        })
        return
      }
      const task = byKey.get(key)
      if (!task) return
      visiting.add(key)
      for (const dependency of task.dependsOn) visit(dependency)
      visiting.delete(key)
      visited.add(key)
    }
    for (const task of tasks) visit(task.key)
  }
}
