import type {
  AgentProfile,
  Team,
  TeamCreateParams,
  TeamMember,
  TeamMemberAddParams,
} from '@agentra/protocol'
import { useEffect, useState } from 'react'
import { StatusBadge } from './StatusBadge'
import {
  buttonStyle,
  colors,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

/**
 * 构建产物检查用的标记（U2 的补充）：Team 页是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const TEAMS_PAGE_MARKER = 'agentra-product-teams'

type Props = {
  teams: Team[]
  agents: AgentProfile[]
  membersByTeam: Record<string, TeamMember[]>
  busy: boolean
  onCreate: (params: TeamCreateParams) => Promise<boolean>
  onAddMember: (params: TeamMemberAddParams) => Promise<boolean>
  onRefreshMembers: (teamId: string) => Promise<void>
}

export function TeamsPage({
  teams,
  agents,
  membersByTeam,
  busy,
  onCreate,
  onAddMember,
  onRefreshMembers,
}: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
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

  useEffect(() => {
    if (memberAgentId === '' && agents.length > 0) setMemberAgentId(agents[0]?.id ?? '')
  }, [agents, memberAgentId])

  const submitTeam = async (): Promise<void> => {
    if (name.trim() === '') return
    const ok = await onCreate({ name, description })
    if (ok) {
      setName('')
      setDescription('')
    }
  }

  const submitMember = async (): Promise<void> => {
    if (!selected || memberAgentId === '') return
    await onAddMember({ teamId: selected.id, agentId: memberAgentId, teamRole: memberRole })
  }

  return (
    <div data-agentra-page={TEAMS_PAGE_MARKER} style={{ display: 'grid', gap: 16 }}>
      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>新建 Team</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 2fr auto',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <label>
            <span style={labelStyle}>名称 *</span>
            <input
              style={inputStyle}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span style={labelStyle}>描述</span>
            <input
              style={inputStyle}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || name.trim() === ''}
            onClick={() => void submitTeam()}
          >
            创建
          </button>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16 }}>
        <section style={panelStyle}>
          <h2 style={sectionTitleStyle}>Teams</h2>
          {teams.length === 0 ? (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>还没有 Team。</p>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => setSelectedId(team.id)}
                  style={{
                    textAlign: 'left',
                    border: `1px solid ${team.id === selectedId ? colors.blue : colors.border}`,
                    background: team.id === selectedId ? '#ddf4ff' : '#ffffff',
                    borderRadius: 6,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong>{team.name}</strong>
                    <span style={{ marginLeft: 'auto' }}>
                      <StatusBadge status={team.status} />
                    </span>
                  </div>
                  <div style={{ color: colors.muted, marginTop: 4 }}>
                    {(membersByTeam[team.id] ?? []).length} 名成员
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section style={{ ...panelStyle, display: 'grid', gap: 12 }}>
          <h2 style={{ ...sectionTitleStyle, margin: 0 }}>
            {selected ? `成员 · ${selected.name}` : '成员'}
          </h2>
          {selected ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 160px auto',
                  gap: 10,
                  alignItems: 'end',
                }}
              >
                <label>
                  <span style={labelStyle}>Agent</span>
                  <select
                    style={inputStyle}
                    value={memberAgentId}
                    onChange={(event) => setMemberAgentId(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} · {agent.role}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span style={labelStyle}>Team 角色</span>
                  <input
                    style={inputStyle}
                    value={memberRole}
                    onChange={(event) => setMemberRole(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy || memberAgentId === ''}
                  onClick={() => void submitMember()}
                >
                  加入
                </button>
              </div>
              {members.length === 0 ? (
                <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>该 Team 还没有成员。</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {members.map((member) => {
                    const agent = agents.find((item) => item.id === member.agentId)
                    return (
                      <li key={member.id}>
                        {agent?.name ?? member.agentId} · {member.teamRole}
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          ) : (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>选择左侧 Team 查看成员。</p>
          )}
        </section>
      </div>
    </div>
  )
}
