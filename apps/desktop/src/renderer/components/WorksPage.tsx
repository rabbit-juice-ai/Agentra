import type {
  AgentProfile,
  Assignment,
  AssignmentCreateParams,
  Team,
  Work,
  WorkCreateParams,
  Worktree,
} from '@agentra/protocol'
import { useEffect, useState } from 'react'
import { StatusBadge } from './StatusBadge'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

/**
 * 构建产物检查用的标记（U2 的补充）：Work 页是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const WORKS_PAGE_MARKER = 'agentra-product-works'

type Props = {
  works: Work[]
  teams: Team[]
  agents: AgentProfile[]
  assignmentsByWork: Record<string, Assignment[]>
  worktreesByWork: Record<string, Worktree[]>
  busy: boolean
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

export function WorksPage({
  works,
  teams,
  agents,
  assignmentsByWork,
  worktreesByWork,
  busy,
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [linkTeamId, setLinkTeamId] = useState('')
  const [assignAgentId, setAssignAgentId] = useState('')
  const [assignRole, setAssignRole] = useState('engineer')
  const [branchName, setBranchName] = useState('')
  /** 两步确认：第一下只进入待确认态，第二下才真正清理（不默认执行）。 */
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)

  const selected = works.find((work) => work.id === selectedId) ?? null
  const assignments = selected ? (assignmentsByWork[selected.id] ?? []) : []
  const worktrees = selected ? (worktreesByWork[selected.id] ?? []) : []

  useEffect(() => {
    if (selectedId === null && works.length > 0) setSelectedId(works[0]?.id ?? null)
  }, [works, selectedId])

  useEffect(() => {
    if (selectedId) {
      void onRefreshAssignments(selectedId)
      void onRefreshWorktrees(selectedId)
    }
  }, [selectedId, onRefreshAssignments, onRefreshWorktrees])

  useEffect(() => {
    if (linkTeamId === '' && teams.length > 0) setLinkTeamId(teams[0]?.id ?? '')
  }, [teams, linkTeamId])

  useEffect(() => {
    if (assignAgentId === '' && agents.length > 0) setAssignAgentId(agents[0]?.id ?? '')
  }, [agents, assignAgentId])

  const submitWork = async (): Promise<void> => {
    if (name.trim() === '' || rootPath.trim() === '') return
    const ok = await onCreate({ name, rootPath })
    if (ok) {
      setName('')
      setRootPath('')
    }
  }

  const submitAssignment = async (): Promise<void> => {
    if (!selected || assignAgentId === '') return
    await onCreateAssignment({
      workId: selected.id,
      agentId: assignAgentId,
      teamId: linkTeamId === '' ? null : linkTeamId,
      workRole: assignRole,
    })
  }

  return (
    <div data-agentra-page={WORKS_PAGE_MARKER} style={{ display: 'grid', gap: 16 }}>
      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>新建 Work</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr auto',
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
            <span style={labelStyle}>工作目录 *</span>
            <input
              style={inputStyle}
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="/tmp/agentra-work"
            />
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || name.trim() === '' || rootPath.trim() === ''}
            onClick={() => void submitWork()}
          >
            创建
          </button>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16 }}>
        <section style={panelStyle}>
          <h2 style={sectionTitleStyle}>Works</h2>
          {works.length === 0 ? (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>还没有 Work。</p>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {works.map((work) => (
                <button
                  key={work.id}
                  type="button"
                  onClick={() => setSelectedId(work.id)}
                  style={{
                    textAlign: 'left',
                    border: `1px solid ${work.id === selectedId ? colors.blue : colors.border}`,
                    background: work.id === selectedId ? '#ddf4ff' : '#ffffff',
                    borderRadius: 6,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong>{work.name}</strong>
                    <span style={{ marginLeft: 'auto' }}>
                      <StatusBadge status={work.status} />
                    </span>
                  </div>
                  <div style={{ color: colors.muted, marginTop: 4 }}>
                    Team {work.teamIds.length} · 岗位 {(assignmentsByWork[work.id] ?? []).length}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section style={{ ...panelStyle, display: 'grid', gap: 12 }}>
          <h2 style={{ ...sectionTitleStyle, margin: 0 }}>
            {selected ? `Work 详情 · ${selected.name}` : 'Work 详情'}
          </h2>
          {selected ? (
            <>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 1fr',
                  gap: '4px 10px',
                  fontSize: 12,
                  margin: 0,
                  color: colors.muted,
                }}
              >
                <dt>状态</dt>
                <dd style={{ margin: 0 }}>
                  <StatusBadge status={selected.status} />
                </dd>
                <dt>工作目录</dt>
                <dd style={{ margin: 0 }}>
                  <code>{selected.rootPath}</code>
                </dd>
                <dt>关联 Team</dt>
                <dd style={{ margin: 0 }}>
                  {selected.teamIds.length === 0
                    ? '未关联'
                    : selected.teamIds
                        .map((id) => teams.find((team) => team.id === id)?.name ?? id)
                        .join('、')}
                </dd>
              </dl>

              <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                <label>
                  <span style={labelStyle}>关联 Team</span>
                  <select
                    style={inputStyle}
                    value={linkTeamId}
                    onChange={(event) => setLinkTeamId(event.target.value)}
                  >
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy || linkTeamId === ''}
                  onClick={() => void onLinkTeam(selected.id, linkTeamId)}
                >
                  关联
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void onWorkAction('activate', selected.id)}
                >
                  激活
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void onWorkAction('pause', selected.id)}
                >
                  暂停
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void onWorkAction('resume', selected.id)}
                >
                  恢复
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void onWorkAction('complete', selected.id)}
                >
                  完成
                </button>
              </div>

              <div style={{ borderTop: `1px solid ${colors.subtle}`, paddingTop: 12 }}>
                <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Assignment</h3>
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
                      value={assignAgentId}
                      onChange={(event) => setAssignAgentId(event.target.value)}
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span style={labelStyle}>Work 角色</span>
                    <input
                      style={inputStyle}
                      value={assignRole}
                      onChange={(event) => setAssignRole(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy || assignAgentId === ''}
                    onClick={() => void submitAssignment()}
                  >
                    分配
                  </button>
                </div>
                {assignments.length === 0 ? (
                  <p style={{ fontSize: 13, color: colors.muted, margin: '8px 0 0' }}>
                    该 Work 还没有 Assignment。
                  </p>
                ) : (
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: 12,
                      marginTop: 8,
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: 'left', color: colors.muted }}>
                        <th style={{ padding: '4px' }}>Agent</th>
                        <th style={{ padding: '4px' }}>角色</th>
                        <th style={{ padding: '4px' }}>状态</th>
                        <th style={{ padding: '4px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map((assignment) => (
                        <tr key={assignment.id} style={{ borderTop: `1px solid ${colors.subtle}` }}>
                          <td style={{ padding: '4px' }}>
                            {agents.find((agent) => agent.id === assignment.agentId)?.name ??
                              assignment.agentId}
                          </td>
                          <td style={{ padding: '4px' }}>{assignment.workRole}</td>
                          <td style={{ padding: '4px' }}>
                            <StatusBadge status={assignment.status} />
                          </td>
                          <td style={{ padding: '4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              style={{ ...buttonStyle, marginRight: 4 }}
                              disabled={busy}
                              onClick={() =>
                                void onAssignmentAction('pause', selected.id, assignment.id)
                              }
                            >
                              暂停
                            </button>
                            <button
                              type="button"
                              style={{ ...buttonStyle, marginRight: 4 }}
                              disabled={busy}
                              onClick={() =>
                                void onAssignmentAction('resume', selected.id, assignment.id)
                              }
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              style={buttonStyle}
                              disabled={busy}
                              onClick={() =>
                                void onAssignmentAction('complete', selected.id, assignment.id)
                              }
                            >
                              完成
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{ borderTop: `1px solid ${colors.subtle}`, paddingTop: 12 }}>
                <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Git Worktree</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                  <label style={{ flex: 1 }}>
                    <span style={labelStyle}>分支名 *</span>
                    <input
                      style={inputStyle}
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="agentra/w1"
                    />
                  </label>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy || branchName.trim() === ''}
                    onClick={() => {
                      if (!selected) return
                      void onCreateWorktree(selected.id, branchName.trim()).then((ok) => {
                        if (ok) setBranchName('')
                      })
                    }}
                  >
                    创建 Worktree
                  </button>
                </div>
                {worktrees.length === 0 ? (
                  <p style={{ fontSize: 13, color: colors.muted, margin: '8px 0 0' }}>
                    该 Work 还没有 Worktree。
                  </p>
                ) : (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                    {worktrees.map((worktree) => (
                      <li key={worktree.id} style={{ marginBottom: 4 }}>
                        <code>{worktree.branchName}</code> · <code>{worktree.worktreePath}</code>
                        <button
                          type="button"
                          style={{ ...dangerButtonStyle, marginLeft: 8 }}
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
                          {pendingRemoveId === worktree.id ? '确认清理（不可撤销）' : '清理'}
                        </button>
                        {pendingRemoveId === worktree.id && (
                          <button
                            type="button"
                            style={{ ...buttonStyle, marginLeft: 4 }}
                            disabled={busy}
                            onClick={() => setPendingRemoveId(null)}
                          >
                            取消
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>选择左侧 Work 查看详情。</p>
          )}
        </section>
      </div>
    </div>
  )
}
