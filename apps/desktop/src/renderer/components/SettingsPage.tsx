import type {
  AgentProfile,
  HealthResult,
  RuntimeProviderModelsResult,
  RuntimeProviderRecord,
} from '@agentra/protocol'
import { useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../services/api'
import { useUserProfile } from '../utils/user-profile'
import { AvatarField } from './AvatarField'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { plannerDraftMatches } from './planner-config'
import { StatusBadge } from './StatusBadge'

export const SETTINGS_PAGE_MARKER = 'agentra-product-settings'

type SettingsCategory = 'runtime' | 'planner' | 'profile' | 'data' | 'about'

const CATEGORIES: {
  key: SettingsCategory
  label: string
  icon: 'grid' | 'zap' | 'users' | 'archive' | 'doc'
}[] = [
  { key: 'runtime', label: '运行时', icon: 'grid' },
  { key: 'planner', label: 'Planner', icon: 'zap' },
  { key: 'profile', label: '个人', icon: 'users' },
  { key: 'data', label: '数据', icon: 'archive' },
  { key: 'about', label: '关于', icon: 'doc' },
]

/**
 * 设置页：按运行时 / Planner / 数据 / 关于分类。
 * 只展示真实可操作的配置，不伪造开关。
 */
export function SettingsPage({
  coreHealth,
  daemonHealth,
  providers,
  worksCount,
  projectsCount,
  agentsCount,
  onRefreshProviders,
  onRefreshAgents,
  onOpenBackups,
}: {
  coreHealth: HealthResult | null
  daemonHealth: HealthResult | null
  providers: RuntimeProviderRecord[]
  worksCount: number
  projectsCount: number
  agentsCount: number
  onRefreshProviders: () => Promise<void>
  onRefreshAgents?: () => Promise<void>
  onOpenBackups: () => void
}) {
  const [category, setCategory] = useState<SettingsCategory>('runtime')
  const [appInfo, setAppInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const [planner, setPlanner] = useState<AgentProfile | null>(null)
  const [plannerName, setPlannerName] = useState('')
  const [plannerAvatar, setPlannerAvatar] = useState('🧭')
  const [plannerProviderId, setPlannerProviderId] = useState('')
  const [plannerModel, setPlannerModel] = useState('')
  const [plannerModels, setPlannerModels] = useState<RuntimeProviderModelsResult['models']>([])
  const [modelSource, setModelSource] = useState<RuntimeProviderModelsResult['source'] | null>(null)
  const [plannerLoading, setPlannerLoading] = useState(false)
  const [plannerAttempted, setPlannerAttempted] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [plannerSaving, setPlannerSaving] = useState(false)
  const [plannerError, setPlannerError] = useState<string | null>(null)
  const [plannerSaved, setPlannerSaved] = useState(false)

  const { profile: userProfile, updateProfile } = useUserProfile()
  const [userNameDraft, setUserNameDraft] = useState(userProfile.name)
  const [userAvatarDraft, setUserAvatarDraft] = useState(userProfile.avatar)
  const [profileSaved, setProfileSaved] = useState(false)

  const saveProfile = (): void => {
    const name = userNameDraft.trim()
    if (!name) return
    updateProfile({ name, avatar: userAvatarDraft })
    setProfileSaved(true)
  }

  const healthy = providers.filter((provider) => provider.healthStatus === 'healthy').length
  const plannerProvider = providers.find((provider) => provider.id === plannerProviderId) ?? null

  useEffect(() => {
    void window.agentra
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null))
  }, [])

  const loadModels = async (providerId: string): Promise<void> => {
    if (providerId === '') {
      setPlannerModels([])
      setModelSource(null)
      return
    }
    setModelsLoading(true)
    try {
      const result = await api.listProviderModels(providerId)
      setPlannerModels(result.models)
      setModelSource(result.source)
    } catch {
      setPlannerModels([])
      setModelSource(null)
    } finally {
      setModelsLoading(false)
    }
  }

  const loadPlanner = async (): Promise<void> => {
    if (plannerLoading) return
    setPlannerLoading(true)
    setPlannerError(null)
    setPlannerSaved(false)
    try {
      // Core 启动时会自动创建 Planner；优先读取现有 Agent，避免设置页依赖新 preload 方法。
      const agents = await api.listAgents()
      let agent = agents.find((candidate) => candidate.systemKind === 'planner') ?? null
      if (!agent && typeof window.agentra.ensurePlannerAgent === 'function') {
        agent = (await api.ensurePlannerAgent()).agent
      }
      if (!agent) {
        throw new Error('Planner Agent 尚未创建；请重启应用，Core 会自动创建默认 Planner')
      }
      setPlanner(agent)
      setPlannerName(agent.name)
      setPlannerAvatar(agent.avatar)
      const providerId = agent.defaultProviderId ?? providers[0]?.id ?? ''
      setPlannerProviderId(providerId)
      setPlannerModel(agent.model ?? '')
      await loadModels(providerId)
    } catch (err) {
      setPlannerError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setPlannerLoading(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load Planner once when entering the category
  useEffect(() => {
    if (category === 'planner' && !plannerAttempted) {
      setPlannerAttempted(true)
      void loadPlanner()
    }
  }, [category, plannerAttempted])

  const selectProvider = (providerId: string): void => {
    setPlannerProviderId(providerId)
    setPlannerModel('')
    setPlannerSaved(false)
    void loadModels(providerId)
  }

  const savePlanner = async (): Promise<void> => {
    if (!planner || plannerProviderId === '' || plannerSaving) return
    const name = plannerName.trim()
    if (!name) {
      setPlannerError('Planner 名字不能为空')
      return
    }
    setPlannerSaving(true)
    setPlannerError(null)
    setPlannerSaved(false)
    try {
      const updated = await api.updateAgent({
        id: planner.id,
        name,
        avatar: plannerAvatar,
        defaultProviderId: plannerProviderId,
        model: plannerModel.trim() === '' ? null : plannerModel.trim(),
      })
      setPlanner(updated)
      setPlannerName(updated.name)
      setPlannerAvatar(updated.avatar)
      setPlannerModel(updated.model ?? '')
      setPlannerSaved(true)
      await onRefreshAgents?.()
    } catch (err) {
      setPlannerError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setPlannerSaving(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      await onRefreshProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const openDataDir = async (): Promise<void> => {
    setOpening(true)
    setError(null)
    try {
      const result = await window.agentra.openDataDir()
      if (result.error) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const modelOptions = useMemo(() => {
    const options = [...plannerModels]
    if (plannerModel !== '' && !options.some((model) => model.id === plannerModel)) {
      options.unshift({ id: plannerModel, label: `${plannerModel}（当前）` })
    }
    return options
  }, [plannerModels, plannerModel])

  return (
    <div data-agentra-page={SETTINGS_PAGE_MARKER} className="page">
      <PageHeader
        title="设置"
        subtitle="运行时、Planner、数据与产品信息；只展示真实可操作的配置。"
      />

      {error && <div className="banner error">{error}</div>}

      <div className="settings-layout">
        <aside className="settings-nav">
          {CATEGORIES.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`settings-nav-item ${category === item.key ? 'on' : ''}`}
              onClick={() => setCategory(item.key)}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
            </button>
          ))}
        </aside>

        <div className="settings-content">
          {category === 'runtime' && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">运行时</div>
                <div className="right">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={refreshing}
                    onClick={() => void refresh()}
                  >
                    <Icon name="refresh" size={13} />
                    {refreshing ? '发现中…' : '重新发现 Provider'}
                  </button>
                </div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                <dl className="kv">
                  <dt>Core</dt>
                  <dd>
                    <StatusBadge
                      status={coreHealth ? 'healthy' : 'unavailable'}
                      label={coreHealth ? '正常' : '断连'}
                    />
                  </dd>
                  <dt>Daemon</dt>
                  <dd>
                    <StatusBadge
                      status={daemonHealth ? 'healthy' : 'unavailable'}
                      label={daemonHealth ? '正常' : '断连'}
                    />
                  </dd>
                  <dt>Provider</dt>
                  <dd>
                    {healthy}/{providers.length} 健康
                  </dd>
                  <dt>协议版本</dt>
                  <dd className="mono">{coreHealth?.protocolVersion ?? '—'}</dd>
                </dl>
                <div style={{ display: 'grid', gap: 6 }}>
                  {providers.map((provider) => (
                    <div
                      key={provider.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                    >
                      <span style={{ flex: 1 }}>{provider.providerName}</span>
                      <span title={provider.healthDetail ?? undefined}>
                        <StatusBadge status={provider.healthStatus} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {category === 'planner' && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">
                  Planner 配置
                  {planner && (
                    <span className={`pill ${planner.status === 'active' ? 'done' : 'warn'}`}>
                      {planner.status === 'active' ? '已启用' : planner.status}
                    </span>
                  )}
                </div>
                <div className="right">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={plannerLoading || modelsLoading}
                    onClick={() => void loadPlanner()}
                  >
                    <Icon name="refresh" size={13} />
                    重新读取
                  </button>
                </div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 14 }}>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
                  Planner 是独立 AI 幕僚长：负责和老板讨论目标、提议团队/任务卡、处理队长升级。
                  这里配置它使用的 Provider 和模型；Planner 只读、不执行实现任务。
                </div>
                {plannerError && <div className="banner error">{plannerError}</div>}
                {plannerLoading ? (
                  <div className="empty-state">正在准备 Planner Agent…</div>
                ) : planner ? (
                  <>
                    <dl className="kv">
                      <dt>工作权限</dt>
                      <dd>{planner.accessMode === 'analyze' ? '只读分析' : '编辑'}</dd>
                      <dt>当前模型</dt>
                      <dd className="mono">{planner.model ?? 'Provider 默认'}</dd>
                    </dl>
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor="planner-name">Planner 名字 *</label>
                        <input
                          id="planner-name"
                          className="input"
                          value={plannerName}
                          onChange={(event) => {
                            setPlannerName(event.target.value)
                            setPlannerSaved(false)
                          }}
                          disabled={plannerSaving}
                        />
                      </div>
                      <AvatarField
                        label="Planner 头像"
                        value={plannerAvatar}
                        fallback="🧭"
                        disabled={plannerSaving}
                        onChange={(value) => {
                          setPlannerAvatar(value)
                          setPlannerSaved(false)
                        }}
                      />
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor="planner-provider">Provider *</label>
                        <select
                          id="planner-provider"
                          className="select"
                          value={plannerProviderId}
                          onChange={(event) => selectProvider(event.target.value)}
                          disabled={plannerSaving}
                        >
                          {providers.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.providerName} · {provider.healthStatus}
                            </option>
                          ))}
                        </select>
                        {plannerProvider && plannerProvider.healthStatus !== 'healthy' && (
                          <div className="faint" style={{ color: 'var(--danger)', fontSize: 11 }}>
                            当前 Provider 不健康，Planner 调用会失败。
                          </div>
                        )}
                        {plannerProvider &&
                          plannerProvider.healthStatus === 'healthy' &&
                          plannerProvider.capabilities.toolControl !== 'native' && (
                            <div className="faint" style={{ fontSize: 10.5 }}>
                              该 Provider 使用模拟工具控制；Planner 仍按只读提示运行，底层限制取决于
                              Provider。
                            </div>
                          )}
                      </div>
                      <div className="field">
                        <label htmlFor="planner-model">模型</label>
                        <select
                          id="planner-model"
                          className="select"
                          value={plannerModel}
                          onChange={(event) => {
                            setPlannerModel(event.target.value)
                            setPlannerSaved(false)
                          }}
                          disabled={plannerSaving || modelsLoading}
                        >
                          <option value="">Provider 默认模型</option>
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                        </select>
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          {modelsLoading
                            ? '读取模型中…'
                            : modelSource === 'provider'
                              ? '模型来自 Provider 当前配置'
                              : modelSource === 'catalog'
                                ? '模型来自内置候选目录'
                                : '未读取到模型，使用 Provider 默认'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={
                          plannerSaving ||
                          plannerProviderId === '' ||
                          plannerDraftMatches(
                            {
                              name: plannerName,
                              avatar: plannerAvatar,
                              providerId: plannerProviderId,
                              model: plannerModel,
                            },
                            {
                              name: planner.name,
                              avatar: planner.avatar,
                              providerId: planner.defaultProviderId ?? '',
                              model: planner.model ?? null,
                            },
                          )
                        }
                        onClick={() => void savePlanner()}
                      >
                        {plannerSaving ? '保存中…' : '保存 Planner 配置'}
                      </button>
                      {plannerSaved && (
                        <span className="pill done">已保存；Planner 聊天和规划会使用新配置</span>
                      )}
                    </div>
                    <div className="faint" style={{ fontSize: 10.5 }}>
                      Planner 的模型只影响聊天和规划质量；不会改变任何 Agent 的权限，也不会把
                      Planner 变成执行者。
                    </div>
                  </>
                ) : (
                  <div className="empty-state">Planner Agent 尚未创建。</div>
                )}
              </div>
            </div>
          )}

          {category === 'profile' && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">个人资料</div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 14 }}>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
                  这里设置你在 Planner
                  聊天和团队任务聊天里显示的名字与头像，只保存在本机，不会发送给 Provider。
                </div>
                <div className="field">
                  <label htmlFor="user-profile-name">我的名字 *</label>
                  <input
                    id="user-profile-name"
                    className="input"
                    value={userNameDraft}
                    onChange={(event) => {
                      setUserNameDraft(event.target.value)
                      setProfileSaved(false)
                    }}
                  />
                </div>
                <AvatarField
                  label="我的头像"
                  value={userAvatarDraft}
                  fallback="👤"
                  onChange={(value) => {
                    setUserAvatarDraft(value)
                    setProfileSaved(false)
                  }}
                />
                <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!userNameDraft.trim()}
                    onClick={saveProfile}
                  >
                    保存个人资料
                  </button>
                  {profileSaved && <span className="pill done">已保存</span>}
                </div>
              </div>
            </div>
          )}

          {category === 'data' && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">数据</div>
                <div className="right">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenBackups}>
                    备份中心
                  </button>
                </div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                <dl className="kv">
                  <dt>数据目录</dt>
                  <dd className="mono" style={{ wordBreak: 'break-all' }}>
                    {appInfo?.dataDir ?? '—'}
                  </dd>
                  <dt>项目 / 任务 / Agents</dt>
                  <dd>
                    {projectsCount} / {worksCount} / {agentsCount}
                  </dd>
                </dl>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ justifySelf: 'start' }}
                  disabled={opening}
                  onClick={() => void openDataDir()}
                >
                  <Icon name="external" size={13} />
                  {opening ? '打开中…' : '打开数据目录'}
                </button>
              </div>
            </div>
          )}

          {category === 'about' && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">关于</div>
              </div>
              <div className="card-body">
                <dl className="kv">
                  <dt>产品</dt>
                  <dd>Agentra</dd>
                  <dt>版本</dt>
                  <dd className="mono">{appInfo?.version ?? '—'}</dd>
                  <dt>桌面</dt>
                  <dd>Electron</dd>
                  <dt>协作模型</dt>
                  <dd>Planner 聊天室 → 团队任务线程 → 队长/成员</dd>
                  <dt>执行内核</dt>
                  <dd>结构化交付使用 Plan → Workflow Engine；团队任务使用线程协作</dd>
                </dl>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
