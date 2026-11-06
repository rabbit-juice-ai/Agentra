import type {
  AgentProfile,
  RuntimeProviderRecord,
  Team,
  TeamCreateParams,
  TeamMember,
  TeamMemberAddParams,
} from '@agentra/protocol'
import { useEffect, useState } from 'react'
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

type Props = {
  teams: Team[]
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  membersByTeam: Record<string, TeamMember[]>
  busy: boolean
  onCreate: (params: TeamCreateParams) => Promise<boolean>
  onAddMember: (params: TeamMemberAddParams) => Promise<boolean>
  onRefreshMembers: (teamId: string) => Promise<void>
}

export function TeamsPage({
  teams,
  agents,
  providers,
  membersByTeam,
  busy,
  onCreate,
  onAddMember,
  onRefreshMembers,
}: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [memberOpen, setMemberOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [memberAgentId, setMemberAgentId] = useState('')
  const [memberRole, setMemberRole] = useState('member')

  const selected = teams.find((team) => team.id === selectedId) ?? null
  const members = selected ? (membersByTeam[selected.id] ?? []) : []

  useEffect(() => {
    if (selectedId === null && teams.length > 0) setSelectedId(teams[0]?.id ?? null)
  }, [teams, selectedId])

  useEffect(() => {
    if (selectedId) void onRefreshMembers(selectedId)
  }, [selectedId, onRefreshMembers])

  // 团队卡需要成员数；只为尚未加载的 Team 拉取一次。
  useEffect(() => {
    for (const team of teams) {
      if (!(team.id in membersByTeam)) void onRefreshMembers(team.id)
    }
  }, [teams, membersByTeam, onRefreshMembers])

  useEffect(() => {
    if (memberAgentId === '' && agents.length > 0) setMemberAgentId(agents[0]?.id ?? '')
  }, [agents, memberAgentId])

  const submitTeam = async (): Promise<void> => {
    if (name.trim() === '') return
    const ok = await onCreate({ name, description })
    if (ok) {
      setName('')
      setDescription('')
      setCreateOpen(false)
    }
  }

  const submitMember = async (): Promise<void> => {
    if (!selected || memberAgentId === '') return
    const ok = await onAddMember({
      teamId: selected.id,
      agentId: memberAgentId,
      teamRole: memberRole,
    })
    if (ok) setMemberOpen(false)
  }

  return (
    <div data-agentra-page={TEAMS_PAGE_MARKER} className="page">
      <PageHeader
        title="团队"
        subtitle={`${teams.length} 个团队 · ${agents.length} 个 Agent · 团队可混合 Provider`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen((value) => !value)}
            disabled={busy}
          >
            <Icon name="plus" size={14} />
            新建团队
          </button>
        }
      />

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

      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'start' }}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          {teams.length === 0 ? (
            <div className="card">
              <div className="empty-state">还没有团队。点击“新建团队”创建第一个。</div>
            </div>
          ) : (
            teams.map((team) => {
              const isSelected = team.id === selectedId
              return (
                <button
                  type="button"
                  key={team.id}
                  className="card team-card"
                  onClick={() => setSelectedId(team.id)}
                  style={{
                    textAlign: 'left',
                    borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                    background: 'var(--surface)',
                  }}
                >
                  <span className="team-icon">
                    <Icon name="users" size={20} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="team-name">{team.name}</div>
                      <StatusBadge status={team.status} />
                      {isSelected && <span className="pill accent">当前</span>}
                    </div>
                    <div className="team-meta">{team.description || '暂无描述'}</div>
                    <div className="team-meta">{(membersByTeam[team.id] ?? []).length} 名成员</div>
                  </div>
                  <Icon name="chevron-right" />
                </button>
              )
            })
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">{selected ? `成员 · ${selected.name}` : '成员'}</div>
            <div className="right">
              {selected && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMemberOpen(true)}
                >
                  <Icon name="plus" size={13} />
                  添加成员
                </button>
              )}
              <span className="faint" style={{ fontSize: 10.5 }}>
                {members.length} 名
              </span>
            </div>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 12 }}>
            {selected ? (
              members.length === 0 ? (
                <div className="empty-state" style={{ padding: '16px 0' }}>
                  该团队还没有成员。
                </div>
              ) : (
                members.map((member) => {
                  const agent = agents.find((item) => item.id === member.agentId)
                  const provider =
                    providers.find((item) => item.id === agent?.defaultProviderId) ?? null
                  return (
                    <div key={member.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="avatar">{agent?.name.trim().slice(0, 1) ?? '?'}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 550 }}>
                          {agent?.name ?? member.agentId}
                        </div>
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          {agent?.role ?? '未知角色'}
                        </div>
                      </div>
                      <ProviderBadge provider={provider} />
                      <span className="chip" style={{ marginLeft: 'auto' }}>
                        {member.teamRole}
                      </span>
                    </div>
                  )
                })
              )
            ) : (
              <div className="empty-state">选择左侧团队查看成员。</div>
            )}
          </div>
        </div>
      </div>

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
        <div style={{ display: 'grid', gap: 12 }}>
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
                  {agent.name} · {agent.role}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="team-member-role">团队角色</label>
            <input
              id="team-member-role"
              className="input"
              value={memberRole}
              onChange={(event) => setMemberRole(event.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
