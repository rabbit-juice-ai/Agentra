import {
  AGENT_ACCESS_MODE_LABEL,
  type AgentAccessMode,
  type AgentCreateParams,
  type AgentDraft,
  type AgentProfile,
  type AgentUpdateParams,
  DEFAULT_AGENT_AVATAR,
  type RuntimeProviderModel,
  type RuntimeProviderRecord,
  type Skill,
} from '@agentra/protocol'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import { toAvatarDataUrl, validateAvatarFile } from '../utils/avatar-image'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './Icon'
import { Modal } from './Modal'

type Props = {
  providers: RuntimeProviderRecord[]
  skills: Skill[]
  initial: AgentProfile | null
  /** AI 生成的草案；与 initial 互斥，仅用于新建。 */
  draft?: AgentDraft | null
  /** 草案来源提示（AI 成功 / 兜底原因）。 */
  notice?: string | null
  busy: boolean
  onSubmit: (params: AgentCreateParams | AgentUpdateParams) => Promise<boolean>
  onCancel: () => void
}

const PROVIDER_HEALTH_LABEL: Record<string, string> = {
  healthy: '健康',
  unauthenticated: '未认证',
  unavailable: '不可用',
  unknown: '未知',
}

const AVATAR_PRESETS = ['🤖', '🧑‍💻', '🧪', '🧠', '🎨', '🛠️', '📦', '🦊', '🧭', '📝', '🔍', '⚙️']

const ACCESS_MODE_OPTIONS: {
  mode: AgentAccessMode
  title: string
  summary: string
}[] = [
  {
    mode: 'analyze',
    title: '只读分析',
    summary: '读代码、查资料、运行命令；不能写入或修改文件。适合需求分析、代码审查、测试验收。',
  },
  {
    mode: 'edit',
    title: '编辑',
    summary: '可以创建和修改文件、执行命令。适合实现功能、修 bug 和重构代码。',
  },
]

const CUSTOM_MODEL = '__custom__'

/**
 * Agent 创建/编辑弹框：只收集输入。
 * 校验、权限派生与持久化在 Core（Zod）完成；技能从全局技能库引用。
 */
export function AgentForm({
  providers,
  skills,
  initial,
  draft = null,
  notice = null,
  busy,
  onSubmit,
  onCancel,
}: Props) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(DEFAULT_AGENT_AVATAR)
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [accessMode, setAccessMode] = useState<AgentAccessMode>('analyze')
  const [defaultProviderId, setDefaultProviderId] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [maxConcurrency, setMaxConcurrency] = useState('5')
  const [models, setModels] = useState<RuntimeProviderModel[]>([])
  const [modelSource, setModelSource] = useState<'provider' | 'catalog' | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const modelsRequestRef = useRef(0)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const source = initial ?? draft
    setName(source?.name ?? '')
    setAvatar(source?.avatar ?? DEFAULT_AGENT_AVATAR)
    setDescription(source?.description ?? '')
    setSystemPrompt(source?.systemPrompt ?? '')
    setSkillIds(source?.skillIds ?? [])
    setAccessMode(source?.accessMode ?? 'analyze')
    setDefaultProviderId(initial?.defaultProviderId ?? '')
    setModel(initial?.model ?? '')
    setCustomModel(false)
    setMaxConcurrency(String(source?.maxConcurrency ?? 5))
    setAvatarOpen(false)
    setAvatarError(null)
  }, [initial, draft])

  // 切换 Provider 时拉取候选模型；失败不阻断开单，用户仍可手填模型 ID。
  const loadModels = useCallback(async (providerId: string): Promise<void> => {
    const requestId = ++modelsRequestRef.current
    if (providerId === '') {
      setModels([])
      setModelSource(null)
      setModelsError(null)
      setLoadingModels(false)
      return
    }
    setLoadingModels(true)
    setModelsError(null)
    try {
      const result = await api.listProviderModels(providerId)
      if (requestId !== modelsRequestRef.current) return
      setModels(result.models)
      setModelSource(result.source)
    } catch (error) {
      if (requestId !== modelsRequestRef.current) return
      setModels([])
      setModelSource(null)
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === modelsRequestRef.current) setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void loadModels(defaultProviderId)
    return () => {
      // 组件卸载或快速切换 Provider 时，让旧请求的结果失效。
      modelsRequestRef.current += 1
    }
  }, [defaultProviderId, loadModels])

  useEffect(() => {
    if (!avatarOpen) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target?.closest('.avatar-field')) return
      setAvatarOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAvatarOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [avatarOpen])

  const handleAvatarFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const validationError = validateAvatarFile(file)
    if (validationError) {
      setAvatarError(validationError)
      return
    }
    try {
      const dataUrl = await toAvatarDataUrl(file)
      setAvatar(dataUrl)
      setAvatarOpen(false)
      setAvatarError(null)
    } catch {
      setAvatarError('图片读取失败，请换一张再试')
    }
  }

  const systemAgent = initial?.systemKind !== null && initial?.systemKind !== undefined
  const providerOptions = useMemo(() => {
    const options = [...providers]
    if (
      initial?.defaultProviderId &&
      !options.some((provider) => provider.id === initial.defaultProviderId)
    ) {
      // 历史 Agent 可能指向已不再被发现的 Provider；保留原值以便用户改绑。
      options.unshift({
        id: initial.defaultProviderId,
        providerType: 'cli',
        providerName: `${initial.defaultProviderId}（未发现）`,
        executablePath: null,
        version: null,
        capabilities: {
          streaming: 'unsupported',
          structuredEvents: 'unsupported',
          interrupt: 'unsupported',
          resume: 'unsupported',
          checkpoint: 'unsupported',
          permissionRequests: 'unsupported',
          sessionPersistence: 'unsupported',
          workingDirectory: 'unsupported',
          toolControl: 'unsupported',
        },
        healthStatus: 'unavailable',
        authMethod: null,
        healthDetail: null,
        lastDiscoveredAt: null,
        createdAt: initial.createdAt,
        updatedAt: initial.updatedAt,
      })
    }
    return options
  }, [providers, initial])

  const modelInCatalog = models.some((item) => item.id === model)
  const showCustomInput = customModel || (model !== '' && !modelInCatalog)
  const selectModelValue = showCustomInput ? CUSTOM_MODEL : model
  const modelGroups = useMemo(() => {
    const groups = new Map<string, RuntimeProviderModel[]>()
    for (const item of models) {
      const separator = item.id.indexOf(':')
      const group = separator > 0 ? item.id.slice(0, separator) : '可用模型'
      const list = groups.get(group) ?? []
      list.push(item)
      groups.set(group, list)
    }
    return [...groups.entries()]
  }, [models])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (defaultProviderId === '') return
    const parsedConcurrency = Number.parseInt(maxConcurrency, 10)
    const base = {
      name: name.trim(),
      avatar,
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      skillIds,
      accessMode,
      model: model.trim() || null,
      defaultProviderId,
      maxConcurrency: Number.isFinite(parsedConcurrency) ? parsedConcurrency : 5,
    }
    const ok = await onSubmit(initial ? { ...base, id: initial.id } : base)
    if (ok) onCancel()
  }

  const toggleSkill = (skillId: string): void => {
    setSkillIds((current) =>
      current.includes(skillId) ? current.filter((id) => id !== skillId) : [...current, skillId],
    )
  }

  const canSubmit = !busy && name.trim().length > 0 && defaultProviderId !== ''

  return (
    <Modal
      open
      title={initial ? `编辑 Agent · ${initial.name}` : '新建 Agent'}
      onClose={onCancel}
      width={760}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 11 }}>
            名称与 Provider 由 Core 校验；工作权限决定实际工具策略。
          </span>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" form="agent-form" className="btn btn-primary" disabled={!canSubmit}>
            {initial ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <form id="agent-form" className="agent-form" onSubmit={(event) => void submit(event)}>
        {notice && (
          <div
            className={`banner ${notice.startsWith('AI 生成不可用') ? 'warn' : ''}`}
            style={{ margin: 0 }}
          >
            {notice}
          </div>
        )}
        <div className="agent-form-identity">
          <div className="field avatar-field">
            <span className="field-label">头像</span>
            <div className="avatar-current-row">
              <button
                type="button"
                className="avatar-current"
                onClick={() => setAvatarOpen((open) => !open)}
                aria-expanded={avatarOpen}
                aria-label="更换头像"
                title="更换头像"
              >
                <AgentAvatar avatar={avatar} size={46} />
              </button>
              <div className="avatar-current-copy">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setAvatarOpen((open) => !open)}
                >
                  更换头像
                </button>
                <span className="field-hint">默认 🤖；点击选择 emoji 或上传本地图片。</span>
              </div>
            </div>
            {avatarOpen && (
              <div className="avatar-popover" role="dialog" aria-label="选择头像">
                <div className="avatar-popover-title">选择头像</div>
                <div className="avatar-picker">
                  {AVATAR_PRESETS.map((emoji) => (
                    <button
                      type="button"
                      key={emoji}
                      className={`avatar-choice ${avatar === emoji ? 'on' : ''}`}
                      onClick={() => {
                        setAvatar(emoji)
                        setAvatarOpen(false)
                        setAvatarError(null)
                      }}
                      aria-label={`选择头像 ${emoji}`}
                      aria-pressed={avatar === emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <div className="avatar-popover-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <Icon name="upload" size={13} />
                    上传本地图片
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setAvatar(DEFAULT_AGENT_AVATAR)
                      setAvatarOpen(false)
                      setAvatarError(null)
                    }}
                  >
                    恢复默认
                  </button>
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    void handleAvatarFile(file)
                  }}
                />
                <span className="field-hint">PNG / JPG / WebP / GIF，自动裁剪为方形。</span>
              </div>
            )}
            {avatarError && (
              <span className="field-hint" style={{ color: 'var(--danger)' }}>
                {avatarError}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="agent-name">名称 *</label>
            <input
              id="agent-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：前端开发、测试工程师"
              required
            />
            <span className="field-hint">给人看的员工名字；Planner 会结合下面的专长选人。</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="agent-description">擅长的工作与调用时机</label>
          <textarea
            id="agent-description"
            className="textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="例如：负责 React/TypeScript 界面实现；在需要改 UI 或修前端 bug 时调用。"
          />
          <span className="field-hint">
            写清「擅长什么」和「什么时候找它」；这是 Planner 调度时的语义依据，不替代工作权限。
          </span>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-provider">Provider *</label>
            <select
              id="agent-provider"
              className="select"
              value={defaultProviderId}
              onChange={(event) => {
                setDefaultProviderId(event.target.value)
                setModel('')
                setCustomModel(false)
              }}
              required
            >
              <option value="" disabled>
                {providers.length === 0 ? '尚未发现 Provider' : '请选择 Provider'}
              </option>
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.providerName} ·{' '}
                  {PROVIDER_HEALTH_LABEL[provider.healthStatus] ?? provider.healthStatus}
                </option>
              ))}
            </select>
            <span className="field-hint">
              必须显式选择，不会再自动挑选健康 Provider；未认证的 Provider 启动时会被 Core 拒绝。
            </span>
          </div>
          <div className="field">
            <div className="field-label-row">
              <label htmlFor="agent-model">模型</label>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                title="重新获取模型"
                disabled={defaultProviderId === '' || loadingModels}
                onClick={() => void loadModels(defaultProviderId)}
              >
                <Icon name="refresh" size={12} />
              </button>
            </div>
            <select
              id="agent-model"
              className="select"
              value={selectModelValue}
              onChange={(event) => {
                const value = event.target.value
                if (value === CUSTOM_MODEL) {
                  setCustomModel(true)
                  return
                }
                setCustomModel(false)
                setModel(value)
              }}
              disabled={defaultProviderId === '' || loadingModels}
            >
              <option value="">使用 Provider 默认模型</option>
              {modelGroups.length <= 1
                ? models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))
                : modelGroups.map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              <option value={CUSTOM_MODEL}>自定义模型 ID…</option>
            </select>
            {showCustomInput && (
              <input
                className="input"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="输入 Provider 支持的模型 ID"
                aria-label="自定义模型 ID"
              />
            )}
            <span className="field-hint">
              {loadingModels
                ? '正在从 Provider 读取模型…'
                : modelsError
                  ? `读取模型失败：${modelsError}；仍可手填自定义 ID。`
                  : defaultProviderId === ''
                    ? '选择 Provider 后会自动读取模型列表。'
                    : modelSource === 'provider'
                      ? `已从 Provider 读取当前配置的 ${models.length} 个可用模型；也可填写自定义 ID。`
                      : 'Provider 未提供模型列表，当前显示内置候选；也可填写自定义 ID。'}
            </span>
          </div>
        </div>

        <div className="field">
          <span className="field-label">工作权限 *</span>
          <div className="access-options">
            {ACCESS_MODE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.mode}
                className={`access-option ${accessMode === option.mode ? 'on' : ''}`}
                onClick={() => setAccessMode(option.mode)}
                aria-pressed={accessMode === option.mode}
                disabled={systemAgent && option.mode !== 'analyze'}
              >
                <span className="access-option-head">
                  <strong>{option.title}</strong>
                  {accessMode === option.mode && <Icon name="check" size={14} />}
                </span>
                <span className="access-option-summary">{option.summary}</span>
              </button>
            ))}
          </div>
          <span className="field-hint">
            {systemAgent
              ? '这是系统 Agent，工作权限固定为只读分析，不能改为编辑。'
              : `任务会按权限严格匹配：${AGENT_ACCESS_MODE_LABEL.analyze} Agent 不会接到改代码的任务，${AGENT_ACCESS_MODE_LABEL.edit} Agent 不会承接分析与验收任务。工具清单由 Core 自动派生。`}
          </span>
        </div>

        <div className="field">
          <label htmlFor="agent-instructions">工作指令</label>
          <textarea
            id="agent-instructions"
            className="textarea"
            rows={5}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="例如：你是资深前端工程师。改动前先阅读现有组件与样式约定；完成后运行相关测试。"
          />
          <span className="field-hint">
            这就是该 Agent 的系统提示词：描述它的工作方式、质量标准和边界。
          </span>
        </div>

        <div className="field">
          <span className="field-label">技能</span>
          {skills.length === 0 ? (
            <div className="empty-state" style={{ padding: '10px 0' }}>
              技能库为空。先到「技能」页创建，再回到这里选择。
            </div>
          ) : (
            <div className="skill-picker">
              {skills.map((skill) => (
                <label
                  key={skill.id}
                  className={`skill-option ${skillIds.includes(skill.id) ? 'on' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={skillIds.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <span>
                    <strong>{skill.name}</strong>
                    <span className="skill-option-desc">
                      {skill.description || skill.instructions.slice(0, 80)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <span className="field-hint">
            技能属于这个 Agent，但内容统一维护在全局技能库；执行时会把所选技能追加到工作指令之后。
          </span>
        </div>

        <div className="field" style={{ maxWidth: 220 }}>
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
          <span className="field-hint">同一 Agent 同时运行的最大执行数，默认 5。</span>
        </div>
      </form>
    </Modal>
  )
}
