import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  RuntimeProviderRecord,
} from '@agentra/protocol'
import { type FormEvent, useEffect, useState } from 'react'
import { Icon } from './Icon'

type Props = {
  providers: RuntimeProviderRecord[]
  initial: AgentProfile | null
  busy: boolean
  onSubmit: (params: AgentCreateParams | AgentUpdateParams) => Promise<boolean>
  onCancel: () => void
}

/** 逗号或换行分隔的工具清单：去空白、去重、保持顺序。 */
function parseToolList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0),
    ),
  ]
}

/** 纯表单：只收集输入并回调，校验与持久化在 Core（Zod）完成。 */
const PROVIDER_HEALTH_LABEL: Record<string, string> = {
  healthy: '健康',
  unauthenticated: '未认证',
  unavailable: '不可用',
  unknown: '未知',
}

export function AgentForm({ providers, initial, busy, onSubmit, onCancel }: Props) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [skills, setSkills] = useState('')
  const [taskTypes, setTaskTypes] = useState('')
  const [canVerify, setCanVerify] = useState('')
  const [canApprove, setCanApprove] = useState('')
  const [excludedTaskTypes, setExcludedTaskTypes] = useState('')
  const [allowTools, setAllowTools] = useState('')
  const [denyTools, setDenyTools] = useState('')
  const [defaultProviderId, setDefaultProviderId] = useState('')
  const [model, setModel] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('1')

  useEffect(() => {
    setName(initial?.name ?? '')
    setRole(initial?.role ?? '')
    setDescription(initial?.description ?? '')
    setSystemPrompt(initial?.systemPrompt ?? '')
    setSkills((initial?.skills ?? []).join(', '))
    setTaskTypes((initial?.capabilities.taskTypes ?? []).join(', '))
    setCanVerify((initial?.capabilities.canVerify ?? []).join(', '))
    setCanApprove((initial?.capabilities.canApprove ?? []).join(', '))
    setExcludedTaskTypes((initial?.capabilities.excludedTaskTypes ?? []).join(', '))
    setAllowTools((initial?.toolPermissions.allow ?? []).join(', '))
    setDenyTools((initial?.toolPermissions.deny ?? []).join(', '))
    setDefaultProviderId(initial?.defaultProviderId ?? '')
    setModel(initial?.model ?? '')
    setMaxConcurrency(String(initial?.maxConcurrency ?? 1))
  }, [initial])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const parsedSkills = skills
      .split(',')
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0)
    const parsedConcurrency = Number.parseInt(maxConcurrency, 10)
    const base = {
      name,
      role,
      description,
      systemPrompt,
      skills: parsedSkills,
      capabilities: {
        taskTypes: parseToolList(taskTypes),
        inputTypes: initial?.capabilities.inputTypes ?? [],
        outputTypes: initial?.capabilities.outputTypes ?? [],
        canVerify: parseToolList(canVerify),
        canApprove: parseToolList(canApprove),
        excludedTaskTypes: parseToolList(excludedTaskTypes),
      },
      // 留空即空 allow：按 U3 该 Agent 未配置工具权限，启动执行会被 Core 拒绝。
      toolPermissions: {
        version: 1 as const,
        allow: parseToolList(allowTools),
        deny: parseToolList(denyTools),
      },
      defaultProviderId: defaultProviderId === '' ? null : defaultProviderId,
      model: model.trim() || null,
      maxConcurrency: Number.isFinite(parsedConcurrency) ? parsedConcurrency : 1,
    }
    const ok = await onSubmit(initial ? { ...base, id: initial.id } : base)
    if (ok) onCancel()
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)}>
      <div className="card-head">
        <div className="card-title">{initial ? `编辑 Agent · ${initial.name}` : '新建 Agent'}</div>
        <div className="right">
          <button type="button" className="btn btn-ghost btn-icon" onClick={onCancel}>
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div className="card-body form-grid">
        <div className="field">
          <label htmlFor="agent-name">名称 *</label>
          <input
            id="agent-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-role">角色 *</label>
            <input
              id="agent-role"
              className="input"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              placeholder="engineer"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="agent-concurrency">最大并发</label>
            <input
              id="agent-concurrency"
              className="input"
              type="number"
              min={1}
              max={64}
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="agent-description">描述</label>
          <input
            id="agent-description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-provider">默认 Provider</label>
          <select
            id="agent-provider"
            className="select"
            value={defaultProviderId}
            onChange={(event) => setDefaultProviderId(event.target.value)}
          >
            <option value="">（自动选择健康 Provider）</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.providerName} ·{' '}
                {PROVIDER_HEALTH_LABEL[provider.healthStatus] ?? provider.healthStatus}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="agent-model">模型（可选）</label>
          <input
            id="agent-model"
            className="input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="sonnet / haiku / opus（留空使用 Provider 默认）"
          />
        </div>
        <div className="field">
          <label htmlFor="agent-system-prompt">系统提示词</label>
          <textarea
            id="agent-system-prompt"
            className="textarea"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-skills">技能（逗号分隔）</label>
          <input
            id="agent-skills"
            className="input"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder="react, typescript"
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-task-types">任务类型（逗号分隔）</label>
            <input
              id="agent-task-types"
              className="input"
              value={taskTypes}
              onChange={(event) => setTaskTypes(event.target.value)}
              placeholder="frontend, backend, testing"
            />
          </div>
          <div className="field">
            <label htmlFor="agent-excluded-types">不接任务类型</label>
            <input
              id="agent-excluded-types"
              className="input"
              value={excludedTaskTypes}
              onChange={(event) => setExcludedTaskTypes(event.target.value)}
              placeholder="design"
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-can-verify">可验收类型（逗号分隔）</label>
            <input
              id="agent-can-verify"
              className="input"
              value={canVerify}
              onChange={(event) => setCanVerify(event.target.value)}
              placeholder="frontend, backend"
            />
          </div>
          <div className="field">
            <label htmlFor="agent-can-approve">可审批类型（逗号分隔）</label>
            <input
              id="agent-can-approve"
              className="input"
              value={canApprove}
              onChange={(event) => setCanApprove(event.target.value)}
              placeholder="plan, release"
            />
          </div>
        </div>
        <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
          能力标签只用于 Planner 选人；不会扩大或替代工具权限。工具权限仍然决定 Agent 实际能做什么。
        </div>
        <div className="field">
          <label htmlFor="agent-allow">允许工具（逗号分隔；留空 = 未配置 = 拒绝执行）</label>
          <textarea
            id="agent-allow"
            className="textarea"
            value={allowTools}
            onChange={(event) => setAllowTools(event.target.value)}
            placeholder="Read, Edit, Write"
          />
        </div>
        <div className="field">
          <label htmlFor="agent-deny">禁止工具（逗号分隔；优先于允许）</label>
          <textarea
            id="agent-deny"
            className="textarea"
            value={denyTools}
            onChange={(event) => setDenyTools(event.target.value)}
            placeholder="Bash, WebFetch"
          />
        </div>
      </div>
      <div className="card-foot">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {initial ? '保存' : '创建'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
          名称/角色由 Core 校验
        </span>
      </div>
    </form>
  )
}
