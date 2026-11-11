import {
  AGENT_ACCESS_MODE_LABEL,
  type AgentCreateParams,
  type AgentDraft,
  type AgentGenerateDraftResult,
  type AgentProfile,
  type AgentUpdateParams,
  type RuntimeProviderRecord,
  type Skill,
} from '@agentra/protocol'
import { useMemo, useState } from 'react'
import { AgentAiCreateModal } from './AgentAiCreateModal'
import { AgentAvatar } from './AgentAvatar'
import { AgentForm } from './AgentForm'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { ProviderBadge, providerMark, providerMarkClass } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'

type Props = {
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  skills: Skill[]
  busy: boolean
  /** agentId → 正在运行的 executionId；用于把 Agent 标成“执行中”。 */
  runningExecutionByAgent?: Record<string, string>
  onCreate: (params: AgentCreateParams) => Promise<boolean>
  onUpdate: (params: AgentUpdateParams) => Promise<boolean>
  onArchive: (id: string) => Promise<void>
  /** 停用只阻止新 Execution，不中断已运行任务（用户 U4）。 */
  onSetStatus: (id: string, status: 'active' | 'disabled') => Promise<void>
}

const STATUS_LABEL: Record<string, string> = {
  active: '可用',
  disabled: '已停用',
  archived: '已归档',
}

const STATUS_RANK: Record<string, number> = { active: 0, disabled: 1, archived: 2 }

export function AgentsPage({
  agents,
  providers,
  skills,
  busy,
  runningExecutionByAgent = {},
  onCreate,
  onUpdate,
  onArchive,
  onSetStatus,
}: Props) {
  const [formMode, setFormMode] = useState<'none' | 'create' | 'edit'>('none')
  const [editing, setEditing] = useState<AgentProfile | null>(null)
  const [formDraft, setFormDraft] = useState<AgentDraft | null>(null)
  const [formNotice, setFormNotice] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [accessFilter, setAccessFilter] = useState<'all' | 'analyze' | 'edit'>('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null)

  const openCreate = (): void => {
    setEditing(null)
    setFormDraft(null)
    setFormNotice(null)
    setFormMode('create')
  }
  const openEdit = (agent: AgentProfile): void => {
    setEditing(agent)
    setFormDraft(null)
    setFormNotice(null)
    setFormMode('edit')
  }
  const closeForm = (): void => {
    setEditing(null)
    setFormDraft(null)
    setFormNotice(null)
    setFormMode('none')
  }
  const handleGenerated = (result: AgentGenerateDraftResult): void => {
    setAiOpen(false)
    setEditing(null)
    setFormDraft(result.draft)
    setFormNotice(
      result.source === 'fallback'
        ? `AI 生成不可用，已给出基础草案：${result.reason ?? '未知原因'}`
        : 'AI 草案已生成；请选择 Provider，并确认或调整内容后创建。',
    )
    setFormMode('create')
  }

  const providerOf = (agent: AgentProfile): RuntimeProviderRecord | null =>
    providers.find((provider) => provider.id === agent.defaultProviderId) ?? null

  const skillNames = useMemo(() => new Map(skills.map((skill) => [skill.id, skill.name])), [skills])

  const query = search.trim().toLowerCase()

  const providerCounts = (() => {
    const counts = new Map<string, number>()
    for (const agent of agents) {
      if (agent.defaultProviderId) {
        counts.set(agent.defaultProviderId, (counts.get(agent.defaultProviderId) ?? 0) + 1)
      }
    }
    return counts
  })()

  const filtered = agents
    .filter((agent) => {
      if (accessFilter !== 'all' && agent.accessMode !== accessFilter) return false
      if (providerFilter !== 'all' && agent.defaultProviderId !== providerFilter) {
        return false
      }
      if (query.length === 0) return true
      const names = agent.skillIds.map((id) => skillNames.get(id) ?? '')
      return (
        agent.name.toLowerCase().includes(query) ||
        agent.description.toLowerCase().includes(query) ||
        names.some((skillName) => skillName.toLowerCase().includes(query))
      )
    })
    .sort((left, right) => {
      const leftRunning = runningExecutionByAgent[left.id] ? 0 : 1
      const rightRunning = runningExecutionByAgent[right.id] ? 0 : 1
      if (leftRunning !== rightRunning) return leftRunning - rightRunning
      const rank = (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9)
      if (rank !== 0) return rank
      return left.name.localeCompare(right.name)
    })

  const runningCount = agents.filter((agent) => runningExecutionByAgent[agent.id]).length

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        subtitle={
          <>
            {agents.length} 个 Agent · {runningCount} 个执行中
          </>
        }
        actions={
          <>
            <label className="input input-search">
              <Icon name="search" size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索名称、专长或技能"
              />
            </label>
            <select
              className="select"
              value={accessFilter}
              onChange={(event) =>
                setAccessFilter(event.target.value as 'all' | 'analyze' | 'edit')
              }
              aria-label="按工作权限筛选"
            >
              <option value="all">全部权限</option>
              <option value="analyze">只读分析</option>
              <option value="edit">编辑</option>
            </select>
            <button type="button" className="btn btn-primary" onClick={openCreate} disabled={busy}>
              <Icon name="plus" size={14} />
              新建 Agent
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setAiOpen(true)}
              disabled={busy}
            >
              <Icon name="zap" size={14} />
              AI 创建
            </button>
          </>
        }
      />

      <div className="filter-chips">
        <button
          type="button"
          className={`chip-filter ${providerFilter === 'all' ? 'on' : ''}`}
          onClick={() => setProviderFilter('all')}
        >
          全部
          <span className="count">{agents.length}</span>
        </button>
        {providers
          .filter(
            (provider) =>
              (providerCounts.get(provider.id) ?? 0) > 0 || providerFilter === provider.id,
          )
          .map((provider) => (
            <button
              type="button"
              key={provider.id}
              className={`chip-filter ${providerFilter === provider.id ? 'on' : ''}`}
              onClick={() => setProviderFilter(provider.id)}
            >
              <span className={`provider-mark ${providerMarkClass(provider.providerName)}`}>
                {providerMark(provider.providerName)}
              </span>
              {provider.providerName}
              <span className="count">{providerCounts.get(provider.id) ?? 0}</span>
            </button>
          ))}
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 14 }}>
          <div className="card">
            {agents.length === 0 ? (
              <div className="empty-state">还没有 Agent。点击“新建 Agent”创建第一个员工身份。</div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">没有符合筛选条件的 Agent。</div>
            ) : (
              <table className="agents-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>工作权限</th>
                    <th>Provider / 模型</th>
                    <th>技能</th>
                    <th>并发</th>
                    <th>当前任务</th>
                    <th>状态</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((agent) => {
                    const provider = providerOf(agent)
                    const runningExecution = runningExecutionByAgent[agent.id]
                    const agentSkills = agent.skillIds
                      .map((id) => skillNames.get(id))
                      .filter((name): name is string => name !== undefined)
                    return (
                      <tr key={agent.id}>
                        <td>
                          <div className="agent-cell">
                            <AgentAvatar avatar={agent.avatar} size={26} />
                            <div>
                              <div className="name">
                                {agent.name}
                                {agent.systemKind !== null && (
                                  <span className="pill plain" style={{ marginLeft: 6 }}>
                                    系统
                                  </span>
                                )}
                              </div>
                              <div className="sub">{agent.description || '未填写擅长的工作'}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`pill ${agent.accessMode === 'edit' ? 'running' : 'plain'}`}
                          >
                            {AGENT_ACCESS_MODE_LABEL[agent.accessMode]}
                          </span>
                        </td>
                        <td>
                          <ProviderBadge provider={provider} />
                          {agent.model && (
                            <div className="faint" style={{ fontSize: 10.5, marginTop: 2 }}>
                              {agent.model}
                            </div>
                          )}
                        </td>
                        <td>
                          {agentSkills.length === 0 ? (
                            <span className="task-none">—</span>
                          ) : (
                            <div className="tool-chips">
                              {agentSkills.slice(0, 2).map((skill) => (
                                <span className="chip" key={skill}>
                                  {skill}
                                </span>
                              ))}
                              {agentSkills.length > 2 && (
                                <span className="chip">+{agentSkills.length - 2}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td>{agent.maxConcurrency}</td>
                        <td>
                          {runningExecution ? (
                            <button
                              type="button"
                              className="task-link"
                              title={runningExecution}
                              onClick={() => openEdit(agent)}
                            >
                              执行中 · {runningExecution.slice(0, 12)}…
                            </button>
                          ) : (
                            <span className="task-none">—</span>
                          )}
                        </td>
                        <td>
                          {runningExecution ? (
                            <span className="pill running">执行中</span>
                          ) : (
                            <StatusBadge
                              status={agent.status}
                              label={STATUS_LABEL[agent.status] ?? agent.status}
                            />
                          )}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => openEdit(agent)}
                              disabled={busy}
                            >
                              编辑
                            </button>
                            <div className="menu-wrap">
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon btn-sm"
                                aria-label={`更多操作 ${agent.name}`}
                                onClick={() =>
                                  setMenuAgentId((current) =>
                                    current === agent.id ? null : agent.id,
                                  )
                                }
                              >
                                <Icon name="more" size={14} />
                              </button>
                              {menuAgentId === agent.id && (
                                <div className="menu">
                                  {agent.status !== 'archived' && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMenuAgentId(null)
                                        void onSetStatus(
                                          agent.id,
                                          agent.status === 'active' ? 'disabled' : 'active',
                                        )
                                      }}
                                      disabled={busy}
                                    >
                                      {agent.status === 'active'
                                        ? '停用（不影响运行中任务）'
                                        : '启用'}
                                    </button>
                                  )}
                                  {agent.status !== 'archived' && (
                                    <button
                                      type="button"
                                      className="danger"
                                      onClick={() => {
                                        setMenuAgentId(null)
                                        void onArchive(agent.id)
                                      }}
                                      disabled={busy}
                                    >
                                      归档
                                    </button>
                                  )}
                                  {agent.status === 'archived' && (
                                    <button type="button" disabled>
                                      已归档
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {formMode !== 'none' && (
        <AgentForm
          providers={providers}
          skills={skills}
          initial={formMode === 'edit' ? editing : null}
          draft={formDraft}
          notice={formNotice}
          busy={busy}
          onSubmit={(params) =>
            formMode === 'edit'
              ? onUpdate(params as AgentUpdateParams)
              : onCreate(params as AgentCreateParams)
          }
          onCancel={closeForm}
        />
      )}

      <AgentAiCreateModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onGenerated={handleGenerated}
      />
    </div>
  )
}
