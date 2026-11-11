import type {
  AgentProfile,
  Assignment,
  AssignmentCreateParams,
  Project,
  RuntimeProviderRecord,
  Team,
  TeamMember,
  Work,
  WorkCreateParams,
  Worktree,
} from '@agentra/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArtifactsPanel } from '../features/approvals/ArtifactsPanel'
import { api } from '../services/api'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'
import { ProviderBadge } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'
import { TaskChatPanel } from './TaskChatPanel'
import { TeamTaskChatPanel } from './TeamTaskChatPanel'
import { TeamTaskRunsPanel } from './TeamTaskRunsPanel'
import { WorkFilesPanel } from './WorkFilesPanel'

/**
 * 构建产物检查用的标记（U2 的补充）：Work 页是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const WORKS_PAGE_MARKER = 'agentra-product-works'

type Props = {
  works: Work[]
  projects: Project[]
  projectFilter: string | null
  onClearProjectFilter: () => void
  teams: Team[]
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  assignmentsByWork: Record<string, Assignment[]>
  worktreesByWork: Record<string, Worktree[]>
  busy: boolean
  createSignal?: number
  onCreate: (params: WorkCreateParams) => Promise<boolean>
  onLinkTeam: (workId: string, teamId: string) => Promise<void>
  onWorkAction: (action: 'activate' | 'pause' | 'resume' | 'complete', id: string) => Promise<void>
  onCreateAssignment: (params: AssignmentCreateParams) => Promise<boolean>
  onAssignmentAction: (
    action: 'pause' | 'resume' | 'complete',
    workId: string,
    id: string,
  ) => Promise<void>
  onRefreshAssignments: (workId: string) => Promise<void>
  onRefreshWorks?: () => Promise<void>
  onRefreshWorktrees: (workId: string) => Promise<void>
  onCreateWorktree: (workId: string, branchName: string) => Promise<boolean>
  onRemoveWorktree: (workId: string, id: string) => Promise<void>
}

type DetailTab = 'overview' | 'runs' | 'artifacts' | 'team' | 'settings'
type ViewMode = 'board' | 'list'

const WORK_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

const ISSUE_STATUS_LABEL: Record<string, string> = {
  triage: '待分诊',
  backlog: '待处理',
  in_progress: '处理中',
  review: '待验收',
  done: '已完成',
}

const BOARD_COLUMNS: {
  key: string
  label: string
  dot: string
  cls: string
  statuses: string[]
}[] = [
  { key: 'draft', label: '草稿', dot: 'gray', cls: '', statuses: ['draft'] },
  { key: 'active', label: '进行中', dot: 'blue', cls: 'running', statuses: ['active'] },
  { key: 'paused', label: '已暂停', dot: 'amber', cls: 'paused', statuses: ['paused'] },
  {
    key: 'done',
    label: '已完成',
    dot: '',
    cls: 'done',
    statuses: ['completed', 'cancelled', 'archived'],
  },
]

function shortText(value: string, max = 160): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function WorksPage({
  works,
  projects,
  projectFilter,
  onClearProjectFilter,
  teams,
  agents,
  providers,
  assignmentsByWork,
  worktreesByWork,
  busy,
  createSignal = 0,
  onCreate,
  onLinkTeam,
  onWorkAction,
  onCreateAssignment,
  onAssignmentAction,
  onRefreshAssignments,
  onRefreshWorks,
  onRefreshWorktrees,
  onCreateWorktree,
  onRemoveWorktree,
}: Props) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [projectId, setProjectId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [sidePanelOpen, setSidePanelOpen] = useState(true)
  const [acceptBusy, setAcceptBusy] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('board')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [linkTeamId, setLinkTeamId] = useState('')
  const [assignAgentId, setAssignAgentId] = useState('')
  const [assignRole, setAssignRole] = useState('engineer')
  const [branchName, setBranchName] = useState('')
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [linkTeamOpen, setLinkTeamOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const lastCreateSignal = useRef(createSignal)

  const selected = works.find((work) => work.id === selectedId) ?? null
  const assignments = selected ? (assignmentsByWork[selected.id] ?? []) : []
  const ownerTeam = selected?.ownerTeamId
    ? (teams.find((team) => team.id === selected.ownerTeamId) ?? null)
    : null
  const leaderAgent = ownerTeam?.leaderAgentId
    ? (agents.find((agent) => agent.id === ownerTeam.leaderAgentId) ?? null)
    : null
  const leaderHasAssignment = leaderAgent
    ? assignments.some((assignment) => assignment.agentId === leaderAgent.id)
    : false
  const worktrees = selected ? (worktreesByWork[selected.id] ?? []) : []
  const teamMemberAgents = (
    teamMembers.length > 0
      ? teamMembers.map((member) => agents.find((agent) => agent.id === member.agentId))
      : assignments.map((assignment) => agents.find((agent) => agent.id === assignment.agentId))
  ).filter((agent): agent is AgentProfile => agent !== undefined && agent.id !== leaderAgent?.id)

  useEffect(() => {
    const teamId = selected?.ownerTeamId
    if (!teamId) {
      setTeamMembers([])
      return
    }
    let alive = true
    void api
      .listTeamMembers(teamId)
      .then((members) => {
        if (alive) setTeamMembers(members)
      })
      .catch(() => {
        if (alive) setTeamMembers([])
      })
    return () => {
      alive = false
    }
  }, [selected?.ownerTeamId])

  useEffect(() => {
    if (createSignal !== lastCreateSignal.current) {
      lastCreateSignal.current = createSignal
      setCreateOpen(true)
      setSelectedId(null)
    }
  }, [createSignal])

  useEffect(() => {
    if (selectedId) {
      void onRefreshAssignments(selectedId)
      void onRefreshWorktrees(selectedId)
    }
  }, [selectedId, onRefreshAssignments, onRefreshWorktrees])

  // 看板卡片需要每个任务 的岗位数；只为尚未加载的 Work 拉取一次。
  useEffect(() => {
    for (const work of works) {
      if (!(work.id in assignmentsByWork)) void onRefreshAssignments(work.id)
    }
  }, [works, assignmentsByWork, onRefreshAssignments])

  useEffect(() => {
    if (linkTeamId === '' && teams.length > 0) setLinkTeamId(teams[0]?.id ?? '')
  }, [teams, linkTeamId])

  useEffect(() => {
    if (assignAgentId === '' && agents.length > 0) setAssignAgentId(agents[0]?.id ?? '')
  }, [agents, assignAgentId])

  useEffect(() => {
    if (projectFilter) setProjectId(projectFilter)
    else if (projectId === '' && projects.length > 0) setProjectId(projects[0]?.id ?? '')
  }, [projectFilter, projects, projectId])

  const submitWork = async (): Promise<void> => {
    if (name.trim() === '' || rootPath.trim() === '') return
    const ok = await onCreate({
      name,
      rootPath,
      projectId: projectId === '' ? undefined : projectId,
    })
    if (ok) {
      setName('')
      setRootPath('')
      setCreateOpen(false)
    }
  }

  const submitAssignment = async (): Promise<void> => {
    if (!selected || assignAgentId === '') return
    const ok = await onCreateAssignment({
      workId: selected.id,
      agentId: assignAgentId,
      teamId: linkTeamId === '' ? null : linkTeamId,
      workRole: assignRole,
    })
    if (ok) setAssignmentOpen(false)
  }

  const scopedWorks = useMemo(
    () => (projectFilter ? works.filter((work) => work.projectId === projectFilter) : works),
    [works, projectFilter],
  )

  const filteredWorks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return scopedWorks.filter((work) => {
      if (statusFilter !== 'all' && work.status !== statusFilter) return false
      if (query.length === 0) return true
      return (
        work.name.toLowerCase().includes(query) ||
        work.rootPath.toLowerCase().includes(query) ||
        work.description.toLowerCase().includes(query)
      )
    })
  }, [scopedWorks, search, statusFilter])

  const counts = useMemo(
    () => ({
      total: scopedWorks.length,
      active: scopedWorks.filter((work) => work.status === 'active').length,
      paused: scopedWorks.filter((work) => work.status === 'paused').length,
      completed: scopedWorks.filter((work) => work.status === 'completed').length,
    }),
    [scopedWorks],
  )

  const activeProject = projects.find((project) => project.id === projectFilter) ?? null

  const providerForAgent = (agentId: string): RuntimeProviderRecord | null => {
    const agent = agents.find((item) => item.id === agentId)
    return providers.find((provider) => provider.id === agent?.defaultProviderId) ?? null
  }

  const acceptTeamTask = async (): Promise<void> => {
    if (!selected || acceptBusy) return
    setAcceptBusy(true)
    setDetailError(null)
    try {
      await api.setTeamTaskStatus({
        workId: selected.id,
        status: 'done',
        decidedBy: 'local-user',
      })
      await api.workAction('complete', selected.id)
      await onRefreshWorks?.()
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setAcceptBusy(false)
    }
  }

  const openWork = (workId: string): void => {
    setSelectedId(workId)
    setDetailTab('overview')
    setSidePanelOpen(true)
    setDetailError(null)
  }

  const renderWorkCard = (work: Work) => {
    const ownerTeam = work.ownerTeamId
      ? (teams.find((team) => team.id === work.ownerTeamId) ?? null)
      : null
    const firstAssignment = (assignmentsByWork[work.id] ?? [])[0]
    const firstAgent = firstAssignment
      ? (agents.find((agent) => agent.id === firstAssignment.agentId) ?? null)
      : null
    const description = work.description || work.objective
    return (
      // biome-ignore lint/a11y/useSemanticElements: 整个任务卡需要点击打开详情，内部是块级布局，不适合 button。
      <div
        className="work-card work-card-button"
        key={work.id}
        role="button"
        tabIndex={0}
        aria-label={`打开任务 ${work.name}`}
        onClick={() => openWork(work.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openWork(work.id)
          }
        }}
      >
        <div className="work-card-top">
          <div className="work-card-title">{work.name}</div>
        </div>
        {description && <div className="work-card-desc">{shortText(description, 120)}</div>}
        <div className="work-card-meta">
          <span className="chip">
            {projects.find((project) => project.id === work.projectId)?.name ?? '未分组'}
          </span>
          {ownerTeam ? (
            <span>{ownerTeam.name}</span>
          ) : firstAgent ? (
            <span>{firstAgent.name}</span>
          ) : null}
        </div>
      </div>
    )
  }

  if (selected) {
    return (
      <div data-agentra-page={WORKS_PAGE_MARKER} className="page">
        <PageHeader
          crumb={
            <button type="button" className="crumb" onClick={() => setSelectedId(null)}>
              <Icon name="arrow-left" size={14} />
              任务
            </button>
          }
          title={selected.name}
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={sidePanelOpen ? '隐藏侧栏' : '显示侧栏'}
              title={sidePanelOpen ? '隐藏侧栏' : '显示侧栏'}
              onClick={() => setSidePanelOpen((open) => !open)}
            >
              <Icon name={sidePanelOpen ? 'panel' : 'panel-off'} size={14} />
            </button>
          }
        />

        <div className={`task-detail-layout ${sidePanelOpen ? '' : 'task-detail-layout-full'}`}>
          <div className="task-chat-main">
            {selected.collaborationMode === 'team' ? (
              <TeamTaskChatPanel
                workId={selected.id}
                agents={agents}
                teams={teams}
                onOpenRuns={() => {
                  setDetailTab('runs')
                  setSidePanelOpen(true)
                }}
                onRefreshWorks={() => {
                  void onRefreshAssignments(selected.id)
                  void onRefreshWorks?.()
                }}
              />
            ) : (
              <TaskChatPanel
                workId={selected.id}
                workName={selected.name}
                workDescription={selected.description || selected.objective}
                workStatus={selected.status}
                agents={agents}
                onActivate={() => void onWorkAction('activate', selected.id)}
                onResume={() => void onWorkAction('resume', selected.id)}
                onAssignmentsChanged={() => void onRefreshAssignments(selected.id)}
              />
            )}
          </div>
          {sidePanelOpen && (
            <aside className="task-side">
              <div className="tabs">
                <button
                  type="button"
                  className={`tab ${detailTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setDetailTab('overview')}
                >
                  概览
                </button>
                {selected.collaborationMode === 'team' && (
                  <button
                    type="button"
                    className={`tab ${detailTab === 'runs' ? 'active' : ''}`}
                    onClick={() => setDetailTab('runs')}
                  >
                    执行记录
                  </button>
                )}
                <button
                  type="button"
                  className={`tab ${detailTab === 'artifacts' ? 'active' : ''}`}
                  onClick={() => setDetailTab('artifacts')}
                >
                  交付物
                </button>
                <button
                  type="button"
                  className={`tab ${detailTab === 'team' ? 'active' : ''}`}
                  onClick={() => setDetailTab('team')}
                >
                  团队
                </button>
                <button
                  type="button"
                  className={`tab ${detailTab === 'settings' ? 'active' : ''}`}
                  onClick={() => setDetailTab('settings')}
                >
                  设置
                </button>
              </div>

              {detailTab === 'overview' && (
                <div className="stack">
                  {detailError && <div className="banner error">{detailError}</div>}
                  <div className="card">
                    <div className="card-head">
                      <div className="card-title">任务信息</div>
                      <div className="right">
                        {selected.status === 'active' && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void onWorkAction('pause', selected.id)}
                          >
                            暂停任务
                          </button>
                        )}
                        {selected.status === 'paused' && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy}
                            onClick={() => void onWorkAction('resume', selected.id)}
                          >
                            恢复任务
                          </button>
                        )}
                        {selected.status === 'draft' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy}
                            onClick={() => void onWorkAction('activate', selected.id)}
                          >
                            激活任务
                          </button>
                        )}
                        {selected.collaborationMode === 'team' &&
                          selected.issueStatus === 'review' && (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={acceptBusy}
                              onClick={() => void acceptTeamTask()}
                            >
                              {acceptBusy ? '提交中…' : '验收通过'}
                            </button>
                          )}
                      </div>
                    </div>
                    <div className="card-body">
                      <dl className="kv">
                        <dt>状态</dt>
                        <dd>
                          <StatusBadge
                            status={selected.status}
                            label={WORK_LABEL[selected.status] ?? selected.status}
                          />
                        </dd>
                        <dt>协作方式</dt>
                        <dd>{selected.collaborationMode === 'team' ? '团队线程' : 'Plan / DAG'}</dd>
                        <dt>任务状态</dt>
                        <dd>
                          {selected.collaborationMode === 'team'
                            ? (ISSUE_STATUS_LABEL[selected.issueStatus] ?? selected.issueStatus)
                            : '—'}
                        </dd>
                        <dt>项目</dt>
                        <dd>
                          {projects.find((project) => project.id === selected.projectId)?.name ??
                            '未分组'}
                        </dd>
                        <dt>根目录</dt>
                        <dd className="mono">{selected.rootPath}</dd>
                        <dt>创建时间</dt>
                        <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                        <dt>更新时间</dt>
                        <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
                        <dt>优先级</dt>
                        <dd>{selected.priority}</dd>
                      </dl>
                    </div>
                  </div>
                  <details className="card work-info-details">
                    <summary>
                      <span className="card-title">任务说明</span>
                      <span className="work-info-preview">
                        {selected.objective || selected.description || '暂无任务说明'}
                      </span>
                    </summary>
                    <div className="card-body stack">
                      {selected.objective && (
                        <div>
                          <div className="faint">目标</div>
                          <div className="work-description">{selected.objective}</div>
                        </div>
                      )}
                      {selected.description && selected.description !== selected.objective && (
                        <div>
                          <div className="faint">描述</div>
                          <div className="work-description">{selected.description}</div>
                        </div>
                      )}
                      {!selected.objective && !selected.description && (
                        <div className="empty-state">暂无任务说明。</div>
                      )}
                    </div>
                  </details>
                </div>
              )}

              {detailTab === 'runs' && selected.collaborationMode === 'team' && (
                <div className="stack">
                  <TeamTaskRunsPanel workId={selected.id} agents={agents} />
                </div>
              )}

              {detailTab === 'artifacts' && (
                <div className="stack">
                  {selected.collaborationMode === 'team' ? (
                    <WorkFilesPanel workId={selected.id} />
                  ) : (
                    <ArtifactsPanel workId={selected.id} />
                  )}
                </div>
              )}

              {detailTab === 'team' && (
                <div className="detail-layout">
                  <div className="stack">
                    <div className="card">
                      <div className="card-head">
                        <div className="card-title">
                          {selected.collaborationMode === 'team' ? '团队成员' : 'Assignment'}
                        </div>
                        {selected.collaborationMode !== 'team' && (
                          <div className="right">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setAssignmentOpen(true)}
                            >
                              <Icon name="plus" size={13} />
                              分配 Agent
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="card-body" style={{ display: 'grid', gap: 12 }}>
                        {selected.collaborationMode === 'team' ? (
                          <div className="team-assignment-list">
                            {leaderAgent ? (
                              <div className="team-assignment-row">
                                <div className="team-assignment-identity">
                                  <AgentAvatar avatar={leaderAgent.avatar} size={24} />
                                  <strong>{leaderAgent.name}</strong>
                                  <span className="chip">队长</span>
                                  <ProviderBadge provider={providerForAgent(leaderAgent.id)} />
                                  <span className="pill done plain">
                                    {leaderAgent.status === 'active' ? '启用' : '停用'}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="empty-state">该团队还没有设置队长。</div>
                            )}
                            {teamMemberAgents.map((agent) => (
                              <div className="team-assignment-row" key={agent.id}>
                                <div className="team-assignment-identity">
                                  <AgentAvatar avatar={agent.avatar} size={24} />
                                  <strong>{agent.name}</strong>
                                  <span className="chip">成员</span>
                                  <ProviderBadge provider={providerForAgent(agent.id)} />
                                  <span className="pill done plain">
                                    {agent.status === 'active' ? '启用' : '停用'}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : assignments.length === 0 && !leaderAgent ? (
                          <div className="empty-state">该任务还没有 Assignment。</div>
                        ) : (
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Agent</th>
                                <th>角色</th>
                                <th>Provider</th>
                                <th>状态</th>
                                <th className="right">操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {leaderAgent && !leaderHasAssignment && (
                                <tr key={`leader-${leaderAgent.id}`}>
                                  <td>
                                    <strong>{leaderAgent.name}</strong>
                                  </td>
                                  <td>队长</td>
                                  <td>
                                    <ProviderBadge provider={providerForAgent(leaderAgent.id)} />
                                  </td>
                                  <td>
                                    <span className="pill done plain">
                                      {leaderAgent.status === 'active' ? '启用' : '停用'}
                                    </span>
                                  </td>
                                  <td className="right">
                                    <span className="faint">—</span>
                                  </td>
                                </tr>
                              )}
                              {assignments.map((assignment) => {
                                const agent = agents.find((item) => item.id === assignment.agentId)
                                return (
                                  <tr key={assignment.id}>
                                    <td>
                                      <strong>{agent?.name ?? assignment.agentId}</strong>
                                    </td>
                                    <td>
                                      {assignment.workRole.startsWith('team-')
                                        ? '成员'
                                        : assignment.workRole}
                                    </td>
                                    <td>
                                      <ProviderBadge
                                        provider={providerForAgent(assignment.agentId)}
                                      />
                                    </td>
                                    <td>
                                      <StatusBadge status={assignment.status} />
                                    </td>
                                    <td className="right">
                                      <div className="row-actions">
                                        <button
                                          type="button"
                                          className="btn btn-ghost btn-sm"
                                          disabled={busy}
                                          onClick={() =>
                                            void onAssignmentAction(
                                              'pause',
                                              selected.id,
                                              assignment.id,
                                            )
                                          }
                                        >
                                          暂停
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-ghost btn-sm"
                                          disabled={busy}
                                          onClick={() =>
                                            void onAssignmentAction(
                                              'resume',
                                              selected.id,
                                              assignment.id,
                                            )
                                          }
                                        >
                                          恢复
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-ghost btn-sm"
                                          disabled={busy}
                                          onClick={() =>
                                            void onAssignmentAction(
                                              'complete',
                                              selected.id,
                                              assignment.id,
                                            )
                                          }
                                        >
                                          完成
                                        </button>
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

                  <div className="stack">
                    {selected.collaborationMode === 'team' ? (
                      <div className="card">
                        <div className="card-head">
                          <div className="card-title">所属团队</div>
                        </div>
                        <div className="card-body">
                          {ownerTeam ? (
                            <div style={{ fontSize: 12 }}>{ownerTeam.name}</div>
                          ) : (
                            <div className="faint" style={{ fontSize: 11.5 }}>
                              尚未设置所属团队。
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="card">
                        <div className="card-head">
                          <div className="card-title">关联团队</div>
                          <div className="right">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setLinkTeamOpen(true)}
                            >
                              <Icon name="plus" size={13} />
                              关联团队
                            </button>
                          </div>
                        </div>
                        <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                          <div style={{ height: 1, background: 'var(--border)' }} />
                          {selected.teamIds.length === 0 ? (
                            <div className="faint" style={{ fontSize: 11.5 }}>
                              尚未关联团队。
                            </div>
                          ) : (
                            selected.teamIds.map((teamId) => (
                              <div key={teamId} style={{ fontSize: 12 }}>
                                {teams.find((team) => team.id === teamId)?.name ?? teamId}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {detailTab === 'settings' && (
                <div className="detail-layout">
                  <div className="stack">
                    <div className="card">
                      <div className="card-head">
                        <div className="card-title">Git Worktree</div>
                        <div className="right">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setWorktreeOpen(true)}
                          >
                            <Icon name="plus" size={13} />
                            创建 Worktree
                          </button>
                        </div>
                      </div>
                      <div className="card-body" style={{ display: 'grid', gap: 12 }}>
                        {worktrees.length === 0 ? (
                          <div className="empty-state">该任务还没有 Worktree。</div>
                        ) : (
                          <div style={{ display: 'grid', gap: 8 }}>
                            {worktrees.map((worktree) => (
                              <div
                                key={worktree.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: '8px 10px',
                                  border: '1px solid var(--border)',
                                  borderRadius: 8,
                                  fontSize: 12,
                                }}
                              >
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <code className="mono">{worktree.branchName}</code>
                                  <div className="faint" style={{ fontSize: 10.5, marginTop: 2 }}>
                                    {worktree.worktreePath}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  disabled={busy}
                                  onClick={() => {
                                    if (pendingRemoveId === worktree.id) {
                                      setPendingRemoveId(null)
                                      void onRemoveWorktree(selected.id, worktree.id)
                                    } else {
                                      setPendingRemoveId(worktree.id)
                                    }
                                  }}
                                >
                                  {pendingRemoveId === worktree.id ? '确认清理' : '清理'}
                                </button>
                                {pendingRemoveId === worktree.id && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => setPendingRemoveId(null)}
                                  >
                                    取消
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="stack">
                    <div className="card">
                      <div className="card-head">
                        <div className="card-title">任务设置</div>
                      </div>
                      <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                        <dl className="kv">
                          <dt>任务 ID</dt>
                          <dd className="mono">{selected.id}</dd>
                          <dt>优先级</dt>
                          <dd>{selected.priority}</dd>
                          <dt>根目录</dt>
                          <dd className="mono">{selected.rootPath}</dd>
                        </dl>
                        <div className="faint" style={{ fontSize: 11 }}>
                          任务不提供删除或原地修改根目录；状态迁移通过页面头的操作按钮完成。
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>

        <Modal
          open={assignmentOpen}
          title="分配 Agent"
          onClose={() => setAssignmentOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setAssignmentOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || assignAgentId === ''}
                onClick={() => void submitAssignment()}
              >
                分配
              </button>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="field">
              <label htmlFor="assignment-agent">Agent</label>
              <select
                id="assignment-agent"
                className="select"
                value={assignAgentId}
                onChange={(event) => setAssignAgentId(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="assignment-role">任务角色</label>
              <input
                id="assignment-role"
                className="input"
                value={assignRole}
                onChange={(event) => setAssignRole(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="assignment-team">团队（可选）</label>
              <select
                id="assignment-team"
                className="select"
                value={linkTeamId}
                onChange={(event) => setLinkTeamId(event.target.value)}
              >
                <option value="">不关联</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Modal>

        <Modal
          open={linkTeamOpen}
          title="关联团队"
          onClose={() => setLinkTeamOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setLinkTeamOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || linkTeamId === ''}
                onClick={() => {
                  if (!selected || linkTeamId === '') return
                  void onLinkTeam(selected.id, linkTeamId).then(() => setLinkTeamOpen(false))
                }}
              >
                关联团队
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="link-team">团队</label>
            <select
              id="link-team"
              className="select"
              value={linkTeamId}
              onChange={(event) => setLinkTeamId(event.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
        </Modal>

        <Modal
          open={worktreeOpen}
          title="创建 Worktree"
          onClose={() => setWorktreeOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setWorktreeOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || branchName.trim() === ''}
                onClick={() => {
                  if (!selected || branchName.trim() === '') return
                  void onCreateWorktree(selected.id, branchName.trim()).then((ok) => {
                    if (ok) {
                      setBranchName('')
                      setWorktreeOpen(false)
                    }
                  })
                }}
              >
                创建 Worktree
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="worktree-branch">分支名 *</label>
            <input
              id="worktree-branch"
              className="input"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="agentra/w1"
            />
          </div>
        </Modal>
      </div>
    )
  }

  return (
    <div data-agentra-page={WORKS_PAGE_MARKER} className="page">
      <PageHeader
        title="任务"
        subtitle={`${activeProject ? `项目「${activeProject.name}」 · ` : ''}${counts.total} 个任务 · ${counts.active} 个进行中 · ${counts.paused} 个已暂停 · ${counts.completed} 个已完成`}
        actions={
          <>
            {activeProject && (
              <button type="button" className="btn btn-ghost" onClick={onClearProjectFilter}>
                全部任务
              </button>
            )}
            <label className="input input-search">
              <Icon name="search" size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索任务名称或目录"
              />
            </label>
            <select
              className="select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="按状态筛选"
            >
              <option value="all">全部状态</option>
              <option value="draft">草稿</option>
              <option value="active">进行中</option>
              <option value="paused">已暂停</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
              <option value="archived">已归档</option>
            </select>
            <div className="segmented">
              <button
                type="button"
                className={viewMode === 'board' ? 'on' : ''}
                onClick={() => setViewMode('board')}
              >
                <Icon name="grid-view" size={13} />
                看板
              </button>
              <button
                type="button"
                className={viewMode === 'list' ? 'on' : ''}
                onClick={() => setViewMode('list')}
              >
                <Icon name="list" size={13} />
                列表
              </button>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => setCreateOpen((value) => !value)}
            >
              <Icon name="plus" size={14} />
              新建任务
            </button>
          </>
        }
      />

      <Modal
        open={createOpen}
        title="新建任务"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || name.trim() === '' || rootPath.trim() === ''}
              onClick={() => void submitWork()}
            >
              创建任务
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="work-project">项目 *</label>
            <select
              id="work-project"
              className="select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="work-name">名称 *</label>
            <input
              id="work-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="work-root">工作目录 *</label>
            <input
              id="work-root"
              className="input"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="/tmp/agentra-work"
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              Agent 会在这个目录下工作；目录不存在会自动创建。
            </div>
          </div>
        </div>
      </Modal>

      {viewMode === 'board' ? (
        <div className="board">
          {BOARD_COLUMNS.map((column) => {
            const columnWorks = filteredWorks
              .filter((work) => column.statuses.includes(work.status))
              .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
            return (
              <div className={`board-col ${column.cls}`} key={column.key}>
                <div className="board-col-head">
                  <span className={`dot ${column.dot}`} />
                  {column.label}
                  <span className="board-col-count">{columnWorks.length}</span>
                </div>
                <div className="board-scroll">
                  {columnWorks.length === 0 ? (
                    <div className="empty-state" style={{ padding: '18px 8px', fontSize: 11.5 }}>
                      暂无任务
                    </div>
                  ) : (
                    columnWorks.map(renderWorkCard)
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card">
          {filteredWorks.length === 0 ? (
            <div className="empty-state">没有符合筛选条件的 Work。</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Work</th>
                  <th>团队 / 岗位</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorks.map((work) => {
                  const ownerTeam = work.ownerTeamId
                    ? (teams.find((team) => team.id === work.ownerTeamId) ?? null)
                    : null
                  const firstAssignment = (assignmentsByWork[work.id] ?? [])[0]
                  const firstAgent = firstAssignment
                    ? (agents.find((agent) => agent.id === firstAssignment.agentId) ?? null)
                    : null
                  return (
                    <tr
                      key={work.id}
                      className="work-row-click"
                      tabIndex={0}
                      onClick={() => openWork(work.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openWork(work.id)
                        }
                      }}
                    >
                      <td>
                        <strong>{work.name}</strong>
                      </td>
                      <td>{ownerTeam?.name ?? firstAgent?.name ?? '—'}</td>
                      <td>{new Date(work.updatedAt).toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
