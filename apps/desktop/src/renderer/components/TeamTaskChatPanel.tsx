import {
  type AgentProfile,
  ExecutionOutputPayload,
  type Team,
  type TeamMember,
  type TeamTaskMessage,
  type TeamTaskSubtask,
} from '@agentra/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import { readableContent } from '../utils/readable-content'
import { appendLiveText } from '../utils/stream-text'
import { toolLabel } from '../utils/tool-label'
import { useUserProfile } from '../utils/user-profile'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './Icon'
import { Modal } from './Modal'

const ISSUE_STATUS_LABEL: Record<string, string> = {
  triage: '待分诊',
  backlog: '待处理',
  in_progress: '处理中',
  review: '待验收',
  done: '已完成',
}

const SUBTASK_LABEL: Record<TeamTaskSubtask['status'], string> = {
  pending: '待处理',
  running: '进行中',
  review: '待验收',
  done: '完成',
  blocked: '被阻塞',
}

const MODE_LABEL: Record<string, string> = {
  normal: '发送并排队',
  steer: '注入当前运行',
  after_run: '本轮结束后处理',
  restart: '重启当前运行',
  skip: '只留言，不触发',
}

const MESSAGE_PREVIEW_LIMIT = 100

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// 旧版本的流程播报；新运行改由 Agent 自己用第一人称发言，这里只清理历史噪音。
const LEGACY_RUN_TEXTS = new Set([
  '成员开始处理子任务。',
  '队长开始处理任务。',
  '成员已完成子任务，请队长验收。',
  '所有子任务已完成，任务进入待验收。',
  '任务未激活，无法启动协作运行。',
])

function authorLabel(message: TeamTaskMessage, agents: AgentProfile[], userName = '老板'): string {
  if (message.authorType === 'user') return userName
  if (message.authorType === 'system') return '系统'
  if (message.authorType === 'planner') return 'Planner'
  const agent = agents.find((item) => item.id === message.authorId)
  return agent?.name ?? message.authorId
}

function issueTone(status: string): string {
  if (status === 'done') return 'done'
  if (status === 'review') return 'warn'
  if (status === 'in_progress') return 'accent'
  return 'pending'
}

function previewText(text: string, limit = 420): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}\n…`
}

function previewMessage(text: string, limit = MESSAGE_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}…`
}

function toolSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return toolLabel(name)
  const value = input as Record<string, unknown>
  if (name === 'Bash' && typeof value.command === 'string') {
    const description = typeof value.description === 'string' ? value.description : ''
    return description
      ? `${description} · ${value.command.slice(0, 140)}`
      : value.command.slice(0, 180)
  }
  if (typeof value.file_path === 'string') return value.file_path
  if (typeof value.path === 'string') return value.path
  if (typeof value.query === 'string') return value.query.slice(0, 120)
  return toolLabel(name)
}

function MessageItem({
  message,
  agents,
  stepCount,
  userName,
  userAvatar,
  onOpenDetail,
}: {
  message: TeamTaskMessage
  agents: AgentProfile[]
  stepCount: number
  userName: string
  userAvatar: string
  onOpenDetail: () => void
}) {
  const content = readableContent(message.content)
  const isSystem = message.authorType === 'system'
  const isRun = message.kind === 'run' || message.kind === 'status'
  const isUser = message.authorType === 'user'
  const mention = typeof message.metadata.mention === 'string' ? message.metadata.mention : null
  const assigned =
    typeof message.metadata.assigneeAgentId === 'string' ? message.metadata.assigneeAgentId : null
  const assignedAgent = assigned ? agents.find((agent) => agent.id === assigned) : null
  const hasDetail = content.length > MESSAGE_PREVIEW_LIMIT || stepCount > 0
  const authorAgent =
    message.authorType === 'planner'
      ? agents.find((agent) => agent.systemKind === 'planner')
      : agents.find((agent) => agent.id === message.authorId)
  const avatar = isUser
    ? userAvatar
    : (authorAgent?.avatar ?? (message.authorType === 'planner' ? '🧭' : '🤖'))

  if (isSystem || isRun) {
    if (LEGACY_RUN_TEXTS.has(content)) return null
    return (
      <div className="team-message team-message-system">
        <span className="team-message-system-dot" />
        <span className="team-message-system-text">{previewMessage(content)}</span>
        <span className="team-message-time">
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
        {hasDetail && (
          <button type="button" className="message-expand" onClick={onOpenDetail}>
            详情
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`team-message-row ${isUser ? 'is-user' : 'is-agent'}`}>
      <AgentAvatar avatar={avatar} size={28} title={authorLabel(message, agents, userName)} />
      <div className="team-message-column">
        <div className="team-message-head">
          {isUser && (
            <span className="team-message-time">
              {new Date(message.createdAt).toLocaleTimeString()}
            </span>
          )}
          <span className="team-message-author">{authorLabel(message, agents, userName)}</span>
          {!isUser && (
            <span className="team-message-time">
              {new Date(message.createdAt).toLocaleTimeString()}
            </span>
          )}
          {message.kind === 'decision' && <span className="pill warn plain">决定</span>}
          {message.kind === 'escalation' && <span className="pill danger plain">升级</span>}
          {mention && <span className="chip">@{mention}</span>}
          {assignedAgent && <span className="chip">派给 {assignedAgent.name}</span>}
        </div>
        <div className={`team-message team-message-${message.authorType}`}>
          <div className="team-message-content">
            {previewMessage(content)}
            {hasDetail && (
              <button
                type="button"
                className="message-expand message-detail-inline"
                onClick={onOpenDetail}
              >
                详情
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 团队任务主视图：只展示“当前谁在做什么”、子任务和关键线程动作。
 * 长契约/模型原文默认折叠，避免把整段 JSON 或技术文档直接铺满页面。
 */
export function TeamTaskChatPanel({
  workId,
  agents,
  teams,
  onRefreshWorks,
  onOpenRuns,
}: {
  workId: string
  agents: AgentProfile[]
  teams: Team[]
  onRefreshWorks?: () => void
  onOpenRuns?: () => void
}) {
  const { profile: userProfile } = useUserProfile()
  const [view, setView] = useState<Awaited<ReturnType<typeof api.getTeamTask>> | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState('normal')
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailMessageId, setDetailMessageId] = useState<string | null>(null)
  const [liveOutput, setLiveOutput] = useState<{
    text: string
    thinkingText: string
    thinking: boolean
    tool: string | null
    tokens: number
  } | null>(null)
  const [liveSteps, setLiveSteps] = useState<
    { id: string; name: string; summary: string; at: string }[]
  >([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const work = view?.work ?? null
  const activeRun = view?.activeRun ?? null
  const ownerTeam = work?.ownerTeamId
    ? (teams.find((team) => team.id === work.ownerTeamId) ?? null)
    : null
  const memberAgentIds = useMemo(() => new Set(members.map((member) => member.agentId)), [members])
  const mentionCandidates = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase()
    return agents
      .filter(
        (agent) =>
          agent.status === 'active' &&
          memberAgentIds.has(agent.id) &&
          (query === '' || agent.name.toLowerCase().includes(query)),
      )
      .slice(0, 8)
  }, [agents, memberAgentIds, mentionQuery])

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const activeSubtask =
    view?.subtasks.find((subtask) => subtask.id === activeRun?.subtaskId) ?? null
  const memberActivity = useMemo(() => {
    if (!view) return []
    return members
      .map((member) => {
        const agent = agentById.get(member.agentId)
        const running = view.subtasks.find(
          (subtask) => subtask.assigneeAgentId === member.agentId && subtask.status === 'running',
        )
        const current =
          running ??
          view.subtasks.find(
            (subtask) => subtask.assigneeAgentId === member.agentId && subtask.status === 'review',
          )
        return { agent, current }
      })
      .filter((item) => item.agent !== undefined)
  }, [view, members, agentById])

  const recentSteps = useMemo(() => {
    if (!view) return []
    const steps = view.steps ?? []
    const latestRun =
      activeRun ??
      [...view.runs].reverse().find((run) => steps.some((step) => step.runId === run.id)) ??
      null
    if (!latestRun) return []
    const persisted = steps
      .filter((step) => step.runId === latestRun.id)
      .map((step) => ({
        id: step.stepKey,
        name: step.name,
        summary: step.summary,
        at: step.createdAt,
      }))
    if (activeRun?.id !== latestRun.id) return persisted
    const seen = new Set(persisted.map((step) => step.id))
    return [...persisted, ...liveSteps.filter((step) => !seen.has(step.id))]
  }, [view, activeRun, liveSteps])

  const detailMessage = view?.messages.find((message) => message.id === detailMessageId) ?? null
  const detailRunId =
    detailMessage && typeof detailMessage.metadata.runId === 'string'
      ? detailMessage.metadata.runId
      : null
  const detailRun = detailRunId ? (view?.runs.find((run) => run.id === detailRunId) ?? null) : null
  const detailSteps = detailRun
    ? (view?.steps ?? []).filter((step) => step.runId === detailRun.id)
    : []

  const runStepCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const step of view?.steps ?? []) {
      counts.set(step.runId, (counts.get(step.runId) ?? 0) + 1)
    }
    if (activeRun) {
      counts.set(activeRun.id, (counts.get(activeRun.id) ?? 0) + liveSteps.length)
    }
    return counts
  }, [view, activeRun, liveSteps])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const loaded = await api.getTeamTask({ workId })
      setView(loaded)
      setLoading(false)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      setLoading(false)
    }
  }, [workId])

  const stopActiveRun = async (): Promise<void> => {
    if (!activeRun?.executionId || stopBusy) return
    setStopBusy(true)
    setError(null)
    try {
      await api.cancelExecution(activeRun.executionId)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setStopBusy(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    void reload()
    const timer = setInterval(() => {
      void api
        .getTeamTask({ workId })
        .then((loaded) => setView(loaded))
        .catch(() => undefined)
    }, 2500)
    return () => clearInterval(timer)
  }, [workId, reload])

  useEffect(() => {
    if (!ownerTeam) {
      setMembers([])
      return
    }
    void api
      .listTeamMembers(ownerTeam.id)
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [ownerTeam])

  // 实时执行输出：Provider 的 WebSocket 事件直接驱动“思考中/打字中”，
  // 不等待下一次 teamTask.get 轮询。SSE 不适用，因为 Core 已经用 WS 推送事件。
  useEffect(() => {
    const executionId = activeRun?.executionId
    setLiveOutput(null)
    setLiveSteps([])
    if (!executionId) return
    const recordStep = (id: string, name: string, input: unknown): void => {
      setLiveSteps((current) => {
        if (current.some((step) => step.id === id)) return current
        return [
          ...current,
          {
            id,
            name,
            summary: toolSummary(name, input),
            at: new Date().toISOString(),
          },
        ].slice(-40)
      })
    }
    let sawPartialText = false
    return api.onEvent((event) => {
      if (event.eventType !== 'execution.output') return
      const parsed = ExecutionOutputPayload.safeParse(event.payload)
      if (!parsed.success || parsed.data.executionId !== executionId) return
      const { stream, content } = parsed.data
      if (stream === 'structured') {
        try {
          const value = JSON.parse(content) as Record<string, unknown>
          const type = value.type
          if (type === 'system' && value.subtype === 'thinking_tokens') {
            const tokens = typeof value.estimated_tokens === 'number' ? value.estimated_tokens : 0
            setLiveOutput((current) => {
              if (current?.thinking) return current
              return {
                text: current?.text ?? '',
                thinkingText: current?.thinkingText ?? '',
                thinking: true,
                tool: null,
                tokens,
              }
            })
            return
          }
          if (type === 'stream_event') {
            const streamEvent = value.event as
              | {
                  type?: string
                  content_block?: { type?: string }
                  delta?: { type?: string; text?: string; thinking?: string }
                }
              | undefined
            if (streamEvent?.type === 'content_block_start') {
              if (streamEvent.content_block?.type === 'thinking') {
                setLiveOutput((current) => ({
                  text: current?.text ?? '',
                  thinkingText: current?.thinkingText ?? '',
                  thinking: true,
                  tool: null,
                  tokens: current?.tokens ?? 0,
                }))
              }
              return
            }
            if (streamEvent?.type === 'content_block_delta') {
              const delta = streamEvent.delta
              if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                setLiveOutput((current) => ({
                  text: current?.text ?? '',
                  thinkingText: appendLiveText(
                    current?.thinkingText ?? '',
                    delta.thinking ?? '',
                  ).slice(-4000),
                  thinking: true,
                  tool: null,
                  tokens: current?.tokens ?? 0,
                }))
                return
              }
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                sawPartialText = true
                setLiveOutput((current) => ({
                  text: appendLiveText(current?.text ?? '', delta.text ?? '').slice(-4000),
                  thinkingText: current?.thinkingText ?? '',
                  thinking: false,
                  tool: null,
                  tokens: current?.tokens ?? 0,
                }))
              }
            }
            return
          }
          if (type === 'assistant') {
            const message = value.message as
              | {
                  content?: Array<{
                    type?: string
                    text?: string
                    id?: string
                    name?: string
                    input?: unknown
                  }>
                }
              | undefined
            for (const item of message?.content ?? []) {
              if (item.type === 'tool_use' && item.name) {
                recordStep(item.id ?? `${item.name}-${Date.now()}`, item.name, item.input)
              }
            }
            const text = (message?.content ?? [])
              .filter((item) => item.type === 'text' && typeof item.text === 'string')
              .map((item) => item.text)
              .join('')
            if (text.trim() && !sawPartialText) {
              setLiveOutput((current) => ({
                text: appendLiveText(current?.text ?? '', text).slice(-4000),
                thinkingText: current?.thinkingText ?? '',
                thinking: false,
                tool: null,
                tokens: current?.tokens ?? 0,
              }))
            }
            return
          }
          if (type === 'tool_use') {
            const name = typeof value.name === 'string' ? value.name : '工具'
            recordStep(
              typeof value.id === 'string' ? value.id : `${name}-${Date.now()}`,
              name,
              value.input,
            )
            setLiveOutput((current) => ({
              text: current?.text ?? '',
              thinkingText: current?.thinkingText ?? '',
              thinking: false,
              tool: null,
              tokens: current?.tokens ?? 0,
            }))
            return
          }
          if (type === 'result' && typeof value.result === 'string') {
            setLiveOutput((current) => ({
              text: readableContent(value.result as string).slice(-4000),
              thinkingText: '',
              thinking: false,
              tool: null,
              tokens: current?.tokens ?? 0,
            }))
          }
        } catch {
          // 非 JSON 的 structured 内容不展示。
        }
        return
      }
      if (stream === 'stdout' && content.trim() && !content.trim().startsWith('{')) {
        setLiveOutput((current) => ({
          text: appendLiveText(current?.text ?? '', content).slice(-4000),
          thinkingText: current?.thinkingText ?? '',
          thinking: false,
          tool: null,
          tokens: current?.tokens ?? 0,
        }))
      }
    })
  }, [activeRun?.executionId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new messages or run status change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view?.messages.length, activeRun?.status])

  const handleDraftChange = (value: string, cursor: number): void => {
    setDraft(value)
    const before = value.slice(0, cursor)
    const match = /@([^\s@]*)$/.exec(before)
    if (match) {
      setMentionQuery(match[1] ?? '')
      setMentionOpen(true)
    } else {
      setMentionOpen(false)
    }
  }

  const pickMention = (agent: AgentProfile): void => {
    const cursor = textareaRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, cursor)
    const after = draft.slice(cursor)
    const replaced = before.replace(/@([^\s@]*)$/, `@${agent.name} `)
    setDraft(replaced + after)
    setMentionedAgentIds((current) =>
      current.includes(agent.id) ? current : [...current, agent.id],
    )
    setMentionOpen(false)
    setMentionQuery('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const send = async (): Promise<void> => {
    if (!work || draft.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.commentTeamTask({
        workId,
        authorId: 'local-user',
        content: draft.trim(),
        mentions: mentionedAgentIds,
        mode: mode as 'normal' | 'steer' | 'after_run' | 'restart' | 'skip',
      })
      setDraft('')
      setMentionedAgentIds([])
      setMode('normal')
      await reload()
      onRefreshWorks?.()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="card task-chat-card">
        <div className="empty-state">加载团队任务线程…</div>
      </div>
    )
  }

  if (!work || !view) {
    return (
      <div className="card task-chat-card">
        <div className="empty-state">{error ?? '团队任务不存在。'}</div>
      </div>
    )
  }

  return (
    <div className="card task-chat-card">
      <div className="card-head team-task-head">
        <div className="card-title">
          团队任务
          <span className={`pill ${issueTone(work.issueStatus)}`}>
            {ISSUE_STATUS_LABEL[work.issueStatus] ?? work.issueStatus}
          </span>
          {ownerTeam && <span className="chip">{ownerTeam.name}</span>}
        </div>
        <div className="team-member-line">
          {memberActivity.length === 0 ? (
            <span className="faint">
              队长：{agentById.get(ownerTeam?.leaderAgentId ?? '')?.name ?? '未设置'}
            </span>
          ) : (
            memberActivity.map(({ agent, current }) => {
              const running = activeRun?.status === 'running' && activeRun.agentId === agent?.id
              const tone =
                running || current?.status === 'running'
                  ? 'running'
                  : current?.status === 'review'
                    ? 'review'
                    : current?.status === 'blocked'
                      ? 'blocked'
                      : 'idle'
              const label = current ? `${SUBTASK_LABEL[current.status]} · ${current.title}` : '空闲'
              return (
                <span className="team-member-line-item" key={agent?.id} title={label}>
                  <span className={`team-member-dot ${tone}`} />
                  {agent?.name}
                </span>
              )
            })
          )}
        </div>
      </div>
      <div className="card-body task-chat-body">
        {activeRun && (
          <div className="team-now">
            <div className="team-now-main">
              <span className="team-now-dot live" />
              <div style={{ minWidth: 0 }}>
                <div className="team-now-title">
                  {agentById.get(activeRun.agentId ?? '')?.name ?? 'Agent'}{' '}
                  {activeRun.role === 'leader' ? '正在协调' : '正在执行'}
                </div>
                <div className="team-now-sub">{activeSubtask?.title ?? '处理线程消息'}</div>
              </div>
            </div>
          </div>
        )}

        <div className="task-chat-messages">
          {view.messages.length === 0 && (
            <div className="empty-state">还没有讨论。队长收到任务后会开始拆解。</div>
          )}
          {view.messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              agents={agents}
              stepCount={
                typeof message.metadata.runId === 'string'
                  ? (runStepCounts.get(message.metadata.runId) ?? 0)
                  : 0
              }
              userName={userProfile.name}
              userAvatar={userProfile.avatar}
              onOpenDetail={() => setDetailMessageId(message.id)}
            />
          ))}
          {activeRun && (
            <div className="team-live">
              <AgentAvatar
                avatar={agentById.get(activeRun.agentId ?? '')?.avatar ?? '🤖'}
                size={26}
              />
              <div className="team-live-copy">
                <div className="team-live-head">
                  <strong>{agentById.get(activeRun.agentId ?? '')?.name ?? 'Agent'}</strong>
                  <span className="pill warn plain">
                    {activeRun.role === 'leader' ? '队长执行中' : '执行中'}
                  </span>
                  {liveOutput?.thinking && <span className="faint">思考中…</span>}
                  <div className="team-live-actions">
                    {onOpenRuns && (
                      <button
                        type="button"
                        className="message-expand team-live-more"
                        onClick={onOpenRuns}
                      >
                        查看更多
                      </button>
                    )}
                    {activeRun.executionId && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon team-live-stop"
                        aria-label="停止当前运行"
                        title="停止当前运行"
                        disabled={stopBusy}
                        onClick={() => void stopActiveRun()}
                      >
                        <Icon name="stop" size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div
                  className={`team-live-text ${
                    liveOutput?.thinking && !liveOutput.text.trim() ? 'thinking' : ''
                  }`}
                >
                  {liveOutput?.text.trim()
                    ? previewText(liveOutput.text.slice(-500), 500)
                    : liveOutput?.thinkingText.trim()
                      ? previewText(liveOutput.thinkingText.slice(-500), 500)
                      : liveOutput?.thinking
                        ? '正在思考，准备下一步…'
                        : recentSteps.length > 0
                          ? `正在执行（${recentSteps.length} 个步骤）`
                          : '正在准备…'}
                </div>
              </div>
              <span className="typing-dots" role="status" aria-label="正在执行">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <div className="banner error" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        )}

        {mentionedAgentIds.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mentionedAgentIds.map((id) => (
              <span className="chip" key={id}>
                @{agents.find((agent) => agent.id === id)?.name ?? id}
                <button
                  type="button"
                  className="chip-x"
                  aria-label="移除提及"
                  onClick={() =>
                    setMentionedAgentIds((current) => current.filter((item) => item !== id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="team-task-composer">
          {mentionOpen && mentionCandidates.length > 0 && (
            <div className="mention-menu">
              {mentionCandidates.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  className="mention-item"
                  onClick={() => pickMention(agent)}
                >
                  <strong>{agent.name}</strong>
                  <span className="faint">
                    {agent.accessMode === 'analyze' ? '只读分析' : '编辑'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="textarea"
            rows={3}
            value={draft}
            onChange={(event) =>
              handleDraftChange(event.target.value, event.target.selectionStart ?? 0)
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="在团队任务里留言，@队长或成员触发处理…（⌘/Ctrl + Enter 发送）"
            disabled={busy}
          />
          <div className="team-task-composer-actions">
            <select
              className="select"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              aria-label="评论触发方式"
            >
              {Object.entries(MODE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || draft.trim() === ''}
              onClick={() => void send()}
            >
              <Icon name="send" size={14} />
              {busy ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={detailMessage !== null}
        title="消息详情"
        width={760}
        onClose={() => setDetailMessageId(null)}
      >
        {detailMessage && (
          <div className="team-message-detail">
            <div className="team-message-detail-meta">
              <strong>{authorLabel(detailMessage, agents, userProfile.name)}</strong>
              <span className="faint">{new Date(detailMessage.createdAt).toLocaleString()}</span>
              {detailRun && (
                <span className="chip">
                  {detailRun.role === 'leader' ? '队长运行' : '成员运行'} ·{' '}
                  {RUN_STATUS_LABEL[detailRun.status] ?? detailRun.status}
                </span>
              )}
            </div>
            <div className="team-message-detail-content">
              {readableContent(detailMessage.content)}
            </div>
            {detailRun ? (
              <div className="team-message-detail-run">
                <div className="team-message-detail-run-head">
                  运行日志
                  <span className="count">{detailSteps.length}</span>
                </div>
                {detailSteps.length === 0 ? (
                  <div className="empty-state">
                    {detailRun.role === 'leader'
                      ? '队长运行只做决策，不调用 Bash/Read 等工具。'
                      : '本次运行没有工具调用记录。'}
                  </div>
                ) : (
                  <div className="team-run-steps-list">
                    {detailSteps.map((step) => (
                      <div className="team-live-step" key={step.id}>
                        <span className="team-step-name">{toolLabel(step.name)}</span>
                        <span className="team-step-summary" title={step.summary}>
                          {step.summary}
                        </span>
                        <span className="team-message-time">
                          {new Date(step.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="faint" style={{ marginTop: 14 }}>
                这条消息没有关联的 Agent 运行。
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
