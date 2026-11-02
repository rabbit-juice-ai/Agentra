import type { HealthResult } from '@agentra/protocol'
import { lazy, Suspense, useState } from 'react'
import { AgentsPage } from './components/AgentsPage'
import { ConsolePage } from './components/ConsolePage'
import { buttonStyle, colors } from './components/styles'
import { TeamsPage } from './components/TeamsPage'
import { WorksPage } from './components/WorksPage'
import { ApprovalsPage } from './features/approvals/ApprovalsPage'
import { ArtifactsPanel } from './features/approvals/ArtifactsPanel'
import { useAgentra } from './hooks/useAgentra'

type Tab = 'console' | 'agents' | 'teams' | 'works' | 'workflow' | 'approvals' | 'artifacts'

// 画布必须独立成 chunk：WorkflowPage 走 React.lazy + 动态 import()。
const WorkflowPage = lazy(() => import('./features/workflow/WorkflowPage'))

function HealthDot({ label, health }: { label: string; health: HealthResult | null }) {
  const ok = health !== null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: ok ? colors.green : colors.red,
          display: 'inline-block',
        }}
      />
      <span style={{ color: colors.muted }}>
        {label} {ok ? `pid ${health.pid}` : '断连'}
      </span>
    </span>
  )
}

// 导航项：执行控制台是 dev-only（U2 隔离），发布构建的 NAV_ITEMS 里没有它——
// 「执行控制台」这个文案字面量也就不出现在发布产物里（check-release-bundle 依赖这一点）。
const NAV_ITEMS: { tab: Tab; label: string }[] = [
  ...(__AGENTRA_DEV_CONSOLE__ ? [{ tab: 'console' as Tab, label: '执行控制台' }] : []),
  { tab: 'agents', label: 'Agents' },
  { tab: 'teams', label: 'Teams' },
  { tab: 'works', label: 'Works' },
  { tab: 'workflow', label: 'Workflow' },
  { tab: 'approvals', label: '审批中心' },
  { tab: 'artifacts', label: '交付物' },
]

function SideNavItem({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...buttonStyle,
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderRadius: 6,
        background: active ? colors.blue : 'transparent',
        color: active ? '#fff' : colors.muted,
        fontWeight: active ? 600 : 400,
        padding: '8px 12px',
      }}
    >
      {children}
    </button>
  )
}

export function App() {
  const store = useAgentra()
  // 构建期常量（不是运行时判断）：发布构建里 __AGENTRA_DEV_CONSOLE__ 被替换为 false，
  // 默认落在 Agents 页；带控制台的构建才默认进控制台。
  const [tab, setTab] = useState<Tab>(__AGENTRA_DEV_CONSOLE__ ? 'console' : 'agents')

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: colors.bg,
        color: colors.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* 左侧固定纵向主导航（Antumi 风格应用外壳） */}
      <aside
        style={{
          width: 180,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '16px 10px',
          background: colors.panel,
          borderRight: `1px solid ${colors.border}`,
          position: 'sticky',
          top: 0,
          height: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <strong style={{ fontSize: 15, padding: '0 12px 12px' }}>Agentra</strong>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV_ITEMS.map(({ tab: item, label }) => (
            <SideNavItem key={item} active={tab === item} onClick={() => setTab(item)}>
              {label}
            </SideNavItem>
          ))}
        </nav>
      </aside>

      {/* 右侧主内容工作区 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 右上方状态区 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '10px 20px',
            background: colors.panel,
            borderBottom: `1px solid ${colors.border}`,
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
            <HealthDot label="Core" health={store.coreHealth} />
            <HealthDot label="Daemon" health={store.daemonHealth} />
          </div>
        </div>

        {store.banner && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              margin: '12px 20px 0',
              padding: '8px 12px',
              borderRadius: 6,
              border: `1px solid ${colors.amber}`,
              background: '#fff8c5',
              fontSize: 13,
              color: colors.text,
            }}
          >
            <span style={{ flex: 1 }}>{store.banner}</span>
            <button type="button" style={buttonStyle} onClick={store.dismissBanner}>
              关闭
            </button>
          </div>
        )}

        <main style={{ padding: 20 }}>
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
          ) : tab === 'workflow' ? (
            <Suspense fallback={<div style={{ fontSize: 13, color: colors.muted }}>加载画布…</div>}>
              <WorkflowPage />
            </Suspense>
          ) : tab === 'approvals' ? (
            <ApprovalsPage />
          ) : tab === 'artifacts' ? (
            <ArtifactsPanel />
          ) : tab === 'teams' ? (
            <TeamsPage
              teams={store.teams}
              agents={store.agents}
              membersByTeam={store.teamMembers}
              busy={store.busy}
              onCreate={store.actions.createTeam}
              onAddMember={store.actions.addTeamMember}
              onRefreshMembers={store.actions.refreshTeamMembers}
            />
          ) : tab === 'works' ? (
            <WorksPage
              works={store.works}
              teams={store.teams}
              agents={store.agents}
              assignmentsByWork={store.assignmentsByWork}
              worktreesByWork={store.worktreesByWork}
              busy={store.busy}
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
          ) : (
            <AgentsPage
              agents={store.agents}
              providers={store.providers}
              busy={store.busy}
              onCreate={store.actions.createAgent}
              onUpdate={store.actions.updateAgent}
              onArchive={store.actions.archiveAgent}
              onSetStatus={store.actions.setAgentStatus}
              onRefreshProviders={store.actions.refreshProviderDiscovery}
            />
          )}
        </main>
      </div>
    </div>
  )
}
