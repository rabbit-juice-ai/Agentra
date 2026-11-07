import {
  AgentAvatar,
  type AgentCreateParams,
  AgentDraft,
  type AgentGenerateDraftResult,
  type AgentProfile,
  type AgentSystemKind,
  type AgentUpdateParams,
  DEFAULT_AGENT_AVATAR,
  type Execution,
  type ExecutionStartParams,
  RpcMethodError,
  type RuntimeProviderRecord,
  type Skill,
} from '@agentra/protocol'

export type AgentDesignerAgentPort = {
  list(): AgentProfile[]
  create(params: AgentCreateParams, options?: { systemKind?: AgentSystemKind | null }): AgentProfile
  update(params: AgentUpdateParams): AgentProfile
}

export type AgentDesignerExecutionPort = {
  start(params: ExecutionStartParams): Promise<Execution>
  get(executionId: string): Execution
  cancel(params: { executionId: string }): Promise<Execution>
}

export type AgentDesignerProviderPort = {
  list(): RuntimeProviderRecord[]
}

export type AgentDesignerSkillPort = {
  list(): Skill[]
}

export type AgentDesignerLogger = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export type AgentDesignerServiceDeps = {
  agents: AgentDesignerAgentPort
  executions: AgentDesignerExecutionPort
  providers: AgentDesignerProviderPort
  skills?: AgentDesignerSkillPort
  /** 只接受结构化输出；不能把聊天文本猜成草案。 */
  extractOutput: (executionId: string) => Record<string, unknown>
  logger?: AgentDesignerLogger
  pollIntervalMs?: number
  timeoutMs?: number
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'crashed'])
const DESIGNER_AGENT_NAME = 'Agent 设计师'
const DESIGNER_MODEL = 'sonnet'

const DESIGNER_SYSTEM_PROMPT = `You are Agentra's Agent Designer. You turn a short role brief into a structured Agent profile draft for a local AI team.
You do not execute the role; you only design its configuration. Do not run tools or inspect the filesystem.
Return one JSON object and no commentary. Your entire final message must be that JSON object.`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 确定性的兜底草案：即使 CLI 不可用，AI 创建入口也能给出可编辑内容。 */
function fallbackDraft(brief: string, skills: Skill[], reason: string): AgentGenerateDraftResult {
  const cleaned = cleanText(brief)
  const name = cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned
  const analyzeHints =
    /(产品|项目|经理|测试|验收|审查|评审|分析|研究|需求|文档|运营|策划|顾问|协调)/i
  const editHints = /(工程|开发|实现|前端|后端|全栈|代码|编程|修复|重构|架构|设计|运维)/i
  const accessMode = editHints.test(cleaned) && !analyzeHints.test(cleaned) ? 'edit' : 'analyze'
  let avatar = DEFAULT_AGENT_AVATAR
  if (/(测试|QA|验收)/i.test(cleaned)) avatar = '🧪'
  else if (/(前端|开发|工程)/i.test(cleaned)) avatar = '🧑‍💻'
  else if (/(后端|架构|运维)/i.test(cleaned)) avatar = '🛠️'
  else if (/(产品|项目|经理|协调)/i.test(cleaned)) avatar = '🧭'
  else if (/(设计|视觉|UI|UX)/i.test(cleaned)) avatar = '🎨'
  else if (/(数据|分析|研究)/i.test(cleaned)) avatar = '🔍'
  else if (/(运营|内容|文案)/i.test(cleaned)) avatar = '📝'

  const matchedSkills = skills
    .filter((skill) => cleaned.includes(skill.name) || skill.name.includes(cleaned))
    .map((skill) => skill.id)
  const draft = AgentDraft.parse({
    name,
    avatar,
    description: `负责${name}相关工作；在需要${name}时调用。`,
    systemPrompt: `你是${name}。先明确目标、边界与验收标准，再开始工作；输出要可执行，完成后说明结果与验证方式。`,
    accessMode,
    skillIds: matchedSkills,
    maxConcurrency: 5,
  })
  return {
    draft,
    source: 'fallback',
    reason,
    designerExecutionId: null,
  }
}

/**
 * AI 生成 Agent 草案：复用现有 Agent 执行链路，由系统 Agent 设计师产出结构化 JSON。
 * 失败时返回确定性兜底草案并标注 source=fallback，不把模型错误伪装成成功。
 */
export class AgentDesignerService {
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(private readonly deps: AgentDesignerServiceDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000
    this.timeoutMs = deps.timeoutMs ?? 90_000
  }

  async generateDraft(brief: string): Promise<AgentGenerateDraftResult> {
    const text = brief.trim()
    if (text.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'brief must not be blank')
    }
    const skills = this.deps.skills?.list() ?? []
    try {
      return await this.generateWithModel(text, skills)
    } catch (error) {
      if (error instanceof RpcMethodError && error.code === 'INVALID_PARAMS') throw error
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.logger?.warn('agent draft generation failed; using fallback', { reason })
      return fallbackDraft(text, skills, reason)
    }
  }

  private async generateWithModel(
    brief: string,
    skills: Skill[],
  ): Promise<AgentGenerateDraftResult> {
    const designer = this.ensureDesignerAgent()
    const prompt = this.buildPrompt(brief, skills)
    const execution = await this.deps.executions.start({
      agentId: designer.id,
      prompt,
    })
    const finished = await this.waitForTerminal(execution.id)
    if (finished.status !== 'succeeded') {
      throw new RpcMethodError(
        'INTERNAL',
        `Agent Designer execution ${finished.id} ended as ${finished.status}; no draft was produced`,
      )
    }
    const output = this.deps.extractOutput(finished.id)
    const parsed = AgentDraft.safeParse(output)
    if (!parsed.success) {
      throw new RpcMethodError(
        'INTERNAL',
        `Agent Designer returned an invalid draft: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'draft'}: ${issue.message}`)
          .join('; ')}`,
      )
    }
    this.deps.logger?.info('agent draft generated', {
      designerExecutionId: finished.id,
      accessMode: parsed.data.accessMode,
    })
    return {
      draft: this.normalizeDraft(parsed.data, skills),
      source: 'ai',
      reason: null,
      designerExecutionId: finished.id,
    }
  }

  /** 只保留真实存在的技能；空白文本直接拒绝，让调用方回退。 */
  private normalizeDraft(draft: AgentDraft, skills: Skill[]): AgentDraft {
    const name = draft.name.trim()
    const description = draft.description.trim()
    const systemPrompt = draft.systemPrompt.trim()
    if (name.length === 0 || description.length === 0 || systemPrompt.length === 0) {
      throw new RpcMethodError('INTERNAL', 'Agent Designer returned blank required fields')
    }
    const known = new Set(skills.map((skill) => skill.id))
    const skillIds = [...new Set(draft.skillIds.filter((id) => known.has(id)))]
    const avatar = AgentAvatar.safeParse(draft.avatar)
    return {
      ...draft,
      name,
      description,
      systemPrompt,
      skillIds,
      avatar: avatar.success ? avatar.data : DEFAULT_AGENT_AVATAR,
    }
  }

  private ensureDesignerAgent(): AgentProfile {
    const existing = this.deps.agents
      .list()
      .find((agent) => agent.systemKind === 'agent_designer' && agent.status === 'active')
    if (existing) {
      const provider = this.deps.providers
        .list()
        .find((item) => item.id === existing.defaultProviderId)
      if (provider?.healthStatus !== 'healthy') {
        const preferred = this.pickProvider()
        if (preferred.healthStatus === 'healthy') {
          return this.deps.agents.update({
            id: existing.id,
            defaultProviderId: preferred.id,
            model: preferred.providerName === 'Claude Code' ? DESIGNER_MODEL : null,
          })
        }
      }
      if (existing.model === null && provider?.providerName === 'Claude Code') {
        return this.deps.agents.update({ id: existing.id, model: DESIGNER_MODEL })
      }
      return existing
    }
    const provider = this.pickProvider()
    return this.deps.agents.create(
      {
        name: DESIGNER_AGENT_NAME,
        avatar: '✨',
        description: '根据一句话需求生成可编辑的 Agent 配置草案；只读，不执行角色工作。',
        systemPrompt: DESIGNER_SYSTEM_PROMPT,
        accessMode: 'analyze',
        model: provider.providerName === 'Claude Code' ? DESIGNER_MODEL : null,
        defaultProviderId: provider.id,
        maxConcurrency: 1,
      },
      { systemKind: 'agent_designer' },
    )
  }

  /** 系统 Agent 优先 Claude Code；没有健康 Provider 时抛出，让 generateDraft 走兜底。 */
  private pickProvider(): RuntimeProviderRecord {
    const providers = this.deps.providers.list()
    const healthy = providers.filter((item) => item.healthStatus === 'healthy')
    const provider =
      healthy.find((item) => item.providerName === 'Claude Code') ??
      healthy[0] ??
      providers.find((item) => item.providerName === 'Claude Code') ??
      providers[0]
    if (!provider) {
      throw new RpcMethodError('INTERNAL', '没有可用的 Provider，无法创建 Agent 设计师')
    }
    return provider
  }

  private buildPrompt(brief: string, skills: Skill[]): string {
    const skillLibrary = skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description.slice(0, 160),
    }))
    return `Design an Agent profile from this brief.

Brief: ${brief}
Available skills: ${JSON.stringify(skillLibrary)}

Rules:
- Do not run tools or inspect the filesystem; produce the JSON draft directly.
- Your entire final message must be the JSON object, no markdown fences.
- name: a concise role name (≤20 characters), e.g. 项目经理 or 前端工程师.
- avatar: exactly one emoji that fits the role.
- description: "擅长的工作与调用时机" — what this agent is good at and when the Planner should call it.
- systemPrompt: the agent's working instructions: responsibilities, quality bar, boundaries. Do not mention being an AI.
- accessMode: "analyze" for product/project/test/review/research roles that must not modify files; "edit" for roles that implement or modify code/design files.
- skillIds: only ids from the available skills list; [] if none fit.
- maxConcurrency: integer 1-8, default 5.
- Do not include provider or model; the human chooses them.

Shape:
{"name":"...","avatar":"🤖","description":"...","systemPrompt":"...","accessMode":"analyze","skillIds":[],"maxConcurrency":5}`
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
          `Agent Designer execution ${executionId} timed out after ${this.timeoutMs}ms`,
        )
      }
      await sleep(this.pollIntervalMs)
    }
  }
}
