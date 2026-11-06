import {
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
  type Work,
} from '@agentra/protocol'
import {
  findMatchingAgents,
  matchesAgentCapabilities,
  missingCapabilities,
} from './agent-capability-matcher'

export type PlannerAgentPort = {
  list(): AgentProfile[]
  create(params: AgentCreateParams): AgentProfile
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

export type PlannerLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export type PlannerServiceDeps = {
  agents: PlannerAgentPort
  executions: PlannerExecutionPort
  works: PlannerWorkPort
  /** 只接受 Agent 的结构化输出；不把聊天文本猜成计划。 */
  extractOutput: (executionId: string) => Record<string, unknown>
  logger?: PlannerLogger
  pollIntervalMs?: number
  timeoutMs?: number
  now?: () => string
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'crashed'])

const PLANNER_SYSTEM_PROMPT = `You are Agentra's Planner. You turn a human goal into a structured plan for a team of AI agents.
You do not execute tasks. You only produce a plan. Return one JSON document and no commentary.`

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
   * 不调用模型的确定性草稿：按能力找产品/前端/后端/QA，生成
   * product → (frontend ∥ backend) → verify 的最小闭环。
   * 这是兜底，不替代 Planner 模型；结果会明确标记 source=fallback。
   */
  private buildFallbackPlan(
    goal: string,
    constraints: string[],
    agents: AgentProfile[],
  ): PlanDraft {
    const active = agents.filter((agent) => agent.status === 'active')
    const find = (taskType: string, kind: 'execute' | 'verify' = 'execute') =>
      findMatchingAgents(active, {
        taskType,
        requiredCapabilities: [taskType],
        kind,
      })[0] ?? null

    const product = find('product')
    const frontend = find('frontend')
    const backend = find('backend')
    const verificationTargets = [frontend ? 'frontend' : null, backend ? 'backend' : null].filter(
      (item): item is string => item !== null,
    )
    const qa =
      verificationTargets.length > 0
        ? (findMatchingAgents(active, {
            taskType: 'testing',
            requiredCapabilities: verificationTargets,
            kind: 'verify',
          })[0] ?? null)
        : null

    const tasks: PlanTask[] = []
    const capabilityGaps: PlanDraft['capabilityGaps'] = []

    if (product) {
      tasks.push({
        key: 'product-spec',
        title: '澄清需求与验收标准',
        description: '把目标转成可实现的需求、边界和验收标准。',
        responsibilityRole: 'product',
        requiredCapabilities: ['product'],
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
        missingCapabilities: ['product'],
        reason: '没有可承担产品/需求职责的 Agent',
      })
    }

    const implementationDependencies = product ? ['product-spec'] : []
    if (frontend) {
      tasks.push({
        key: 'frontend',
        title: '前端实现',
        description: '按需求实现界面、交互和前端状态。',
        responsibilityRole: 'frontend',
        requiredCapabilities: ['frontend'],
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
        missingCapabilities: ['frontend'],
        reason: '没有可承担前端实现职责的 Agent',
      })
    }
    if (backend) {
      tasks.push({
        key: 'backend',
        title: '后端实现',
        description: '按需求实现 API、数据流和持久化。',
        responsibilityRole: 'backend',
        requiredCapabilities: ['backend'],
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
        missingCapabilities: ['backend'],
        reason: '没有可承担后端实现职责的 Agent',
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
        requiredCapabilities: verificationTargets,
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
        missingCapabilities: verificationTargets,
        reason: '没有可承担验收职责的 Agent',
      })
    }

    if (tasks.length === 0) {
      tasks.push({
        key: 'delivery',
        title: '交付',
        description: '没有匹配的 Agent；需要先配置 Agent 能力或补充成员。',
        responsibilityRole: 'delivery',
        requiredCapabilities: ['delivery'],
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
      risks: ['由能力匹配生成的快速草稿，建议用 AI 规划复核'],
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
      const requirement = {
        taskType: task.responsibilityRole,
        requiredCapabilities: task.requiredCapabilities,
        kind: task.verification ? ('verify' as const) : ('execute' as const),
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
        } else if (
          agent.capabilities.excludedTaskTypes.includes(task.responsibilityRole) ||
          task.requiredCapabilities.some((capability) =>
            agent?.capabilities.excludedTaskTypes.includes(capability),
          )
        ) {
          violations.push({
            code: 'capability_mismatch',
            taskKey: task.key,
            message: `Agent "${agent.name}" 明确不接该职责或能力`,
          })
        } else if (
          task.requiredCapabilities.length > 0 &&
          !matchesAgentCapabilities(agent, requirement)
        ) {
          violations.push({
            code: 'capability_mismatch',
            taskKey: task.key,
            message: `Agent "${agent.name}" 缺少能力：${missingCapabilities(
              agent,
              requirement,
            ).join(', ')}`,
          })
        }
      } else {
        const candidates = findMatchingAgents(active, requirement)
        if (candidates.length === 0) {
          violations.push({
            code: 'capability_gap',
            taskKey: task.key,
            message: `没有 Agent 同时满足 ${task.responsibilityRole} 与 [${task.requiredCapabilities.join(
              ', ',
            )}]`,
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

  private ensurePlannerAgent(): AgentProfile {
    const existing = this.deps.agents
      .list()
      .find((agent) => agent.role === 'planner' && agent.status === 'active')
    if (existing) {
      // 旧 Planner Agent 没有模型时补上更快的默认模型；用户显式设置过则不覆盖。
      if (existing.model === null) {
        return this.deps.agents.update({ id: existing.id, model: PLANNER_MODEL })
      }
      return existing
    }
    return this.deps.agents.create({
      name: PLANNER_AGENT_NAME,
      role: 'planner',
      description: '把老板目标拆成结构化任务计划；只读，不执行实现。',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      model: PLANNER_MODEL,
      toolPermissions: { version: 1, allow: ['Read'], deny: [] },
      capabilities: {
        taskTypes: ['planning'],
        inputTypes: ['goal'],
        outputTypes: ['plan'],
        canVerify: [],
        canApprove: [],
        excludedTaskTypes: [],
      },
      maxConcurrency: 1,
    })
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
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      skills: agent.skills,
      capabilities: agent.capabilities,
      maxConcurrency: agent.maxConcurrency,
      activeExecutions: load.get(agent.id) ?? 0,
      defaultProviderId: agent.defaultProviderId,
      tools: agent.toolPermissions.allow,
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
      role: agent.role,
      description: agent.description.slice(0, 160),
      taskTypes: agent.capabilities.taskTypes,
      canVerify: agent.capabilities.canVerify,
      maxConcurrency: agent.maxConcurrency,
      activeExecutions: agent.activeExecutions,
    }))
    return `You are Agentra Planner. Return one JSON object, no commentary.

Goal: ${goal}
Constraints: ${constraints.length > 0 ? constraints.join('; ') : '(none)'}
Work: ${work ? `${work.name} (${work.status})` : '(none)'}
Agents: ${JSON.stringify(compactRegistry)}

Rules:
- Use only the agent ids above, or null. Never invent an agent.
- requiredCapabilities must come from that agent's taskTypes/canVerify.
- Task keys are unique; dependsOn must be acyclic.
- For multi-step delivery include one verification task with verification.verifies.

Shape:
{"agentraPlanVersion":1,"goal":"...","constraints":[],"tasks":[{"key":"kebab-key","title":"...","description":"...","responsibilityRole":"frontend","requiredCapabilities":["frontend"],"suggestedAgentId":"id-or-null","inputs":[],"outputs":[],"acceptanceCriteria":[],"dependsOn":[],"parallelGroup":null,"approvalRequired":false,"verification":null}],"risks":[],"capabilityGaps":[],"approvalsRequired":[]}`
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
