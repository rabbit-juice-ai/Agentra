import { useEffect, useState } from 'react'
import { AgentsPage } from './components/AgentsPage'
import { BackupsPage } from './components/BackupsPage'
import { ConsolePage } from './components/ConsolePage'
import { Icon, type IconName } from './components/Icon'
import { OverviewPage } from './components/OverviewPage'
import { PlanPage } from './components/PlanPage'
import { ProjectsPage } from './components/ProjectsPage'
import { providerMark, providerMarkClass } from './components/ProviderBadge'
import { SettingsPage } from './components/SettingsPage'
import { StatusBadge } from './components/StatusBadge'
import { TeamsPage } from './components/TeamsPage'
import { WorksPage } from './components/WorksPage'
import { ApprovalsPage } from './features/approvals/ApprovalsPage'
import { ArtifactsPanel } from './features/approvals/ArtifactsPanel'
import { useAgentra } from './hooks/useAgentra'
import { api } from './services/api'

type Tab =
  | 'console'
  | 'overview'
  | 'plan'
  | 'projects'
  | 'agents'
  | 'teams'
  | 'works'
  | 'approvals'
  | 'artifacts'
  | 'settings'
  | 'backups'

type NavItem = { tab: Tab; label: string; icon: IconName; hot?: boolean }

// 执行控制台是 dev-only（U2 隔离）：发布构建里 __AGENTRA_DEV_CONSOLE__ 被替换为 false，
// 这一项连同「执行控制台」字面量都不会进入发布产物（check-release-bundle 依赖这一点）。
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: '工作台',
    items: [
      { tab: 'overview', label: '总览', icon: 'grid' },
      { tab: 'plan', label: '规划', icon: 'zap' },
      { tab: 'projects', label: '项目', icon: 'archive' },
      { tab: 'works', label: '任务', icon: 'briefcase' },
    ],
  },
  {
    label: '协作',
    items: [
      { tab: 'approvals', label: '审批中心', icon: 'check', hot: true },
      { tab: 'artifacts', label: '交付物', icon: 'box' },
      { tab: 'agents', label: 'Agents', icon: 'users' },
      { tab: 'teams', label: '团队', icon: 'users' },
    ],
  },
  {
    label: '系统',
    items: [
      { tab: 'backups', label: '备份中心', icon: 'archive' },
      ...(__AGENTRA_DEV_CONSOLE__
        ? [{ tab: 'console' as Tab, label: '执行控制台', icon: 'zap' as IconName }]
        : []),
    ],
  },
]

/** Nav badge: real counts only; approvals use the pending inbox. */
function usePendingApprovalCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const approvals = await api.listPendingApprovals()
        if (alive) setCount(approvals.length)
      } catch {
        // 审批计数是装饰性信息；Core 未就绪时不打断主界面。
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return count
}

export function App() {
  const store = useAgentra()
  // 构建期常量（不是运行时判断）：发布构建默认落在总览；带控制台的构建才默认进控制台。
  const [tab, setTab] = useState<Tab>(__AGENTRA_DEV_CONSOLE__ ? 'console' : 'overview')
  const [createWorkSignal, setCreateWorkSignal] = useState(0)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [providersOpen, setProvidersOpen] = useState(false)
  const pendingApprovals = usePendingApprovalCount()

  useEffect(() => {
    if (!providersOpen) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target?.closest('.provider-popover') || target?.closest('.status-providers')) return
      setProvidersOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [providersOpen])

  const healthyProviders = store.providers.filter(
    (provider) => provider.healthStatus === 'healthy',
  ).length

  const runningExecutionByAgent: Record<string, string> = {}
  for (const execution of store.consoleState.executions) {
    if (execution.agentId && (execution.status === 'running' || execution.status === 'pending')) {
      runningExecutionByAgent[execution.agentId] = execution.id
    }
  }

  const badgeFor = (item: NavItem): number | null => {
    if (item.tab === 'approvals') return pendingApprovals > 0 ? pendingApprovals : null
    if (item.tab === 'projects') return store.projects.length > 0 ? store.projects.length : null
    if (item.tab === 'works') return store.works.length > 0 ? store.works.length : null
    if (item.tab === 'agents') return store.agents.length > 0 ? store.agents.length : null
    if (item.tab === 'teams') return store.teams.length > 0 ? store.teams.length : null
    return null
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          Agentra
        </div>

        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const badge = badgeFor(item)
              return (
                <button
                  type="button"
                  key={item.tab}
                  className={`nav-item ${tab === item.tab ? 'active' : ''}`}
                  onClick={() => setTab(item.tab)}
                >
                  <Icon name={item.icon} />
                  {item.label}
                  {badge !== null && (
                    <span className={`nav-count ${item.hot ? 'hot' : ''}`}>{badge}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <button
            type="button"
            className={`side-settings ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            <Icon name="settings" />
            设置
          </button>
        </div>
      </aside>

      <div className="main">
        <main className="main-content">
          {__AGENTRA_DEV_CONSOLE__ && tab === 'console' ? (
            <ConsolePage
              agents={store.agents}
              state={store.consoleState}
              busy={store.busy}
              onStart={store.actions.startExecution}
              onSelect={store.actions.selectExecution}
              onCancel={store.actions.cancelExecution}
              onInterrupt={store.actions.interruptExecution}
              onSendMessage={store.actions.sendMessage}
            />
          ) : tab === 'overview' ? (
            <OverviewPage
              works={store.works}
              agents={store.agents}
              providers={store.providers}
              coreHealth={store.coreHealth}
              daemonHealth={store.daemonHealth}
              onCreateWork={() => {
                setCreateWorkSignal((value) => value + 1)
                setTab('works')
              }}
              onNavigate={(target) => setTab(target)}
            />
          ) : tab === 'plan' ? (
            <PlanPage
              works={store.works}
              projects={store.projects}
              agents={store.agents}
              providers={store.providers}
              onWorksChanged={() => void store.actions.refreshWorks()}
              onProjectsChanged={() => void store.actions.refreshProjects()}
            />
          ) : tab === 'approvals' ? (
            <ApprovalsPage />
          ) : tab === 'artifacts' ? (
            <ArtifactsPanel works={store.works} />
          ) : tab === 'backups' ? (
            <BackupsPage />
          ) : tab === 'teams' ? (
            <TeamsPage
              teams={store.teams}
              agents={store.agents}
              providers={store.providers}
              membersByTeam={store.teamMembers}
              busy={store.busy}
              onCreate={store.actions.createTeam}
              onAddMember={store.actions.addTeamMember}
              onRefreshMembers={store.actions.refreshTeamMembers}
            />
          ) : tab === 'projects' ? (
            <ProjectsPage
              projects={store.projects}
              works={store.works}
              busy={store.busy}
              onCreateProject={store.actions.createProject}
              onUpdateProject={store.actions.updateProject}
              onOpenProjectTasks={(projectId) => {
                setProjectFilter(projectId)
                setTab('works')
              }}
            />
          ) : tab === 'works' ? (
            <WorksPage
              works={store.works}
              projects={store.projects}
              projectFilter={projectFilter}
              onClearProjectFilter={() => setProjectFilter(null)}
              teams={store.teams}
              agents={store.agents}
              providers={store.providers}
              assignmentsByWork={store.assignmentsByWork}
              worktreesByWork={store.worktreesByWork}
              busy={store.busy}
              createSignal={createWorkSignal}
              onCreate={store.actions.createWork}
              onLinkTeam={store.actions.linkWorkTeam}
              onWorkAction={store.actions.workAction}
              onCreateAssignment={store.actions.createAssignment}
              onAssignmentAction={store.actions.assignmentAction}
              onRefreshAssignments={store.actions.refreshAssignments}
              onRefreshWorktrees={store.actions.refreshWorktrees}
              onCreateWorktree={store.actions.createWorktree}
              onRemoveWorktree={store.actions.removeWorktree}
            />
          ) : tab === 'settings' ? (
            <SettingsPage
              coreHealth={store.coreHealth}
              daemonHealth={store.daemonHealth}
              providers={store.providers}
              worksCount={store.works.length}
              projectsCount={store.projects.length}
              agentsCount={store.agents.length}
              onRefreshProviders={store.actions.refreshProviderDiscovery}
              onOpenBackups={() => setTab('backups')}
            />
          ) : (
            <AgentsPage
              agents={store.agents}
              providers={store.providers}
              busy={store.busy}
              runningExecutionByAgent={runningExecutionByAgent}
              onCreate={store.actions.createAgent}
              onUpdate={store.actions.updateAgent}
              onArchive={store.actions.archiveAgent}
              onSetStatus={store.actions.setAgentStatus}
              onRefreshProviders={store.actions.refreshProviderDiscovery}
            />
          )}
        </main>

        <div className="statusbar">
          <span className="status-item">
            <span className={`dot ${store.coreHealth ? '' : 'red'}`} />
            Core {store.coreHealth ? '正常' : '断连'}
          </span>
          <span className="status-item">
            <span className={`dot ${store.daemonHealth ? '' : 'red'}`} />
            Daemon {store.daemonHealth ? '正常' : '断连'}
          </span>
          <span className="provider-anchor">
            <button
              type="button"
              className={`status-item status-providers ${providersOpen ? 'active' : ''}`}
              title="查看已发现的 Provider"
              onClick={() => setProvidersOpen((value) => !value)}
            >
              <span className={`dot ${healthyProviders > 0 ? 'blue' : 'red'}`} />
              {healthyProviders}/{store.providers.length} Provider 健康
            </button>
            {providersOpen && (
              <div className="provider-popover" role="dialog" aria-label="Providers">
                <div className="provider-popover-head">
                  <strong>Providers</strong>
                  <span className="faint" style={{ fontSize: 10.5 }}>
                    {healthyProviders}/{store.providers.length} 健康
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    title={store.busy ? '刷新中…' : '刷新'}
                    disabled={store.busy}
                    onClick={() => void store.actions.refreshProviderDiscovery()}
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                </div>
                <button
                  type="button"
                  className="provider-popover-close"
                  onClick={() => setProvidersOpen(false)}
                  aria-label="关闭"
                >
                  ×
                </button>
                {store.providers.length === 0 ? (
                  <div className="empty-state" style={{ padding: '12px 0' }}>
                    尚未发现 Provider
                  </div>
                ) : (
                  <div className="provider-popover-list">
                    {store.providers.map((provider) => (
                      <div className="provider-popover-row" key={provider.id}>
                        <span
                          className={`provider-mark ${providerMarkClass(provider.providerName)}`}
                        >
                          {providerMark(provider.providerName)}
                        </span>
                        <span className="provider-popover-name">{provider.providerName}</span>
                        <StatusBadge status={provider.healthStatus} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </span>
          <span className="right">
            <span>协议 {store.coreHealth?.protocolVersion ?? '—'}</span>
            <span>本地数据</span>
          </span>
        </div>
      </div>

      {store.banner && (
        <div className="toast-stack" aria-live="polite">
          <div className={`toast ${store.banner.tone}`} role="status">
            <span className="toast-message">{store.banner.message}</span>
            {store.banner.sticky && (
              <button
                type="button"
                className="toast-close"
                onClick={store.dismissBanner}
                aria-label="关闭"
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
