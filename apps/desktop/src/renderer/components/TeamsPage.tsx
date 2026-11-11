import {
  AGENT_ACCESS_MODE_LABEL,
  type AgentProfile,
  type RuntimeProviderRecord,
  type Team,
  type TeamCreateParams,
  type TeamMember,
  type TeamMemberAddParams,
  type TeamUpdateParams,
  type Work,
} from '@agentra/protocol'
import { useEffect, useMemo, useState } from 'react'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'
import { ProviderBadge } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'

/**
 * 构建产物检查用的标记（U2 的补充）：Team 页是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const TEAMS_PAGE_MARKER = 'agentra-product-teams'

const WORK_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

function workTone(status: string): string {
  if (status === 'active' || status === 'completed') return 'done'
  if (status === 'paused' || status === 'draft') return 'warn'
  return 'pending'
}

type Tab = 'members' | 'instructions' | 'works'

type Props = {
  teams: Team[]
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  works: Work[]
  membersByTeam: Record<string, TeamMember[]>
  busy: boolean
  onCreate: (params: TeamCreateParams) => Promise<boolean>
  onUpdate: (params: TeamUpdateParams) => Promise<boolean>
  onArchive: (id: string) => Promise<void>
  onAddMember: (params: TeamMemberAddParams) => Promise<boolean>
  onRemoveMember: (teamId: string, agentId: string) => Promise<void>
  onRefreshMembers: (teamId: string) => Promise<void>
  onOpenTasks: () => void
}

/**
 * 团队页：左侧团队列表，右侧团队详情。
 * 详情按 Multica 小队页组织为 成员 / 指引 / 近期任务。
 */
export function TeamsPage({
  teams,
  agents,
  providers,
  works,
  membersByTeam,
  busy,
  onCreate,
  onUpdate,
  onArchive,
  onAddMember,
  onRemoveMember,
  onRefreshMembers,
  onOpenTasks,
}: Props) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [memberOpen, setMemberOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('members')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [memberAgentId, setMemberAgentId] = useState('')
  const [leaderOpen, setLeaderOpen] = useState(false)
  const [leaderAgentId, setLeaderAgentId] = useState('')
  const [leaderSaving, setLeaderSaving] = useState(false)
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [instructionsEditing, setInstructionsEditing] = useState(false)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const selected = teams.find((team) => team.id === selectedId) ?? null
  const members = selected ? (membersByTeam[selected.id] ?? []) : []
  const selectedLeader = selected?.leaderAgentId
    ? (agents.find((agent) => agent.id === selected.leaderAgentId) ?? null)
    : null
  const leaderCandidates = members
    .map((member) => agents.find((agent) => agent.id === member.agentId))
    .filter(
      (agent): agent is AgentProfile =>
        agent !== undefined && agent.status === 'active' && agent.accessMode === 'analyze',
    )
  const savedInstructions = selected?.instructions ?? ''
  const instructionsDirty = instructionsDraft !== savedInstructions
  const linkedWorks = useMemo(() => {
    if (!selected) return []
    return works
      .filter((work) => work.teamIds.includes(selected.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [works, selected])

  useEffect(() => {
    if (teams.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId === null || !teams.some((team) => team.id === selectedId)) {
      setSelectedId(teams[0]?.id ?? null)
    }
  }, [teams, selectedId])

  useEffect(() => {
    if (selectedId) void onRefreshMembers(selectedId)
  }, [selectedId, onRefreshMembers])

  // 列表需要成员数；只为尚未加载的 Team 拉取一次。
  useEffect(() => {
    for (const team of teams) {
      if (!(team.id in membersByTeam)) void onRefreshMembers(team.id)
    }
  }, [teams, membersByTeam, onRefreshMembers])

  useEffect(() => {
    if (memberAgentId === '' && agents.length > 0) setMemberAgentId(agents[0]?.id ?? '')
  }, [agents, memberAgentId])

  useEffect(() => {
    if (selectedId === null) return
    setInstructionsEditing(false)
    setInstructionsError(null)
    setLeaderOpen(false)
  }, [selectedId])

  useEffect(() => {
    if (!instructionsEditing) setInstructionsDraft(selected?.instructions ?? '')
  }, [selected?.instructions, instructionsEditing])

  const submitTeam = async (): Promise<void> => {
    if (name.trim() === '') return
    const ok = await onCreate({
      name: name.trim(),
      description: description.trim() || undefined,
    })
    if (ok) {
      setName('')
      setDescription('')
      setCreateOpen(false)
    }
  }

  const openEdit = (): void => {
    if (!selected) return
    setEditName(selected.name)
    setEditDescription(selected.description)
    setEditOpen(true)
  }

  const submitEdit = async (): Promise<void> => {
    if (!selected || editName.trim() === '') return
    const ok = await onUpdate({
      id: selected.id,
      name: editName.trim(),
      description: editDescription.trim(),
    })
    if (ok) setEditOpen(false)
  }

  const openLeader = (): void => {
    if (!selected) return
    setLeaderAgentId(selected.leaderAgentId ?? '')
    setLeaderOpen(true)
  }

  const submitLeader = async (): Promise<void> => {
    if (!selected || leaderSaving) return
    setLeaderSaving(true)
    const ok = await onUpdate({
      id: selected.id,
      leaderAgentId: leaderAgentId === '' ? null : leaderAgentId,
    })
    setLeaderSaving(false)
    if (ok) {
      await onRefreshMembers(selected.id)
      setLeaderOpen(false)
    }
  }

  const saveInstructions = async (): Promise<void> => {
    if (!selected || instructionsSaving) return
    setInstructionsSaving(true)
    setInstructionsError(null)
    const ok = await onUpdate({ id: selected.id, instructions: instructionsDraft })
    setInstructionsSaving(false)
    if (ok) {
      setInstructionsEditing(false)
    } else {
      setInstructionsError('保存失败，请重试')
    }
  }

  const submitMember = async (): Promise<void> => {
    if (!selected || memberAgentId === '') return
    const ok = await onAddMember({ teamId: selected.id, agentId: memberAgentId })
    if (ok) setMemberOpen(false)
  }

  const archiveSelected = async (): Promise<void> => {
    if (!selected) return
    const archivedId = selected.id
    await onArchive(archivedId)
    setArchiveOpen(false)
    setSelectedId((current) => (current === archivedId ? null : current))
  }

  return (
    <div data-agentra-page={TEAMS_PAGE_MARKER} className="page">
      <PageHeader
        title="团队"
        subtitle={`${teams.length} 个团队 · 指引会注入成员执行关联任务时的工作指令`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={busy}
          >
            <Icon name="plus" size={14} />
            新建团队
          </button>
        }
      />

      <div className="team-layout">
        <aside className="team-list">
          <div className="team-list-head">
            <span>小队</span>
            <span className="count">{teams.length}</span>
          </div>
          {teams.length === 0 ? (
            <div className="card">
              <div className="empty-state">还没有团队。点击“新建团队”创建第一个。</div>
            </div>
          ) : (
            teams.map((team) => {
              const isSelected = team.id === selectedId
              const leader = team.leaderAgentId
                ? (agents.find((agent) => agent.id === team.leaderAgentId) ?? null)
                : null
              return (
                <button
                  type="button"
                  key={team.id}
                  className={`team-list-item ${isSelected ? 'on' : ''}`}
                  onClick={() => setSelectedId(team.id)}
                >
                  <span className="team-icon">
                    <Icon name="users" size={18} />
                  </span>
                  <span className="team-list-main">
                    <span className="team-list-name">{team.name}</span>
                    <span className="team-list-meta">
                      {leader ? `队长 ${leader.name}` : '未设置队长'}
                    </span>
                    {team.description && <span className="team-list-desc">{team.description}</span>}
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              )
            })
          )}
        </aside>

        <section className="team-detail">
          {selected ? (
            <div className="card team-detail-card">
              <div className="team-detail-head">
                <span className="team-detail-icon">
                  <Icon name="users" size={22} />
                </span>
                <div className="team-detail-copy">
                  <div className="team-detail-title">
                    {selected.name}
                    <StatusBadge status={selected.status} />
                  </div>
                  <div className="team-detail-desc">{selected.description || '暂无描述'}</div>
                </div>
                <div className="team-detail-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={openLeader}>
                    <Icon name="users" size={13} />
                    {selectedLeader ? '更换队长' : '设置队长'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={openEdit}>
                    <Icon name="settings" size={13} />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    onClick={() => setArchiveOpen(true)}
                    disabled={busy}
                  >
                    归档
                  </button>
                </div>
              </div>

              <div className="team-detail-meta">
                <span>
                  <strong>{selectedLeader?.name ?? '未设置'}</strong> 队长
                </span>
                <span>
                  <strong>{members.length}</strong> 名成员
                </span>
                <span>
                  <strong>{linkedWorks.length}</strong> 个关联任务
                </span>
                <span>创建于 {new Date(selected.createdAt).toLocaleDateString()}</span>
              </div>

              <div className="tabs">
                <button
                  type="button"
                  className={`tab ${tab === 'members' ? 'active' : ''}`}
                  onClick={() => setTab('members')}
                >
                  成员
                  <span className="count">{members.length}</span>
                </button>
                <button
                  type="button"
                  className={`tab ${tab === 'instructions' ? 'active' : ''}`}
                  onClick={() => setTab('instructions')}
                >
                  指引
                </button>
                <button
                  type="button"
                  className={`tab ${tab === 'works' ? 'active' : ''}`}
                  onClick={() => setTab('works')}
                >
                  近期任务
                  <span className="count">{linkedWorks.length}</span>
                </button>
              </div>

              {tab === 'members' && (
                <div className="team-tab-panel">
                  <div className="team-panel-head">
                    <div>
                      <div className="team-panel-title">成员</div>
                      <div className="team-panel-desc">共 {members.length} 名成员</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setMemberOpen(true)}
                      disabled={busy || agents.length === 0}
                    >
                      <Icon name="plus" size={13} />
                      添加成员
                    </button>
                  </div>
                  {members.length === 0 ? (
                    <div className="empty-state">
                      还没有成员。添加 Agent 后，团队指引会作用于他们执行关联任务时。
                    </div>
                  ) : (
                    <div className="team-member-list">
                      {members.map((member) => {
                        const agent = agents.find((item) => item.id === member.agentId)
                        const provider =
                          providers.find((item) => item.id === agent?.defaultProviderId) ?? null
                        return (
                          <div className="team-member-row" key={member.id}>
                            {agent ? (
                              <AgentAvatar avatar={agent.avatar} size={28} />
                            ) : (
                              <span className="avatar">?</span>
                            )}
                            <div className="team-member-copy">
                              <div className="team-member-name">
                                {agent?.name ?? member.agentId}
                                {selected.leaderAgentId === member.agentId && (
                                  <span className="pill accent">队长</span>
                                )}
                              </div>
                              <div className="team-member-sub">
                                {agent
                                  ? `${AGENT_ACCESS_MODE_LABEL[agent.accessMode]} · ${
                                      agent.description || '未填写擅长的工作'
                                    }`
                                  : '未知 Agent'}
                              </div>
                            </div>
                            <ProviderBadge provider={provider} />
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm danger"
                              onClick={() => void onRemoveMember(selected.id, member.agentId)}
                              disabled={busy || selected.leaderAgentId === member.agentId}
                              title={
                                selected.leaderAgentId === member.agentId
                                  ? '请先更换队长再移除'
                                  : undefined
                              }
                            >
                              移除
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === 'instructions' && (
                <div className="team-tab-panel">
                  <div className="team-panel-head">
                    <div>
                      <div className="team-panel-title">指引</div>
                      <div className="team-panel-desc">
                        成员执行关联到该团队的任务时，会读取这些指引。它只提供共享上下文，不授予权限，也不会替代
                        Agent 自己的工作指令。
                      </div>
                    </div>
                    {!instructionsEditing && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setInstructionsEditing(true)}
                        disabled={busy}
                      >
                        <Icon name="settings" size={13} />
                        编辑
                      </button>
                    )}
                  </div>

                  {instructionsEditing ? (
                    <div className="team-instructions-editor">
                      <textarea
                        className="textarea"
                        rows={8}
                        value={instructionsDraft}
                        onChange={(event) => setInstructionsDraft(event.target.value)}
                        placeholder="例如：前端改动必须先跑现有测试；涉及数据库的改动先给出迁移方案；跨端接口先对齐契约。"
                      />
                      <div className="team-instructions-actions">
                        {instructionsError && (
                          <span style={{ color: 'var(--danger)', fontSize: 11 }}>
                            {instructionsError}
                          </span>
                        )}
                        {instructionsDirty && !instructionsError && (
                          <span className="faint" style={{ fontSize: 11 }}>
                            有未保存的修改
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setInstructionsDraft(savedInstructions)
                            setInstructionsEditing(false)
                            setInstructionsError(null)
                          }}
                          disabled={instructionsSaving}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void saveInstructions()}
                          disabled={!instructionsDirty || instructionsSaving}
                        >
                          <Icon name="check" size={13} />
                          {instructionsSaving ? '保存中…' : '保存'}
                        </button>
                      </div>
                    </div>
                  ) : savedInstructions.trim().length > 0 ? (
                    <div className="team-instructions-view">{savedInstructions}</div>
                  ) : (
                    <div className="empty-state">
                      还没有指引。写清路由规则、协作方式或需要全队遵循的背景。
                    </div>
                  )}
                </div>
              )}

              {tab === 'works' && (
                <div className="team-tab-panel">
                  <div className="team-panel-head">
                    <div>
                      <div className="team-panel-title">近期任务</div>
                      <div className="team-panel-desc">关联到该团队的任务</div>
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenTasks}>
                      查看全部任务
                    </button>
                  </div>
                  {linkedWorks.length === 0 ? (
                    <div className="empty-state">
                      还没有关联任务。在任务详情的「团队」里关联该团队后，这里会显示。
                    </div>
                  ) : (
                    <div className="team-work-list">
                      {linkedWorks.slice(0, 8).map((work) => (
                        <div className="team-work-row" key={work.id}>
                          <div className="team-work-copy">
                            <div className="team-work-name">{work.name}</div>
                            <div className="team-work-meta">
                              更新于 {new Date(work.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <span className={`pill ${workTone(work.status)}`}>
                            {WORK_LABEL[work.status] ?? work.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="empty-state">选择左侧团队查看详情。</div>
            </div>
          )}
        </section>
      </div>

      <Modal
        open={createOpen}
        title="新建团队"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || name.trim() === ''}
              onClick={() => void submitTeam()}
            >
              创建团队
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="team-name">名称 *</label>
            <input
              id="team-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="team-description">描述</label>
            <input
              id="team-description"
              className="input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={selected ? `编辑团队 · ${selected.name}` : '编辑团队'}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || editName.trim() === ''}
              onClick={() => void submitEdit()}
            >
              保存
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="team-edit-name">名称 *</label>
            <input
              id="team-edit-name"
              className="input"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="team-edit-description">描述</label>
            <input
              id="team-edit-description"
              className="input"
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={leaderOpen}
        title={selected ? `设置队长 · ${selected.name}` : '设置队长'}
        onClose={() => setLeaderOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setLeaderOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={leaderSaving}
              onClick={() => void submitLeader()}
            >
              {leaderSaving ? '保存中…' : '保存队长'}
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="team-leader-agent">队长</label>
            <select
              id="team-leader-agent"
              className="select"
              value={leaderAgentId}
              onChange={(event) => setLeaderAgentId(event.target.value)}
            >
              <option value="">不设置队长</option>
              {leaderCandidates.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              队长必须是团队中工作权限为「只读分析」的 active 成员。设置后会自动加入团队。
              队长只负责派工，不执行任务，也不会被分配团队任务。
            </div>
          </div>
          {leaderCandidates.length === 0 && (
            <div className="banner warn" style={{ margin: 0 }}>
              当前团队没有可担任队长的只读分析成员。请先添加一个 analyze 权限的 Agent。
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={memberOpen}
        title={selected ? `添加成员 · ${selected.name}` : '添加成员'}
        onClose={() => setMemberOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setMemberOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || memberAgentId === ''}
              onClick={() => void submitMember()}
            >
              加入团队
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="team-member-agent">Agent</label>
          <select
            id="team-member-agent"
            className="select"
            value={memberAgentId}
            onChange={(event) => setMemberAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {AGENT_ACCESS_MODE_LABEL[agent.accessMode]}
              </option>
            ))}
          </select>
        </div>
      </Modal>

      <Modal
        open={archiveOpen}
        title={selected ? `归档团队 · ${selected.name}` : '归档团队'}
        onClose={() => setArchiveOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setArchiveOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void archiveSelected()}
            >
              归档
            </button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7 }}>
          归档后团队会从列表和团队选择器中消失；历史任务与执行记录保留。此操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
