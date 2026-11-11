import type {
  AgentProfile,
  Assignment,
  PlanDispatch,
  PlanGenerateResult,
  PlanGetResult,
  PlanReadiness,
  PlanRecord,
  PlanTask,
  PlanTaskAssignment,
  PlanThreadView,
  Project,
  RuntimeProviderRecord,
  Team,
  TeamMember,
  Work,
} from '@agentra/protocol'
import { AGENT_ACCESS_MODE_LABEL } from '@agentra/protocol'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../services/api'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'
import { ProviderBadge } from './ProviderBadge'

type Props = {
  works: Work[]
  projects: Project[]
  agents: AgentProfile[]
  providers: RuntimeProviderRecord[]
  teams: Team[]
  membersByTeam: Record<string, TeamMember[]>
  onRefreshTeamMembers?: (teamId: string) => Promise<void>
  onWorksChanged?: () => void
  onProjectsChanged?: () => void
}

const WORK_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

const PLAN_STATUS_LABEL: Record<string, string> = {
  pending_approval: '等待批准',
  approved: '已批准',
  rejected: '已拒绝',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const READINESS_LABEL: Record<PlanReadiness['state'], string> = {
  pending_approval: '待审批',
  rejected: '已拒绝',
  pending_dispatch: '待派工',
  dispatching: '派工中',
  dispatch_failed: '派工失败',
  ready: '已就绪',
  starting: '启动中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const ASSIGNMENT_SOURCE_LABEL: Record<PlanTaskAssignment['source'], string> = {
  planner: 'Planner 建议',
  leader: '队长派工',
  user: '老板指定',
  legacy: '旧计划沿用',
}

const DISPATCH_TONE: Record<PlanDispatch['status'], string> = {
  pending: 'pending',
  running: 'warn',
  succeeded: 'done',
  failed: 'danger',
  cancelled: 'pending',
}

const DISPATCH_LABEL: Record<PlanDispatch['status'], string> = {
  pending: '待派工',
  running: '派工中',
  succeeded: '已派工',
  failed: '派工失败',
  cancelled: '已取消',
}

function statusTone(status: string): string {
  if (status === 'approved' || status === 'running' || status === 'completed' || status === 'ready')
    return 'done'
  if (status === 'rejected' || status === 'failed' || status === 'dispatch_failed') return 'danger'
  if (
    status === 'pending_approval' ||
    status === 'pending_dispatch' ||
    status === 'dispatching' ||
    status === 'starting'
  )
    return 'warn'
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

export function PlanPage({
  works,
  projects,
  agents,
  providers,
  teams,
  membersByTeam,
  onRefreshTeamMembers,
  onWorksChanged,
  onProjectsChanged,
}: Props) {
  const [goal, setGoal] = useState('')
  const [constraints, setConstraints] = useState('')
  const [workId, setWorkId] = useState('')
  const [result, setResult] = useState<PlanGenerateResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMode, setLoadingMode] = useState<'ai' | 'fast' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [rejectComment, setRejectComment] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [threads, setThreads] = useState<PlanThreadView[]>([])
  const [savedPlans, setSavedPlans] = useState<PlanRecord[]>([])
  const [planDetail, setPlanDetail] = useState<PlanGetResult | null>(null)
  const [dispatchBusy, setDispatchBusy] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTaskKey, setAssignTaskKey] = useState('')
  const [assignAgentId, setAssignAgentId] = useState('')
  const [assignReason, setAssignReason] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const [selectedTaskKey, setSelectedTaskKey] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [reassignSelection, setReassignSelection] = useState<Record<string, string>>({})
  const [reassignBusy, setReassignBusy] = useState(false)
  const [reworkBusy, setReworkBusy] = useState(false)
  const [activePlanWorkId, setActivePlanWorkId] = useState<string | null>(null)
  const [convertMode, setConvertMode] = useState<'task' | 'project' | null>(null)
  const [convertName, setConvertName] = useState('')
  const [convertRoot, setConvertRoot] = useState('')
  const [convertProjectId, setConvertProjectId] = useState('')
  const [convertProjectName, setConvertProjectName] = useState('')
  const [convertProjectDescription, setConvertProjectDescription] = useState('')
  const [convertBusy, setConvertBusy] = useState(false)
  const activeWork = works.find((work) => work.id === activePlanWorkId) ?? null

  const refreshSavedPlans = useCallback(async (targetWorkId: string): Promise<void> => {
    try {
      const loaded =
        targetWorkId === ''
          ? await api.listRecentPlans({ limit: 20 })
          : await api.listPlansByWork({ workId: targetWorkId })
      setSavedPlans(loaded.plans)
    } catch {
      // 计划列表是辅助信息，不阻断生成/审批主流程。
    }
  }, [])

  useEffect(() => {
    void refreshSavedPlans(workId)
  }, [workId, refreshSavedPlans])

  // 规划页可能先于团队页打开：按需拉取团队任务成员，供老板启动前改派。
  const planTeamIds = (result?.plan.tasks ?? [])
    .map((task) => task.teamId)
    .filter((teamId): teamId is string => teamId !== null)
    .join(',')
  useEffect(() => {
    if (!onRefreshTeamMembers) return
    for (const teamId of new Set(planTeamIds.split(',').filter(Boolean))) {
      if (!(teamId in membersByTeam)) void onRefreshTeamMembers(teamId)
    }
  }, [planTeamIds, membersByTeam, onRefreshTeamMembers])

  const activePlanId = result?.planId ?? null
  const activePlanStatus = result?.status ?? null

  const refreshPlanDetail = useCallback(async (planId: string): Promise<PlanGetResult | null> => {
    try {
      const view = await api.getPlan({ planId })
      setPlanDetail(view)
      return view
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      return null
    }
  }, [])

  // 运行中的计划需要 Work 的 Assignment 列表来计算「同角色可改派 Agent」。
  useEffect(() => {
    if (!activePlanId || activePlanStatus !== 'running' || workId === '') {
      setAssignments([])
      return
    }
    let cancelled = false
    void api
      .listAssignments(workId)
      .then((items) => {
        if (!cancelled) setAssignments(items)
      })
      .catch(() => {
        if (!cancelled) setAssignments([])
      })
    return () => {
      cancelled = true
    }
  }, [activePlanId, activePlanStatus, workId])

  const openPlan = async (planId: string): Promise<void> => {
    setError(null)
    try {
      const view = await api.getPlan({ planId })
      setResult({
        plan: view.version.plan,
        validation: view.version.validation,
        plannerExecutionId: null,
        source: view.version.source,
        fallbackReason: view.version.fallbackReason,
        planId: view.plan.id,
        planVersionId: view.version.id,
        status: view.plan.status,
      })
      setThreads(view.threads)
      setPlanDetail(view)
      setRunId(view.plan.workflowRunId)
      setActivePlanWorkId(view.plan.workId)
      setWorkId(view.plan.workId ?? '')
      setSelectedTaskKey(view.threads[0]?.thread.taskKey ?? '')
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    }
  }

  // 计划执行中：轮询计划/线程，Run 结束后状态自动落到 completed/failed/cancelled。
  useEffect(() => {
    const planId = result?.planId
    if (!planId || result?.status !== 'running') return
    const timer = setInterval(() => {
      void api
        .getPlan({ planId })
        .then((view) => {
          setResult((current) =>
            current && current.planId === planId
              ? { ...current, status: view.plan.status }
              : current,
          )
          setThreads(view.threads)
          setPlanDetail(view)
        })
        .catch(() => undefined)
    }, 5000)
    return () => clearInterval(timer)
  }, [result?.planId, result?.status])

  const refreshThreads = async (planId: string): Promise<void> => {
    try {
      const loaded = await api.listPlanThreads({ planId })
      setThreads(loaded.threads)
      setSelectedTaskKey((current) => current || loaded.threads[0]?.thread.taskKey || '')
    } catch {
      // 线程是辅助信息，不阻断计划主流程。
    }
  }

  const generate = async (mode: 'ai' | 'fast'): Promise<void> => {
    if (goal.trim().length === 0 || loading) return
    setLoading(true)
    setLoadingMode(mode)
    setError(null)
    setResult(null)
    setThreads([])
    setRunId(null)
    try {
      const generated = await api.generatePlan({
        goal: goal.trim(),
        mode,
        ...(workId === '' ? {} : { workId }),
        ...(splitList(constraints).length === 0 ? {} : { constraints: splitList(constraints) }),
      })
      setResult(generated)
      setActivePlanWorkId(workId === '' ? null : workId)
      await refreshThreads(generated.planId)
      await refreshPlanDetail(generated.planId)
      await refreshSavedPlans(workId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setLoading(false)
      setLoadingMode(null)
    }
  }

  const openConvert = (mode: 'task' | 'project'): void => {
    if (!result) return
    const base = result.plan.goal.slice(0, 80)
    setConvertMode(mode)
    setConvertName(base)
    setConvertRoot(`/tmp/agentra-plan-${result.planId.slice(-8)}`)
    setConvertProjectId(projects[0]?.id ?? '')
    setConvertProjectName(base)
    setConvertProjectDescription('')
  }

  const convert = async (): Promise<void> => {
    if (!result || !convertMode || convertBusy) return
    setConvertBusy(true)
    setError(null)
    try {
      if (convertMode === 'task') {
        await api.convertPlanToTask({
          planId: result.planId,
          name: convertName.trim(),
          rootPath: convertRoot.trim(),
          projectId: convertProjectId === '' ? null : convertProjectId,
        })
      } else {
        await api.convertPlanToProject({
          planId: result.planId,
          projectName: convertProjectName.trim(),
          ...(convertProjectDescription.trim() === ''
            ? {}
            : { projectDescription: convertProjectDescription.trim() }),
          taskName: convertName.trim(),
          rootPath: convertRoot.trim(),
        })
      }
      const view = await api.getPlan({ planId: result.planId })
      setResult({
        plan: view.version.plan,
        validation: view.version.validation,
        plannerExecutionId: null,
        source: view.version.source,
        fallbackReason: view.version.fallbackReason,
        planId: view.plan.id,
        planVersionId: view.version.id,
        status: view.plan.status,
      })
      setThreads(view.threads)
      setPlanDetail(view)
      setRunId(view.plan.workflowRunId)
      setActivePlanWorkId(view.plan.workId)
      setWorkId(view.plan.workId ?? '')
      setConvertMode(null)
      onWorksChanged?.()
      onProjectsChanged?.()
      await refreshSavedPlans(view.plan.workId ?? '')
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setConvertBusy(false)
    }
  }

  const approve = async (): Promise<void> => {
    if (!result || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      const decision = await api.approvePlan({ planId: result.planId, decidedBy: 'local-user' })
      setResult({ ...result, status: decision.plan.status })
      await refreshThreads(result.planId)
      await refreshPlanDetail(result.planId)
      await refreshSavedPlans(workId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const reject = async (): Promise<void> => {
    if (!result || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      const decision = await api.rejectPlan({
        planId: result.planId,
        decidedBy: 'local-user',
        ...(rejectComment.trim() === '' ? {} : { comment: rejectComment.trim() }),
      })
      setResult({ ...result, status: decision.plan.status })
      await refreshThreads(result.planId)
      await refreshPlanDetail(result.planId)
      await refreshSavedPlans(workId)
      setRejectOpen(false)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!result || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      const started = await api.startPlanRun({
        planId: result.planId,
        requestId: crypto.randomUUID(),
      })
      setResult({ ...result, status: started.plan.status })
      setRunId(started.run.id)
      await refreshThreads(result.planId)
      await refreshPlanDetail(result.planId)
      await refreshSavedPlans(workId)
      if (started.schedulingError) {
        setError(`启动已保存，但${started.schedulingError}`)
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const dispatchPlan = async (): Promise<void> => {
    if (!result || dispatchBusy) return
    setDispatchBusy(true)
    setError(null)
    try {
      await api.dispatchPlan({ planId: result.planId })
      await refreshThreads(result.planId)
      await refreshPlanDetail(result.planId)
      await refreshSavedPlans(workId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setDispatchBusy(false)
    }
  }

  const openAssign = (taskKey: string): void => {
    setAssignTaskKey(taskKey)
    setAssignAgentId('')
    setAssignReason('')
    setAssignOpen(true)
  }

  const assignCandidatesFor = (taskKey: string): AgentProfile[] => {
    const task = result?.plan.tasks.find((candidate) => candidate.key === taskKey)
    if (!task) return []
    const team = task.teamId ? teams.find((candidate) => candidate.id === task.teamId) : null
    const memberIds = task.teamId
      ? new Set((membersByTeam[task.teamId] ?? []).map((member) => member.agentId))
      : null
    return agents.filter((agent) => {
      if (agent.status !== 'active') return false
      if (agent.accessMode !== task.requiredAccessMode) return false
      if (agent.toolPermissions.allow.length === 0) return false
      if (memberIds && !memberIds.has(agent.id)) return false
      if (team?.leaderAgentId === agent.id) return false
      return true
    })
  }

  const submitAssign = async (): Promise<void> => {
    if (!result || assignTaskKey === '' || assignAgentId === '' || assignBusy) return
    setAssignBusy(true)
    setError(null)
    try {
      await api.assignPlanTask({
        planId: result.planId,
        taskKey: assignTaskKey,
        agentId: assignAgentId,
        reason: assignReason.trim(),
        decidedBy: 'local-user',
      })
      setAssignOpen(false)
      await refreshThreads(result.planId)
      await refreshPlanDetail(result.planId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setAssignBusy(false)
    }
  }

  const sendComment = async (): Promise<void> => {
    if (!result || selectedTaskKey === '' || commentDraft.trim() === '' || actionBusy) return
    setActionBusy(true)
    setError(null)
    try {
      await api.commentOnPlan({
        planId: result.planId,
        taskKey: selectedTaskKey,
        authorId: 'local-user',
        content: commentDraft.trim(),
      })
      setCommentDraft('')
      await refreshThreads(result.planId)
      await refreshSavedPlans(workId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const reassignTask = async (taskKey: string): Promise<void> => {
    const agentId = reassignSelection[taskKey]
    if (!result || !agentId || reassignBusy) return
    setReassignBusy(true)
    setError(null)
    try {
      await api.reassignPlanTask({
        planId: result.planId,
        taskKey,
        agentId,
        decidedBy: 'local-user',
      })
      setReassignSelection((current) => ({ ...current, [taskKey]: '' }))
      await refreshThreads(result.planId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setReassignBusy(false)
    }
  }

  const resolveExhaustedRework = async (action: 'continue' | 'takeover'): Promise<void> => {
    const taskKey = selectedTaskKey || threads[0]?.thread.taskKey
    if (!result || !taskKey || reworkBusy) return
    setReworkBusy(true)
    setError(null)
    try {
      const params = { planId: result.planId, taskKey, decidedBy: 'local-user' }
      if (action === 'continue') await api.continuePlanRework(params)
      else await api.takeOverPlanRework(params)
      await refreshThreads(result.planId)
      await refreshSavedPlans(workId)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setReworkBusy(false)
    }
  }

  const taskAssignmentFor = (taskKey: string): PlanTaskAssignment | null =>
    planDetail?.taskAssignments.find(
      (assignment) => assignment.taskKey === taskKey && assignment.status === 'active',
    ) ?? null

  const assignmentFor = (taskKey: string) => {
    const current = taskAssignmentFor(taskKey)
    if (current) return current
    return (
      result?.validation.assignments.find((assignment) => assignment.taskKey === taskKey) ?? null
    )
  }

  const teamNameFor = (taskKey: string): string | null => {
    const task = result?.plan.tasks.find((candidate) => candidate.key === taskKey)
    if (!task?.teamId) return null
    return teams.find((team) => team.id === task.teamId)?.name ?? task.teamId
  }

  const readiness = planDetail?.readiness ?? null

  const reassignCandidatesFor = (
    taskKey: string,
  ): { agentId: string; agentName: string; workRole: string }[] => {
    const currentAgentId = assignmentFor(taskKey)?.agentId
    const current = assignments.find((assignment) => assignment.agentId === currentAgentId)
    if (!current) return []
    const task = result?.plan.tasks.find((candidate) => candidate.key === taskKey)
    const candidates = new Map<string, { agentId: string; agentName: string; workRole: string }>()
    for (const assignment of assignments) {
      if (
        assignment.status !== 'active' ||
        assignment.workRole !== current.workRole ||
        assignment.agentId === currentAgentId
      )
        continue
      candidates.set(assignment.agentId, {
        agentId: assignment.agentId,
        workRole: assignment.workRole,
        agentName:
          agents.find((agent) => agent.id === assignment.agentId)?.name ?? assignment.agentId,
      })
    }
    if (task?.teamId) {
      const team = teams.find((candidate) => candidate.id === task.teamId)
      for (const member of membersByTeam[task.teamId] ?? []) {
        if (member.agentId === currentAgentId || candidates.has(member.agentId)) continue
        const agent = agents.find((candidate) => candidate.id === member.agentId)
        if (!agent) continue
        if (agent.status !== 'active') continue
        if (agent.accessMode !== task.requiredAccessMode) continue
        if (agent.toolPermissions.allow.length === 0) continue
        if (team?.leaderAgentId === agent.id) continue
        candidates.set(agent.id, {
          agentId: agent.id,
          agentName: agent.name,
          workRole: current.workRole,
        })
      }
    }
    return [...candidates.values()]
  }

  const agentFor = (taskKey: string): AgentProfile | null => {
    const assignment = assignmentFor(taskKey)
    if (!assignment?.agentId) return null
    return agents.find((agent) => agent.id === assignment.agentId) ?? null
  }

  const providerFor = (agent: AgentProfile | null): RuntimeProviderRecord | null => {
    if (!agent) return null
    return providers.find((provider) => provider.id === agent.defaultProviderId) ?? null
  }

  const selectedThread =
    threads.find((thread) => thread.thread.taskKey === selectedTaskKey) ?? threads[0] ?? null
  const lastReworkMessage = [...(selectedThread?.comments ?? [])]
    .reverse()
    .find((comment) => comment.content.includes('返工') || comment.content.includes('接管'))
  const reworkExhausted =
    result?.status === 'running' && lastReworkMessage?.content.includes('返工超限') === true
  const taskTitle = (taskKey: string): string =>
    result?.plan.tasks.find((task) => task.key === taskKey)?.title ?? taskKey

  return (
    <div className="page">
      <PageHeader
        title="规划"
        subtitle="老板给目标，Planner Agent 拆任务、选负责人、定验收；计划批准后才能执行。"
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading || goal.trim().length === 0}
              onClick={() => void generate('fast')}
            >
              快速草稿
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={loading || goal.trim().length === 0}
              onClick={() => void generate('ai')}
            >
              <Icon name="zap" size={14} />
              {loading && loadingMode === 'ai' ? '规划中…' : 'AI 规划'}
            </button>
          </>
        }
      />

      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div className="card-title">目标</div>
          <div className="right">
            {loading && (
              <span className="faint" style={{ fontSize: 11 }}>
                {loadingMode === 'fast' ? '正在按能力匹配生成快速草稿…' : 'Planner Agent 正在规划…'}
              </span>
            )}
          </div>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 10 }}>
          <div className="field">
            <label htmlFor="plan-goal">你想完成什么？</label>
            <textarea
              id="plan-goal"
              className="textarea"
              style={{ minHeight: 96 }}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：做一个备份恢复 UI，支持手动备份、导出、恢复预检和恢复进度；先保证本地可用，不改现有数据库结构。"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="plan-work">关联任务（可选）</label>
              <select
                id="plan-work"
                className="select"
                value={workId}
                onChange={(event) => setWorkId(event.target.value)}
              >
                <option value="">独立规划（不关联任务）</option>
                {works.map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="plan-constraints">约束（逗号或换行分隔）</label>
              <input
                id="plan-constraints"
                className="input"
                value={constraints}
                onChange={(event) => setConstraints(event.target.value)}
                placeholder="不改数据库结构, 必须通过现有测试"
              />
            </div>
          </div>
          <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
            Planner 只能从当前 Agent Registry
            里选人；职责描述用于理解，最终负责人必须通过结构化能力校验。 工具权限不会被计划扩大。 AI
            规划可能需要 1–2 分钟，失败会自动回落到快速草稿。
          </div>
        </div>
      </div>

      {savedPlans.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <div className="card-title">最近计划</div>
            <div className="right">
              <span className="faint" style={{ fontSize: 10.5 }}>
                {savedPlans.length}
              </span>
            </div>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 6 }}>
            {savedPlans.slice(0, 8).map((plan) => (
              <div key={plan.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span className={`pill ${statusTone(plan.status)}`}>
                  {PLAN_STATUS_LABEL[plan.status] ?? plan.status}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 550,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {plan.goal}
                  </div>
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    {plan.workId
                      ? (works.find((work) => work.id === plan.workId)?.name ?? '任务')
                      : '独立规划'}{' '}
                    · {plan.id} · {new Date(plan.createdAt).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void openPlan(plan.id)}
                >
                  打开
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <>
          {result.source === 'fallback' && (
            <div className="banner warn">
              这是能力匹配生成的快速草稿，未调用 Planner 模型。
              {result.fallbackReason ? ` 原因：${result.fallbackReason}。` : ''}
              建议用 AI 规划复核后再批准。
            </div>
          )}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div className="card-title">
                计划
                <span className={`pill ${result.source === 'fallback' ? 'warn' : 'accent'}`}>
                  {result.source === 'fallback' ? '快速草稿' : 'AI 规划'}
                </span>
                <span className={`pill ${statusTone(result.status)}`}>
                  {PLAN_STATUS_LABEL[result.status] ?? result.status}
                </span>
                {readiness && (
                  <span className={`pill ${statusTone(readiness.state)}`}>
                    {READINESS_LABEL[readiness.state]}
                  </span>
                )}
                <span className={`pill ${result.validation.valid ? 'done' : 'danger'}`}>
                  {result.validation.valid
                    ? '校验通过'
                    : `${result.validation.violations.length} 处问题`}
                </span>
              </div>
              <div className="right">
                <span className="faint mono" style={{ fontSize: 10 }}>
                  {result.plannerExecutionId ?? '未调用模型'}
                </span>
              </div>
            </div>
            <div className="card-body" style={{ display: 'grid', gap: 8 }}>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {result.plan.goal}
              </div>
              <div className="meta-grid">
                <div className="meta-cell">
                  <div className="k">任务数</div>
                  <div className="v">{result.plan.tasks.length}</div>
                </div>
                <div className="meta-cell">
                  <div className="k">校验</div>
                  <div className="v">{result.validation.valid ? '通过' : '需要修改'}</div>
                </div>
                <div className="meta-cell">
                  <div className="k">能力缺口</div>
                  <div className="v">{result.plan.capabilityGaps.length}</div>
                </div>
                <div className="meta-cell">
                  <div className="k">已派工</div>
                  <div className="v">
                    {readiness ? `${readiness.assignedTasks}/${readiness.totalTasks}` : '—'}
                  </div>
                </div>
                <div className="meta-cell">
                  <div className="k">团队任务</div>
                  <div className="v">
                    {readiness ? `${readiness.assignedTeamTasks}/${readiness.teamTasks}` : '—'}
                  </div>
                </div>
              </div>
              {result.plan.risks.length > 0 && (
                <div className="faint" style={{ fontSize: 11.5 }}>
                  风险：{result.plan.risks.join('；')}
                </div>
              )}
              {result.plan.capabilityGaps.length > 0 && (
                <div className="banner warn" style={{ margin: 0 }}>
                  {result.plan.capabilityGaps.map((gap) => `${gap.role}：${gap.reason}`).join('；')}
                </div>
              )}
              {result.validation.violations.length > 0 && (
                <div className="banner error" style={{ margin: 0 }}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {result.validation.violations.map((violation) => (
                      <div
                        key={`${violation.code}-${violation.taskKey ?? ''}-${violation.message}`}
                      >
                        <strong>{violation.code}</strong>
                        {violation.taskKey ? ` · ${violation.taskKey}` : ''} · {violation.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {readiness && readiness.dispatches.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gap: 6,
                    padding: '8px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 11.5 }}>队长派工</strong>
                    {readiness.reason && (
                      <span className="faint" style={{ fontSize: 10.5 }}>
                        {readiness.reason}
                      </span>
                    )}
                  </div>
                  {readiness.dispatches.map((dispatch) => (
                    <div
                      key={dispatch.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}
                    >
                      <span className={`pill ${DISPATCH_TONE[dispatch.status]}`}>
                        {DISPATCH_LABEL[dispatch.status]}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {dispatch.teamName ?? dispatch.teamId}
                        <span className="faint">
                          {' '}
                          · 队长 {dispatch.leaderAgentName ?? dispatch.leaderAgentId ?? '未设置'}
                          {dispatch.attempt > 1 ? ` · 第 ${dispatch.attempt} 次` : ''}
                        </span>
                      </span>
                      {dispatch.errorMessage && (
                        <span
                          className="faint"
                          style={{ color: 'var(--danger)', maxWidth: 360 }}
                          title={dispatch.errorMessage}
                        >
                          {dispatch.errorCode}：{dispatch.errorMessage}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                {result.status === 'pending_approval' && (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={actionBusy}
                      onClick={() => setRejectOpen(true)}
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={actionBusy || !result.validation.valid}
                      onClick={() => void approve()}
                    >
                      批准计划
                    </button>
                  </>
                )}
                {result.status === 'approved' && (
                  <>
                    {result.plan.tasks.some((task) => task.teamId !== null) &&
                      (readiness?.state === 'pending_dispatch' ||
                        readiness?.state === 'dispatch_failed' ||
                        readiness?.state === 'dispatching') && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={
                            actionBusy || dispatchBusy || readiness?.state === 'dispatching'
                          }
                          onClick={() => void dispatchPlan()}
                        >
                          {dispatchBusy || readiness?.state === 'dispatching'
                            ? '队长派工中…'
                            : readiness?.state === 'dispatch_failed'
                              ? '重试派工'
                              : '开始派工'}
                        </button>
                      )}
                    {activePlanWorkId !== null &&
                      (readiness?.canStart && activeWork?.status === 'active' ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={actionBusy}
                          onClick={() => void start()}
                        >
                          启动执行
                        </button>
                      ) : activeWork?.status !== 'active' ? (
                        <span className="pill warn">
                          任务{WORK_STATUS_LABEL[activeWork?.status ?? ''] ?? '状态未知'}
                          ，请先在任务详情激活/恢复后再启动
                        </span>
                      ) : (
                        <span className="pill warn">
                          {readiness?.reason ?? '等待全部任务派工完成'}
                        </span>
                      ))}
                  </>
                )}
                {activePlanWorkId === null &&
                  (result.status === 'pending_approval' || result.status === 'approved') && (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={actionBusy || convertBusy}
                        onClick={() => openConvert('task')}
                      >
                        转为任务
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={actionBusy || convertBusy}
                        onClick={() => openConvert('project')}
                      >
                        转为项目
                      </button>
                    </>
                  )}
                {result.status === 'running' && (
                  <span className="pill done">执行中{runId ? ` · ${runId}` : ''}</span>
                )}
                {result.status === 'rejected' && <span className="pill danger">计划已拒绝</span>}
                <span className="faint" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                  {activePlanWorkId === null
                    ? '独立规划：批准后可转为任务或项目。'
                    : '批准后由系统拆解任务并交给执行引擎运行。'}
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {result.plan.tasks.map((task) => (
              <PlanTaskCard
                key={task.key}
                task={task}
                agent={agentFor(task.key)}
                provider={providerFor(agentFor(task.key))}
                assignmentName={assignmentFor(task.key)?.agentName ?? null}
                teamName={teamNameFor(task.key)}
                assignmentSource={taskAssignmentFor(task.key)?.source ?? null}
                canPreAssign={result.status === 'approved'}
                onOpenAssign={() => openAssign(task.key)}
                canReassign={result.status === 'running'}
                reassignCandidates={reassignCandidatesFor(task.key)}
                reassignValue={reassignSelection[task.key] ?? ''}
                onReassignValueChange={(value) =>
                  setReassignSelection((current) => ({ ...current, [task.key]: value }))
                }
                onReassign={() => void reassignTask(task.key)}
                reassignBusy={reassignBusy}
              />
            ))}
          </div>

          {threads.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head">
                <div className="card-title">
                  任务讨论
                  <span className="pill pending plain">{threads.length}</span>
                </div>
                <div className="right">
                  <span className="faint" style={{ fontSize: 10.5 }}>
                    群聊 · 人 + Agent
                  </span>
                </div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 10 }}>
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
                <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflow: 'auto' }}>
                  {selectedThread?.comments.map((comment) => (
                    <div
                      key={comment.id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        padding: '6px 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <span
                        className={`dot ${
                          comment.authorType === 'system'
                            ? 'gray'
                            : comment.authorType === 'agent'
                              ? 'blue'
                              : ''
                        }`}
                        style={{ marginTop: 6 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                          {comment.authorType === 'system'
                            ? '系统'
                            : comment.authorType === 'agent'
                              ? comment.authorId
                              : '我'}{' '}
                          · {new Date(comment.createdAt).toLocaleTimeString()}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text)' }}>{comment.content}</div>
                      </div>
                    </div>
                  ))}
                </div>
                {reworkExhausted && (
                  <div
                    className="banner warn"
                    style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span style={{ flex: 1 }}>
                      返工已超限，分支已暂停。继续返工会增加一轮；接管后执行保持暂停，由人工处理。
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={reworkBusy}
                      onClick={() => void resolveExhaustedRework('continue')}
                    >
                      继续返工一轮
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={reworkBusy}
                      onClick={() => void resolveExhaustedRework('takeover')}
                    >
                      接管
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <textarea
                    className="textarea"
                    style={{ flex: 1, minHeight: 46 }}
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    placeholder="在任务线程里留言…"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={actionBusy || commentDraft.trim() === ''}
                    onClick={() => void sendComment()}
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        open={assignOpen}
        title="指定任务成员"
        onClose={() => setAssignOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAssignOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={assignBusy || assignAgentId === '' || assignReason.trim().length === 0}
              onClick={() => void submitAssign()}
            >
              {assignBusy ? '保存中…' : '保存指定'}
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="assign-agent">成员</label>
            <select
              id="assign-agent"
              className="select"
              value={assignAgentId}
              onChange={(event) => setAssignAgentId(event.target.value)}
            >
              <option value="">选择成员…</option>
              {assignCandidatesFor(assignTaskKey).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {AGENT_ACCESS_MODE_LABEL[agent.accessMode]}
                </option>
              ))}
            </select>
            {assignCandidatesFor(assignTaskKey).length === 0 && (
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                没有匹配该任务权限要求的团队成员。请先补充成员或调整任务要求。
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="assign-reason">原因 *</label>
            <textarea
              id="assign-reason"
              className="textarea"
              value={assignReason}
              onChange={(event) => setAssignReason(event.target.value)}
              placeholder="例如：该成员更熟悉支付模块；队长派工失败后由老板手动指定。"
            />
          </div>
          <div className="faint" style={{ fontSize: 11 }}>
            指定后旧成员记录保留为历史；启动执行时以最新 active 成员为准。
          </div>
        </div>
      </Modal>

      <Modal
        open={rejectOpen}
        title="拒绝计划"
        onClose={() => setRejectOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRejectOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={actionBusy}
              onClick={() => void reject()}
            >
              确认拒绝
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="reject-comment">拒绝意见（可选）</label>
          <textarea
            id="reject-comment"
            className="textarea"
            value={rejectComment}
            onChange={(event) => setRejectComment(event.target.value)}
            placeholder="告诉 Planner 哪里需要调整…"
          />
        </div>
      </Modal>

      <Modal
        open={convertMode !== null}
        title={convertMode === 'project' ? '转为项目' : '转为任务'}
        onClose={() => setConvertMode(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConvertMode(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                convertBusy ||
                convertName.trim() === '' ||
                convertRoot.trim() === '' ||
                (convertMode === 'project' && convertProjectName.trim() === '')
              }
              onClick={() => void convert()}
            >
              {convertMode === 'project' ? '创建项目与任务' : '创建任务'}
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          {convertMode === 'project' && (
            <>
              <div className="field">
                <label htmlFor="convert-project-name">项目名称 *</label>
                <input
                  id="convert-project-name"
                  className="input"
                  value={convertProjectName}
                  onChange={(event) => setConvertProjectName(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="convert-project-description">项目描述</label>
                <textarea
                  id="convert-project-description"
                  className="textarea"
                  value={convertProjectDescription}
                  onChange={(event) => setConvertProjectDescription(event.target.value)}
                />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="convert-task-name">任务名称 *</label>
            <input
              id="convert-task-name"
              className="input"
              value={convertName}
              onChange={(event) => setConvertName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="convert-root">工作目录 *</label>
            <input
              id="convert-root"
              className="input"
              value={convertRoot}
              onChange={(event) => setConvertRoot(event.target.value)}
            />
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              Agent 会在这个目录下工作；目录不存在会自动创建。
            </div>
          </div>
          {convertMode === 'task' && (
            <div className="field">
              <label htmlFor="convert-project">项目（可选）</label>
              <select
                id="convert-project"
                className="select"
                value={convertProjectId}
                onChange={(event) => setConvertProjectId(event.target.value)}
              >
                <option value="">不关联项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

function PlanTaskCard({
  task,
  agent,
  provider,
  assignmentName,
  teamName,
  assignmentSource,
  canPreAssign,
  onOpenAssign,
  canReassign,
  reassignCandidates,
  reassignValue,
  onReassignValueChange,
  onReassign,
  reassignBusy,
}: {
  task: PlanTask
  agent: AgentProfile | null
  provider: RuntimeProviderRecord | null
  assignmentName: string | null
  teamName: string | null
  assignmentSource: PlanTaskAssignment['source'] | null
  canPreAssign: boolean
  onOpenAssign: () => void
  canReassign: boolean
  reassignCandidates: { agentId: string; agentName: string; workRole: string }[]
  reassignValue: string
  onReassignValueChange: (value: string) => void
  onReassign: () => void
  reassignBusy: boolean
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          {task.title}
          <span className="pill pending plain">{task.key}</span>
          <span className="chip">{task.responsibilityRole}</span>
          {teamName && <span className="chip">团队 · {teamName}</span>}
        </div>
        <div className="right">
          {agent ? (
            <ProviderBadge provider={provider} />
          ) : (
            <span className={`pill ${task.teamId ? 'warn' : 'danger'}`}>
              {task.teamId ? '待队长派工' : '未分配'}
            </span>
          )}
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 8 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {task.description}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="chip">需要：{AGENT_ACCESS_MODE_LABEL[task.requiredAccessMode]}</span>
          {task.dependsOn.length > 0 && (
            <span className="faint" style={{ fontSize: 11 }}>
              依赖：{task.dependsOn.join('、')}
            </span>
          )}
          {task.verification && (
            <span className="pill warn">验收 {task.verification.verifies.join('、')}</span>
          )}
          {task.approvalRequired && <span className="pill warn">需老板审批</span>}
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          负责人：{assignmentName ?? (task.teamId ? '待队长派工' : '未分配')}
          {assignmentSource ? ` · ${ASSIGNMENT_SOURCE_LABEL[assignmentSource]}` : ''}
          {task.outputs.length > 0 ? ` · 输出：${task.outputs.join('、')}` : ''}
          {canPreAssign && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 8 }}
              onClick={onOpenAssign}
            >
              {assignmentName ? '更换成员' : '指定成员'}
            </button>
          )}
        </div>
        {canReassign && reassignCandidates.length > 0 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              className="select"
              style={{ maxWidth: 260 }}
              value={reassignValue}
              onChange={(event) => onReassignValueChange(event.target.value)}
              aria-label={`改派 ${task.title}`}
            >
              <option value="">改派给同角色 Agent…</option>
              {reassignCandidates.map((candidate) => (
                <option key={candidate.agentId} value={candidate.agentId}>
                  {candidate.agentName} · {candidate.workRole}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={reassignBusy || reassignValue === ''}
              onClick={onReassign}
            >
              改派
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              下一次 attempt 生效
            </span>
          </div>
        )}
        {task.acceptanceCriteria.length > 0 && (
          <ul
            className="muted"
            style={{ margin: 0, paddingLeft: 17, fontSize: 11.5, lineHeight: 1.7 }}
          >
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
