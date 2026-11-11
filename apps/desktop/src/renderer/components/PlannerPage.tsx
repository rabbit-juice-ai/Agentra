import type { AgentProfile, PlannerMessage, Team } from '@agentra/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import { readableContent } from '../utils/readable-content'
import { useUserProfile } from '../utils/user-profile'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'

type PlannerActionView = {
  type?: string
  title?: string
  goal?: string
  description?: string
  acceptanceCriteria?: string[]
  rootPath?: string
  teamId?: string
  name?: string
  instructions?: string
  leaderAgentId?: string | null
  memberAgentIds?: string[]
  leader?: { name?: string; accessMode?: string }
  members?: { name?: string; accessMode?: string }[]
}

function actionView(message: PlannerMessage): PlannerActionView | null {
  return message.action as PlannerActionView | null
}

/**
 * Planner 聊天室：老板与独立 Planner Agent 的唯一对话入口。
 * 队长升级、任务卡确认、团队创建都回到这里；不另建收件箱。
 */
export function PlannerPage({
  teams,
  agents,
  onOpenTasks,
  onRefreshTeams,
  onRefreshTeamMembers,
}: {
  teams: Team[]
  agents: AgentProfile[]
  onOpenTasks?: () => void
  onRefreshTeams?: () => Promise<void>
  onRefreshTeamMembers?: (teamId: string) => Promise<void>
}) {
  const [messages, setMessages] = useState<PlannerMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [rootPaths, setRootPaths] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { profile: userProfile } = useUserProfile()
  const plannerAgent = agents.find((agent) => agent.systemKind === 'planner') ?? null

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await api.getPlannerChat()
      setMessages(result.messages)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => {
      void api
        .getPlannerChat()
        .then((result) => setMessages(result.messages))
        .catch(() => undefined)
    }, 4000)
    return () => clearInterval(timer)
  }, [reload])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages or thinking state change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, busy])

  const send = async (): Promise<void> => {
    if (busy || draft.trim() === '') return
    setBusy(true)
    setError(null)
    const content = draft.trim()
    setDraft('')
    try {
      await api.sendPlannerChat({ content })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const applyAction = async (messageId: string): Promise<void> => {
    if (actionBusy) return
    setActionBusy(messageId)
    setError(null)
    try {
      const result = await api.applyPlannerAction({
        messageId,
        ...(rootPaths[messageId]?.trim() ? { rootPath: rootPaths[messageId].trim() } : {}),
      })
      await reload()
      await onRefreshTeams?.()
      if (result.teamId) await onRefreshTeamMembers?.(result.teamId)
      if (result.workId) onOpenTasks?.()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(null)
    }
  }

  const rejectAction = async (messageId: string): Promise<void> => {
    if (actionBusy) return
    setActionBusy(messageId)
    setError(null)
    try {
      await api.rejectPlannerAction({ messageId })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(null)
    }
  }

  const teamName = (id: string | undefined): string =>
    teams.find((team) => team.id === id)?.name ?? id ?? '团队'
  const agentName = (id: string | null | undefined): string =>
    agents.find((agent) => agent.id === id)?.name ?? id ?? '未指定'

  return (
    <div className="page planner-page">
      <PageHeader
        title="Planner"
        subtitle="和 Planner 讨论目标、组装团队；确认后把任务发给队长，所有升级和拍板都回到这里。"
        actions={
          <span className="pill accent plain">
            {teams.length} 个团队 · {agents.filter((agent) => agent.status === 'active').length} 个
            Agent
          </span>
        }
      />

      {error && <div className="banner error">{error}</div>}

      <div className="card planner-chat-card">
        <div className="card-head">
          <div className="card-title">
            Planner 聊天室
            <span className="pill pending plain">唯一决策入口</span>
          </div>
          <div className="right faint" style={{ fontSize: 11 }}>
            讨论 → 任务卡 → 发给团队 → 队长处理
          </div>
        </div>
        <div className="card-body planner-chat-body">
          <div className="planner-messages">
            {messages.length === 0 && !busy && (
              <div className="empty-state">
                先告诉 Planner
                你想完成什么。比如“我想做一个备份恢复功能，需要前端和后端，先做一个最小闭环”。
              </div>
            )}
            {messages.map((message) => {
              const action = actionView(message)
              const isUser = message.authorType === 'user'
              const isSystem = message.authorType === 'system'
              return (
                <div
                  key={message.id}
                  className={`planner-message-row ${
                    isUser ? 'user' : isSystem ? 'system' : 'planner'
                  }`}
                >
                  {!isUser && !isSystem && (
                    <AgentAvatar
                      avatar={plannerAgent?.avatar ?? '🧭'}
                      size={28}
                      title={plannerAgent?.name ?? 'Planner'}
                    />
                  )}
                  <div className="planner-message-column">
                    <div className="planner-message-meta">
                      <span className="planner-message-author">
                        {isUser
                          ? userProfile.name
                          : isSystem
                            ? '系统'
                            : (plannerAgent?.name ?? 'Planner')}
                      </span>
                      <span className="planner-message-time">
                        {new Date(message.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div
                      className={`planner-message ${
                        isUser ? 'user' : isSystem ? 'system' : 'planner'
                      }`}
                    >
                      <div className="planner-message-content">
                        {readableContent(message.content)}
                      </div>
                      {action && (
                        <div className="planner-action-card">
                          <div className="planner-action-title">
                            {action.type === 'create_team_task' ? '团队任务卡' : '新团队'}
                            {message.actionStatus && (
                              <span
                                className={`pill ${
                                  message.actionStatus === 'applied'
                                    ? 'done'
                                    : message.actionStatus === 'rejected'
                                      ? 'danger'
                                      : 'warn'
                                }`}
                              >
                                {message.actionStatus === 'applied'
                                  ? '已执行'
                                  : message.actionStatus === 'rejected'
                                    ? '已取消'
                                    : '待确认'}
                              </span>
                            )}
                          </div>
                          {action.type === 'create_team_task' ? (
                            <div className="planner-action-body">
                              <div>
                                <strong>{action.title}</strong> · {teamName(action.teamId)}
                              </div>
                              <div className="faint">{action.goal}</div>
                              {action.acceptanceCriteria &&
                                action.acceptanceCriteria.length > 0 && (
                                  <div className="faint">
                                    验收：{action.acceptanceCriteria.join('；')}
                                  </div>
                                )}
                              {message.actionStatus === 'proposed' && (
                                <div className="field" style={{ marginTop: 4 }}>
                                  <label htmlFor={`planner-root-${message.id}`}>工作目录</label>
                                  <input
                                    id={`planner-root-${message.id}`}
                                    className="input"
                                    value={rootPaths[message.id] ?? action.rootPath ?? ''}
                                    onChange={(event) =>
                                      setRootPaths((current) => ({
                                        ...current,
                                        [message.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="绝对路径；留空使用临时目录"
                                  />
                                </div>
                              )}
                              {action.rootPath && message.actionStatus !== 'proposed' && (
                                <div className="faint mono" style={{ fontSize: 10.5 }}>
                                  工作目录：{action.rootPath}
                                </div>
                              )}
                            </div>
                          ) : action.type === 'create_team_with_agents' ? (
                            <div className="planner-action-body">
                              <div>
                                <strong>{action.name}</strong>
                              </div>
                              <div className="faint">
                                队长：{action.leader?.name ?? '未指定'} · 成员：
                                {(action.members ?? [])
                                  .map((member) => member.name ?? '未命名')
                                  .join('、') || '无'}
                              </div>
                              {action.instructions && (
                                <div className="faint">指引：{action.instructions}</div>
                              )}
                            </div>
                          ) : (
                            <div className="planner-action-body">
                              <div>
                                <strong>{action.name}</strong>
                              </div>
                              <div className="faint">
                                队长：{agentName(action.leaderAgentId)} · 成员：
                                {(action.memberAgentIds ?? []).map(agentName).join('、') ||
                                  '未指定'}
                              </div>
                            </div>
                          )}
                          {message.actionStatus === 'proposed' && (
                            <div className="planner-action-buttons">
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={actionBusy === message.id}
                                onClick={() => void applyAction(message.id)}
                              >
                                {actionBusy === message.id ? '执行中…' : '确认执行'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={actionBusy === message.id}
                                onClick={() => void rejectAction(message.id)}
                              >
                                取消
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {isUser && (
                    <AgentAvatar avatar={userProfile.avatar} size={28} title={userProfile.name} />
                  )}
                </div>
              )
            })}
            {busy && (
              <div className="planner-message-row planner">
                <AgentAvatar
                  avatar={plannerAgent?.avatar ?? '🧭'}
                  size={28}
                  title={plannerAgent?.name ?? 'Planner'}
                />
                <div className="planner-message-column">
                  <div className="planner-message-meta">
                    <span className="planner-message-author">
                      {plannerAgent?.name ?? 'Planner'}
                    </span>
                    <span className="planner-message-time">正在思考…</span>
                  </div>
                  <div className="planner-message planner">
                    <div className="planner-typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="planner-composer">
            <textarea
              className="textarea"
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder="和 Planner 讨论目标、范围、验收、团队…（⌘/Ctrl + Enter 发送）"
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || draft.trim() === ''}
              onClick={() => void send()}
            >
              <Icon name="send" size={14} />
              {busy ? 'Planner 思考中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
