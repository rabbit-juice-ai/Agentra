import type {
  AgentProfile,
  Assignment,
  AssignmentCreateParams,
  Project,
  RuntimeProviderRecord,
  Team,
  Work,
  WorkCreateParams,
  Worktree,
} from '@agentra/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArtifactsPanel } from '../features/approvals/ArtifactsPanel'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'
import { ProviderBadge } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'
import { TaskChatPanel } from './TaskChatPanel'

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
  onRefreshWorktrees: (workId: string) => Promise<void>
  onCreateWorktree: (workId: string, branchName: string) => Promise<boolean>
  onRemoveWorktree: (workId: string, id: string) => Promise<void>
}

type DetailTab = 'overview' | 'artifacts' | 'team' | 'settings'
type ViewMode = 'board' | 'list'

const WORK_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
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

function initials(name: string): string {
  return name.trim().slice(0, 1) || 'W'
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
  onRefreshWorktrees,
  onCreateWorktree,
  onRemoveWorktree,
}: Props) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [projectId, setProjectId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
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
  const lastCreateSignal = useRef(createSignal)

  const selected = works.find((work) => work.id === selectedId) ?? null
  const assignments = selected ? (assignmentsByWork[selected.id] ?? []) : []
  const worktrees = selected ? (worktreesByWork[selected.id] ?? []) : []

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

  const openWork = (workId: string): void => {
    setSelectedId(workId)
    setDetailTab('overview')
  }

  const renderWorkCard = (work: Work) => (
    <div className="work-card" key={work.id}>
      <div className="work-card-top">
        <div className="work-card-title">{work.name}</div>
        <StatusBadge status={work.status} label={WORK_LABEL[work.status] ?? work.status} />
      </div>
      <div className="work-card-desc">{work.description || work.objective || work.rootPath}</div>
      <div className="work-card-meta">
        <span className="avatar-stack">
          <span className="avatar">{initials(work.name)}</span>
        </span>
        <span className="chip">
          {projects.find((project) => project.id === work.projectId)?.name ?? '未分组'}
        </span>
        <span>{work.teamIds.length} 个团队</span>
        <span>·</span>
        <span>{(assignmentsByWork[work.id] ?? []).length} 个岗位</span>
      </div>
      <div className="work-card-foot">
        <span
          className="faint"
          style={{
            fontSize: 10.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {work.rootPath}
        </span>
        <span className="right">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => openWork(work.id)}
          >
            打开
          </button>
        </span>
      </div>
    </div>
  )

  const workActionButtons = (work: Work) => {
    if (work.status === 'draft') {
      return (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void onWorkAction('activate', work.id)}
        >
          <Icon name="play" size={14} />
          激活
        </button>
      )
    }
    if (work.status === 'active') {
      return (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onWorkAction('pause', work.id)}
          >
            <Icon name="pause" size={14} />
            暂停
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onWorkAction('complete', work.id)}
          >
            完成
          </button>
        </>
      )
    }
    if (work.status === 'paused') {
      return (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onWorkAction('resume', work.id)}
          >
            <Icon name="play" size={14} />
            恢复
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void onWorkAction('complete', work.id)}
          >
            完成
          </button>
        </>
      )
    }
    return null
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
          title={
            <>
              {selected.name}
              <StatusBadge
                status={selected.status}
                label={WORK_LABEL[selected.status] ?? selected.status}
              />
            </>
          }
          subtitle={`${projects.find((project) => project.id === selected.projectId)?.name ?? '未分组'} · ${selected.description || selected.objective || selected.rootPath}`}
          actions={
            <>
              {workActionButtons(selected)}
              <button type="button" className="btn btn-ghost" onClick={() => setSelectedId(null)}>
                返回任务
              </button>
            </>
          }
        />

        <div className="task-detail-layout">
          <div className="task-chat-main">
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
          </div>
          <aside className="task-side">
            <div className="tabs">
              <button
                type="button"
                className={`tab ${detailTab === 'overview' ? 'active' : ''}`}
                onClick={() => setDetailTab('overview')}
              >
                概览
              </button>
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
                <div className="card">
                  <div className="card-head">
                    <div className="card-title">任务信息</div>
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
              </div>
            )}

            {detailTab === 'artifacts' && (
              <div className="stack">
                <ArtifactsPanel workId={selected.id} />
              </div>
            )}

            {detailTab === 'team' && (
              <div className="detail-layout">
                <div className="stack">
                  <div className="card">
                    <div className="card-head">
                      <div className="card-title">Assignment</div>
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
                    </div>
                    <div className="card-body" style={{ display: 'grid', gap: 12 }}>
                      {assignments.length === 0 ? (
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
                            {assignments.map((assignment) => {
                              const agent = agents.find((item) => item.id === assignment.agentId)
                              return (
                                <tr key={assignment.id}>
                                  <td>
                                    <strong>{agent?.name ?? assignment.agentId}</strong>
                                  </td>
                                  <td>{assignment.workRole}</td>
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
                  <th>状态</th>
                  <th>根目录</th>
                  <th>Team</th>
                  <th>岗位</th>
                  <th>更新时间</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorks.map((work) => (
                  <tr key={work.id}>
                    <td>
                      <strong>{work.name}</strong>
                    </td>
                    <td>
                      <StatusBadge
                        status={work.status}
                        label={WORK_LABEL[work.status] ?? work.status}
                      />
                    </td>
                    <td className="mono">{work.rootPath}</td>
                    <td>{work.teamIds.length}</td>
                    <td>{(assignmentsByWork[work.id] ?? []).length}</td>
                    <td>{new Date(work.updatedAt).toLocaleString()}</td>
                    <td className="right">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => openWork(work.id)}
                      >
                        打开
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
