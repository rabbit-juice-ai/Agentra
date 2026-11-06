import type {
  AgentProfile,
  Approval,
  HealthResult,
  RuntimeProviderRecord,
  Work,
} from '@agentra/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../services/api'
import { approvalTypeLabel } from './approval-label'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { providerMark, providerMarkClass } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'

type NavigateTarget = 'works' | 'approvals' | 'agents' | 'backups'

type Props = {
  works: Work[]
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  coreHealth: HealthResult | null
  daemonHealth: HealthResult | null
  onCreateWork: () => void
  onNavigate: (tab: NavigateTarget) => void
}

function waitingDuration(requestedAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(requestedAt))
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

const WORK_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  draft: '草稿',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

const RUNNING = new Set(['active'])

export function OverviewPage({
  works,
  agents,
  providers,
  coreHealth,
  daemonHealth,
  onCreateWork,
  onNavigate,
}: Props) {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const loadApprovals = useCallback(async () => {
    try {
      setApprovals(await api.listPendingApprovals())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void loadApprovals()
    const poll = setInterval(() => void loadApprovals(), 5000)
    const clock = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [loadApprovals])

  const activeWorks = useMemo(() => works.filter((work) => RUNNING.has(work.status)), [works])
  const pausedWorks = useMemo(() => works.filter((work) => work.status === 'paused'), [works])
  const recentWorks = useMemo(
    () =>
      [...works]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 5),
    [works],
  )
  const healthyProviders = providers.filter((provider) => provider.healthStatus === 'healthy')
  const sortedApprovals = useMemo(
    () =>
      [...approvals].sort(
        (left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt),
      ),
    [approvals],
  )
  const activeAgents = agents.filter((agent) => agent.status === 'active')

  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date())

  return (
    <div className="page">
      <PageHeader
        title="总览"
        subtitle={
          <>
            {dateLabel} · {sortedApprovals.length} 项等你审批 ·{' '}
            {coreHealth && daemonHealth ? 'Core 与 Daemon 正常' : '连接状态异常'}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title="刷新"
              onClick={() => void loadApprovals()}
            >
              <Icon name="refresh" />
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => onNavigate('works')}>
              查看全部运行
            </button>
            <button type="button" className="btn btn-primary" onClick={onCreateWork}>
              <Icon name="plus" size={14} />
              新建任务
            </button>
          </>
        }
      />

      {error && <div className="banner error">{error}</div>}

      <div className="stat-strip">
        <div className="stat">
          <div className="stat-label">等我审批</div>
          <div className="stat-value accent">{sortedApprovals.length}</div>
          <div className="stat-foot">
            {sortedApprovals[0]
              ? `最久等待 ${waitingDuration(sortedApprovals[0].requestedAt, nowMs)}`
              : '没有等待中的审批'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">进行中</div>
          <div className="stat-value">{activeWorks.length}</div>
          <div className="stat-foot">{pausedWorks.length} 个任务已暂停</div>
        </div>
        <div className="stat">
          <div className="stat-label">Agents</div>
          <div className="stat-value">{agents.length}</div>
          <div className="stat-foot">{activeAgents.length} 个启用中</div>
        </div>
        <div className="stat">
          <div className="stat-label">Providers</div>
          <div className="stat-value">{healthyProviders.length}</div>
          <div className="stat-foot">共发现 {providers.length} 个</div>
        </div>
        <div className="stat">
          <div className="stat-label">任务总数</div>
          <div className="stat-value">{works.length}</div>
          <div className="stat-foot">
            {works.filter((work) => work.status === 'completed').length} 个已完成
          </div>
        </div>
      </div>

      <div className="overview-grid">
        <div className="card">
          <div className="card-head">
            <div className="card-title">
              需要我处理
              {sortedApprovals.length > 0 && (
                <span className="pill accent plain">{sortedApprovals.length}</span>
              )}
            </div>
            <div className="right">
              <button type="button" className="link" onClick={() => onNavigate('approvals')}>
                全部审批
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
          </div>
          {sortedApprovals.length === 0 ? (
            <div className="empty-state">当前没有等待中的审批。</div>
          ) : (
            sortedApprovals.slice(0, 4).map((approval) => (
              <div className="task-row" key={approval.id}>
                <div className="task-icon">
                  <Icon name="check" />
                </div>
                <div className="task-main">
                  <div className="task-name">
                    {approvalTypeLabel(approval.approvalType)}
                    <span className="pill warn">等你回复</span>
                  </div>
                  <div className="task-meta">
                    <span>执行</span>
                    <span className="mono">{approval.workflowRunId}</span>
                    <span>·</span>
                    <span>第 {approval.round} 轮</span>
                  </div>
                </div>
                <div className="task-age">{waitingDuration(approval.requestedAt, nowMs)}</div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigate('approvals')}
                >
                  去处理
                </button>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">
              正在运行
              {activeWorks.length > 0 && (
                <span className="pill running plain">{activeWorks.length}</span>
              )}
            </div>
            <div className="right">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title="刷新"
                onClick={() => void loadApprovals()}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          {activeWorks.length === 0 ? (
            <div className="empty-state">没有进行中的任务。</div>
          ) : (
            activeWorks.slice(0, 4).map((work) => (
              <div className="run-row" key={work.id}>
                <span className="dot blue" style={{ marginTop: 6 }} />
                <div className="run-main">
                  <div className="run-name">
                    {work.name}
                    <StatusBadge status={work.status} label="执行中" />
                  </div>
                  <div className="run-meta">
                    {work.teamIds.length} 个团队 · 根目录 {work.rootPath}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onNavigate('works')}
                >
                  查看
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="overview-grid" style={{ gridTemplateColumns: '1.9fr 1fr' }}>
        <div className="card">
          <div className="card-head">
            <div className="card-title">最近更新</div>
            <div className="right">
              <button type="button" className="link" onClick={() => onNavigate('works')}>
                全部
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>团队</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {recentWorks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="faint">
                    还没有任务。
                  </td>
                </tr>
              ) : (
                recentWorks.map((work) => (
                  <tr key={work.id}>
                    <td>
                      <strong>{work.name}</strong>
                    </td>
                    <td>
                      <StatusBadge
                        status={work.status}
                        label={WORK_LABELS[work.status] ?? work.status}
                      />
                    </td>
                    <td>{work.teamIds.length}</td>
                    <td>{new Date(work.updatedAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">运行环境</div>
            <div className="right">
              <button type="button" className="link" onClick={() => onNavigate('agents')}>
                管理
              </button>
            </div>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 8 }}>
            {providers.length === 0 ? (
              <div className="faint" style={{ fontSize: 11.5 }}>
                尚未发现 Provider。
              </div>
            ) : (
              providers.map((provider) => (
                <div
                  key={provider.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                >
                  <span className={`provider-mark ${providerMarkClass(provider.providerName)}`}>
                    {providerMark(provider.providerName)}
                  </span>
                  <strong style={{ fontWeight: 600 }}>{provider.providerName}</strong>
                  <span className="faint" style={{ fontSize: 10.5 }}>
                    {provider.version ?? '未知版本'}
                  </span>
                  <StatusBadge status={provider.healthStatus} />
                </div>
              ))
            )}
            <div style={{ height: 1, background: 'var(--border)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
              <span className={`dot ${coreHealth ? '' : 'red'}`} />
              Core
              <span className="faint" style={{ marginLeft: 'auto' }}>
                {coreHealth ? `pid ${coreHealth.pid}` : '断连'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
              <span className={`dot ${daemonHealth ? '' : 'red'}`} />
              Daemon
              <span className="faint" style={{ marginLeft: 'auto' }}>
                {daemonHealth ? `pid ${daemonHealth.pid}` : '断连'}
              </span>
            </div>
            <div style={{ height: 1, background: 'var(--border)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
              <Icon name="archive" size={14} />
              备份中心
              <button
                type="button"
                className="link"
                style={{ marginLeft: 'auto' }}
                onClick={() => onNavigate('backups')}
              >
                打开
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
