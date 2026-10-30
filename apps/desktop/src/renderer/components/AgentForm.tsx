import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  RuntimeProviderRecord,
} from '@agentra/protocol'
import { type FormEvent, useEffect, useState } from 'react'
import {
  buttonStyle,
  colors,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

type Props = {
  providers: RuntimeProviderRecord[]
  initial: AgentProfile | null
  busy: boolean
  onSubmit: (params: AgentCreateParams | AgentUpdateParams) => Promise<boolean>
  onCancel: () => void
}

/** 纯表单：只收集输入并回调，校验与持久化在 Core（Zod）完成。 */
export function AgentForm({ providers, initial, busy, onSubmit, onCancel }: Props) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [skills, setSkills] = useState('')
  const [defaultProviderId, setDefaultProviderId] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('1')

  useEffect(() => {
    setName(initial?.name ?? '')
    setRole(initial?.role ?? '')
    setDescription(initial?.description ?? '')
    setSystemPrompt(initial?.systemPrompt ?? '')
    setSkills((initial?.skills ?? []).join(', '))
    setDefaultProviderId(initial?.defaultProviderId ?? '')
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
      defaultProviderId: defaultProviderId === '' ? null : defaultProviderId,
      maxConcurrency: Number.isFinite(parsedConcurrency) ? parsedConcurrency : 1,
    }
    const ok = await onSubmit(initial ? { ...base, id: initial.id } : base)
    if (ok) onCancel()
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={panelStyle}>
      <h2 style={sectionTitleStyle}>{initial ? `编辑 Agent · ${initial.name}` : '新建 Agent'}</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        <label>
          <span style={labelStyle}>名称 *</span>
          <input
            style={inputStyle}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          <span style={labelStyle}>角色 *</span>
          <input
            style={inputStyle}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="engineer / reviewer / tester"
            required
          />
        </label>
        <label>
          <span style={labelStyle}>描述</span>
          <input
            style={inputStyle}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span style={labelStyle}>系统提示词</span>
          <textarea
            style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </label>
        <label>
          <span style={labelStyle}>技能（逗号分隔）</span>
          <input
            style={inputStyle}
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder="react, typescript"
          />
        </label>
        <label>
          <span style={labelStyle}>默认 Provider</span>
          <select
            style={inputStyle}
            value={defaultProviderId}
            onChange={(event) => setDefaultProviderId(event.target.value)}
          >
            <option value="">（自动选择健康 Provider）</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.providerName} · {provider.healthStatus}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span style={labelStyle}>最大并发（阶段 2 生效）</span>
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={64}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(event.target.value)}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="submit" style={primaryButtonStyle} disabled={busy}>
          {initial ? '保存' : '创建'}
        </button>
        <button type="button" style={buttonStyle} onClick={onCancel} disabled={busy}>
          取消
        </button>
        <span
          style={{ marginLeft: 'auto', fontSize: 12, color: colors.muted, alignSelf: 'center' }}
        >
          名称/角色由 Core 校验（不可为空）
        </span>
      </div>
    </form>
  )
}
