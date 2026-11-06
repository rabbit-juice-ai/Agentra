import type { AgentProfile, PlanGetResult, PlanThreadView } from '@agentra/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import { Icon } from './Icon'
import { Modal } from './Modal'

const PLAN_STATUS_LABEL: Record<string, string> = {
  pending_approval: '等待批准',
  approved: '已批准',
  rejected: '已拒绝',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function statusTone(status: string): string {
  if (status === 'approved' || status === 'running' || status === 'completed') return 'done'
  if (status === 'rejected' || status === 'failed') return 'danger'
  if (status === 'pending_approval') return 'warn'
  return 'pending'
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ]
}

/**
 * 任务详情的主视图：最新计划的群聊线程。
 * 聊天是主内容；概览/团队/交付物/设置由任务详情右侧栏承载。
 */
export function TaskChatPanel({
  workId,
  workName,
  workDescription,
  workStatus,
  agents,
  onActivate,
  onResume,
  onAssignmentsChanged,
}: {
  workId: string
  workName: string
  workDescription: string
  workStatus: string
  agents: AgentProfile[]
  onActivate: () => void
  onResume: () => void
  onAssignmentsChanged?: () => void
}) {
  const [view, setView] = useState<PlanGetResult | null>(null)
  const [threads, setThreads] = useState<PlanThreadView[]>([])
  const [selectedTaskKey, setSelectedTaskKey] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<{ agentId: string; status: string }[]>([])
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [planOpen, setPlanOpen] = useState(false)
  const [planGoal, setPlanGoal] = useState('')
  const [planConstraints, setPlanConstraints] = useState('')
  const [planBusy, setPlanBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const planId = view?.plan.id ?? null
  const planStatus = view?.plan.status ?? null

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setView(null)
    setThreads([])
    void api
      .listPlansByWork({ workId })
      .then(async (result) => {
        const latest = result.plans[0]
        if (!alive) return
        if (!latest) {
          setLoading(false)
          return
        }
        const loaded = await api.getPlan({ planId: latest.id })
        if (!alive) return
        setView(loaded)
        setThreads(loaded.threads)
        setSelectedTaskKey(loaded.threads[0]?.thread.taskKey ?? '')
        setLoading(false)
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [workId])

  useEffect(() => {
    if (!planId || planStatus !== 'running') return
    const timer = setInterval(() => {
      void api
        .getPlan({ planId })
        .then((loaded) => {
          setView(loaded)
          setThreads(loaded.threads)
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [planId, planStatus])

  useEffect(() => {
    void api
      .listAssignments(workId)
      .then((items) =>
        setAssignments(items.map((item) => ({ agentId: item.agentId, status: item.status }))),
      )
      .catch(() => setAssignments([]))
  }, [workId])

  const reloadPlan = useCallback(async (): Promise<void> => {
    const result = await api.listPlansByWork({ workId })
    const latest = result.plans[0]
    if (!latest) {
      setView(null)
      setThreads([])
      return
    }
    const loaded = await api.getPlan({ planId: latest.id })
    setView(loaded)
    setThreads(loaded.threads)
    setSelectedTaskKey((current) => current || loaded.threads[0]?.thread.taskKey || '')
    const items = await api.listAssignments(workId)
    setAssignments(items.map((item) => ({ agentId: item.agentId, status: item.status })))
  }, [workId])

  const openPlanModal = (): void => {
    setPlanGoal(workDescription || workName)
    setPlanConstraints('')
    setPlanOpen(true)
  }

  const generatePlan = async (mode: 'ai' | 'fast'): Promise<void> => {
    if (planGoal.trim() === '' || planBusy) return
    setPlanBusy(true)
    setError(null)
    try {
      await api.generatePlan({
        goal: planGoal.trim(),
        workId,
        mode,
        ...(planConstraints.trim() === '' ? {} : { constraints: splitList(planConstraints) }),
      })
      setPlanOpen(false)
      await reloadPlan()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setPlanBusy(false)
    }
  }

  const approvePlan = async (): Promise<void> => {
    if (!view || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      await api.approvePlan({ planId: view.plan.id, decidedBy: 'local-user' })
      await reloadPlan()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const startPlan = async (): Promise<void> => {
    if (!view || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      await api.startPlanRun({ planId: view.plan.id })
      await reloadPlan()
      onAssignmentsChanged?.()
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const assignedAgentIds = useMemo(
    () =>
      new Set(assignments.filter((item) => item.status === 'active').map((item) => item.agentId)),
    [assignments],
  )
  const mentionCandidates = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase()
    return agents
      .filter((agent) => agent.status === 'active' && assignedAgentIds.has(agent.id))
      .filter((agent) => query === '' || agent.name.toLowerCase().includes(query))
      .slice(0, 8)
  }, [agents, assignedAgentIds, mentionQuery])

  const selectedThread =
    threads.find((thread) => thread.thread.taskKey === selectedTaskKey) ?? threads[0] ?? null
  const taskTitle = (taskKey: string): string =>
    view?.version.plan.tasks.find((task) => task.key === taskKey)?.title ?? taskKey

  const refreshThreads = async (id: string): Promise<void> => {
    const loaded = await api.getPlan({ planId: id })
    setView(loaded)
    setThreads(loaded.threads)
  }

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
    if (!planId || !selectedThread || draft.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.commentOnPlan({
        planId,
        taskKey: selectedThread.thread.taskKey,
        authorId: 'local-user',
        content: draft.trim(),
        mentions: mentionedAgentIds,
      })
      setDraft('')
      setMentionedAgentIds([])
      await refreshThreads(planId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }

  const planModal = (
    <Modal
      open={planOpen}
      title="规划这个任务"
      onClose={() => setPlanOpen(false)}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setPlanOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={planBusy || planGoal.trim() === ''}
            onClick={() => void generatePlan('fast')}
          >
            {planBusy ? '规划中…' : '快速草稿'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={planBusy || planGoal.trim() === ''}
            onClick={() => void generatePlan('ai')}
          >
            {planBusy ? '规划中…' : 'AI 规划'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="field">
          <label htmlFor="task-plan-goal">目标</label>
          <textarea
            id="task-plan-goal"
            className="textarea"
            value={planGoal}
            onChange={(event) => setPlanGoal(event.target.value)}
            placeholder="描述这个任务要完成什么…"
          />
        </div>
        <div className="field">
          <label htmlFor="task-plan-constraints">约束（逗号或换行分隔）</label>
          <input
            id="task-plan-constraints"
            className="input"
            value={planConstraints}
            onChange={(event) => setPlanConstraints(event.target.value)}
            placeholder="不改数据库结构, 必须通过现有测试"
          />
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          计划会直接出现在当前任务群聊里，批准后即可启动执行。AI 规划可能需要 1–2 分钟。
        </div>
      </div>
    </Modal>
  )

  if (loading) {
    return (
      <div className="card task-chat-card">
        <div className="empty-state">加载任务群聊…</div>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="card task-chat-card">
        <div className="card-head">
          <div className="card-title">群聊</div>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          <div className="empty-state">
            该任务还没有计划。可以直接在这里让 Planner
            规划，也可以先去「规划」页做独立规划再转为任务。
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ justifySelf: 'start' }}
            onClick={openPlanModal}
          >
            <Icon name="zap" size={14} />让 Planner 规划这个任务
          </button>
        </div>
        {planModal}
      </div>
    )
  }

  return (
    <div className="card task-chat-card">
      <div className="card-head">
        <div className="card-title">
          群聊
          <span className={`pill ${statusTone(view.plan.status)}`}>
            {PLAN_STATUS_LABEL[view.plan.status] ?? view.plan.status}
          </span>
        </div>
        <div className="right faint" style={{ fontSize: 11 }}>
          {view.plan.goal}
        </div>
      </div>
      <div className="card-body task-chat-body">
        {view.plan.status === 'pending_approval' &&
          (view.version.validation.valid ? (
            <div
              className="banner warn"
              style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ flex: 1 }}>计划已生成，等待老板批准。批准后即可启动执行。</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={actionBusy}
                onClick={() => void approvePlan()}
              >
                批准计划
              </button>
            </div>
          ) : (
            <div className="banner error" style={{ margin: 0 }}>
              计划校验未通过（{view.version.validation.violations.length}{' '}
              处问题），请先到「规划」页修改后再批准。
            </div>
          ))}
        {view.plan.status === 'approved' &&
          (workStatus === 'active' ? (
            <div
              className="banner"
              style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ flex: 1 }}>计划已批准，可以启动执行。</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={actionBusy}
                onClick={() => void startPlan()}
              >
                启动执行
              </button>
            </div>
          ) : (
            <div
              className="banner warn"
              style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ flex: 1 }}>
                {workStatus === 'draft'
                  ? '任务还是草稿，先激活任务再启动执行。'
                  : workStatus === 'paused'
                    ? '任务已暂停，先恢复任务再启动执行。'
                    : `任务状态为 ${workStatus}，无法启动执行。`}
              </span>
              {workStatus === 'draft' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={actionBusy}
                  onClick={onActivate}
                >
                  激活任务
                </button>
              )}
              {workStatus === 'paused' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={actionBusy}
                  onClick={onResume}
                >
                  恢复任务
                </button>
              )}
            </div>
          ))}
        {(view.plan.status === 'rejected' ||
          view.plan.status === 'failed' ||
          view.plan.status === 'cancelled') && (
          <div
            className="banner warn"
            style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span style={{ flex: 1 }}>
              当前计划{PLAN_STATUS_LABEL[view.plan.status] ?? view.plan.status}，可以重新规划。
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={openPlanModal}>
              重新规划
            </button>
          </div>
        )}
        <div className="filter-chips" style={{ marginBottom: 0 }}>
          {threads.map((thread) => (
            <button
              type="button"
              key={thread.thread.id}
              className={`chip-filter ${
                selectedThread?.thread.taskKey === thread.thread.taskKey ? 'on' : ''
              }`}
              onClick={() => setSelectedTaskKey(thread.thread.taskKey)}
            >
              {taskTitle(thread.thread.taskKey)}
            </button>
          ))}
        </div>

        <div className="task-chat-messages">
          {selectedThread?.comments.length === 0 && (
            <div className="empty-state">还没有讨论。发第一条消息，或 @ 一个 Agent 开始协作。</div>
          )}
          {selectedThread?.comments.map((comment) => {
            const agent = agents.find((item) => item.id === comment.authorId)
            const author =
              comment.authorType === 'system'
                ? '系统'
                : comment.authorType === 'agent'
                  ? `${agent?.name ?? comment.authorId} · Agent`
                  : '我'
            return (
              <div key={comment.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span
                  className="chat-dot"
                  style={{
                    background:
                      comment.authorType === 'system'
                        ? 'var(--text-3)'
                        : comment.authorType === 'agent'
                          ? 'var(--accent)'
                          : 'var(--ok)',
                    marginTop: 6,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                    {author} · {new Date(comment.createdAt).toLocaleTimeString()}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.6 }}>
                    {comment.content}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {error && (
          <div className="banner error" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        )}

        {mentionedAgentIds.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mentionedAgentIds.map((id) => {
              const agent = agents.find((item) => item.id === id)
              return (
                <span className="chip" key={id}>
                  @{agent?.name ?? id}
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
              )
            })}
          </div>
        )}

        <div className="task-chat-composer">
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
                  <span className="faint">{agent.role}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="textarea"
            style={{ flex: 1, minHeight: 58 }}
            value={draft}
            onChange={(event) =>
              handleDraftChange(event.target.value, event.target.selectionStart ?? 0)
            }
            placeholder="在任务群聊里讨论；输入 @ 呼叫 Agent 协作…"
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || draft.trim() === ''}
            onClick={() => void send()}
          >
            <Icon name="send" size={14} />
            发送
          </button>
        </div>
      </div>
      {planModal}
    </div>
  )
}
