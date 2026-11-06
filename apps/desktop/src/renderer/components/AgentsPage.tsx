import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  RuntimeProviderRecord,
} from '@agentra/protocol'
import { useMemo, useState } from 'react'
import { AgentForm } from './AgentForm'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { ProviderBadge, providerMark, providerMarkClass } from './ProviderBadge'
import { ProvidersPanel } from './ProvidersPanel'
import { StatusBadge } from './StatusBadge'

type Props = {
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  busy: boolean
  /** agentId → 正在运行的 executionId；用于把 Agent 标成“执行中”。 */
  runningExecutionByAgent?: Record<string, string>
  onCreate: (params: AgentCreateParams) => Promise<boolean>
  onUpdate: (params: AgentUpdateParams) => Promise<boolean>
  onArchive: (id: string) => Promise<void>
  /** 停用只阻止新 Execution，不中断已运行任务（用户 U4）。 */
  onSetStatus: (id: string, status: 'active' | 'disabled') => Promise<void>
  onRefreshProviders: () => Promise<void>
}

const STATUS_LABEL: Record<string, string> = {
  active: '可用',
  disabled: '已停用',
  archived: '已归档',
}

const STATUS_RANK: Record<string, number> = { active: 0, disabled: 1, archived: 2 }

function initials(name: string): string {
  return name.trim().slice(0, 1) || 'A'
}

export function AgentsPage({
  agents,
  providers,
  busy,
  runningExecutionByAgent = {},
  onCreate,
  onUpdate,
  onArchive,
  onSetStatus,
  onRefreshProviders,
}: Props) {
  const [formMode, setFormMode] = useState<'none' | 'create' | 'edit'>('none')
  const [editing, setEditing] = useState<AgentProfile | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null)

  const openCreate = (): void => {
    setEditing(null)
    setFormMode('create')
  }
  const openEdit = (agent: AgentProfile): void => {
    setEditing(agent)
    setFormMode('edit')
  }
  const closeForm = (): void => {
    setEditing(null)
    setFormMode('none')
  }

  const providerOf = (agent: AgentProfile): RuntimeProviderRecord | null =>
    providers.find((provider) => provider.id === agent.defaultProviderId) ?? null

  const roles = useMemo(
    () =>
      [...new Set(agents.map((agent) => agent.role))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [agents],
  )

  const query = search.trim().toLowerCase()

  const providerCounts = (() => {
    const counts = new Map<string, number>()
    let auto = 0
    for (const agent of agents) {
      const provider = providerOf(agent)
      if (provider) counts.set(provider.id, (counts.get(provider.id) ?? 0) + 1)
      else auto += 1
    }
    return { counts, auto }
  })()

  const filtered = agents
    .filter((agent) => {
      if (roleFilter !== 'all' && agent.role !== roleFilter) return false
      const provider = providerOf(agent)
      if (providerFilter === 'auto' && provider) return false
      if (
        providerFilter !== 'all' &&
        providerFilter !== 'auto' &&
        provider?.id !== providerFilter
      ) {
        return false
      }
      if (query.length === 0) return true
      return (
        agent.name.toLowerCase().includes(query) ||
        agent.role.toLowerCase().includes(query) ||
        agent.description.toLowerCase().includes(query)
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
            {agents.length} 个 Agent · {providers.length} 个 Provider · {runningCount} 个执行中
          </>
        }
        actions={
          <>
            <label className="input input-search">
              <Icon name="search" size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 Agent 名称或角色"
              />
            </label>
            <select
              className="select"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
              aria-label="按角色筛选"
            >
              <option value="all">全部角色</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary" onClick={openCreate} disabled={busy}>
              <Icon name="plus" size={14} />
              新建 Agent
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
              (providerCounts.counts.get(provider.id) ?? 0) > 0 || providerFilter === provider.id,
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
              <span className="count">{providerCounts.counts.get(provider.id) ?? 0}</span>
            </button>
          ))}
        {providerCounts.auto > 0 && (
          <button
            type="button"
            className={`chip-filter ${providerFilter === 'auto' ? 'on' : ''}`}
            onClick={() => setProviderFilter('auto')}
          >
            自动选择
            <span className="count">{providerCounts.auto}</span>
          </button>
        )}
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
                    <th>角色</th>
                    <th>Provider</th>
                    <th>能力</th>
                    <th>工具权限</th>
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
                    const tools = agent.toolPermissions.allow
                    return (
                      <tr key={agent.id}>
                        <td>
                          <div className="agent-cell">
                            <span className="avatar">{initials(agent.name)}</span>
                            <div>
                              <div className="name">{agent.name}</div>
                              <div className="sub">
                                {agent.description || agent.role}
                                {agent.model ? ` · ${agent.model}` : ''}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>{agent.role}</td>
                        <td>
                          <ProviderBadge provider={provider} />
                        </td>
                        <td>
                          {agent.capabilities.taskTypes.length === 0 ? (
                            <span className="task-none">未配置</span>
                          ) : (
                            <div className="tool-chips">
                              {agent.capabilities.taskTypes.slice(0, 2).map((capability) => (
                                <span className="chip" key={capability}>
                                  {capability}
                                </span>
                              ))}
                              {agent.capabilities.taskTypes.length > 2 && (
                                <span className="chip">
                                  +{agent.capabilities.taskTypes.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          {tools.length === 0 ? (
                            <span className="pill danger">未配置</span>
                          ) : (
                            <div className="tool-chips">
                              {tools.slice(0, 3).map((tool) => (
                                <span className="chip" key={tool}>
                                  {tool}
                                </span>
                              ))}
                              {tools.length > 3 && (
                                <span className="chip">+{tools.length - 3}</span>
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

          <ProvidersPanel
            providers={providers}
            busy={busy}
            onRefresh={() => void onRefreshProviders()}
          />
        </div>

        {formMode !== 'none' && (
          <div className="drawer">
            <AgentForm
              providers={providers}
              initial={formMode === 'edit' ? editing : null}
              busy={busy}
              onSubmit={(params) =>
                formMode === 'edit'
                  ? onUpdate(params as AgentUpdateParams)
                  : onCreate(params as AgentCreateParams)
              }
              onCancel={closeForm}
            />
          </div>
        )}
      </div>
    </div>
  )
}
