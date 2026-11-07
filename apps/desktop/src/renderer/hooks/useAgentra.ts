import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  Assignment,
  AssignmentCreateParams,
  HealthResult,
  Project,
  ProjectCreateParams,
  ProjectUpdateParams,
  RuntimeProviderRecord,
  Skill,
  SkillCreateParams,
  SkillUpdateParams,
  Team,
  TeamCreateParams,
  TeamMember,
  TeamMemberAddParams,
  TeamUpdateParams,
  Work,
  WorkCreateParams,
  Worktree,
} from '@agentra/protocol'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import {
  type ConsoleState,
  consoleReducer,
  initialConsoleState,
  terminalExecutionId,
} from '../state/console-reducer'

const POLL_INTERVAL_MS = 5000

type BannerTone = 'info' | 'warn' | 'error' | 'success'
export type BannerMessage = {
  message: string
  tone: BannerTone
  /** 需要人工处理的消息常驻，直到用户关闭；其余自动消失。 */
  sticky: boolean
}

/**
 * 全部数据获取与状态推导集中在这里：组件只消费状态、调用 actions。
 * Desktop 只经 Core RPC（AGENTS §2）。
 */
export function useAgentra() {
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [works, setWorks] = useState<Work[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember[]>>({})
  const [assignmentsByWork, setAssignmentsByWork] = useState<Record<string, Assignment[]>>({})
  const [worktreesByWork, setWorktreesByWork] = useState<Record<string, Worktree[]>>({})
  const [providers, setProviders] = useState<RuntimeProviderRecord[]>([])
  const [consoleState, dispatch] = useReducer(consoleReducer, initialConsoleState)
  const [coreHealth, setCoreHealth] = useState<HealthResult | null>(null)
  const [daemonHealth, setDaemonHealth] = useState<HealthResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<BannerMessage | null>(null)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showBanner = useCallback(
    (
      message: string,
      options: { tone?: BannerTone; sticky?: boolean; durationMs?: number } = {},
    ) => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
      const next: BannerMessage = {
        message,
        tone: options.tone ?? 'warn',
        sticky: options.sticky ?? false,
      }
      setBanner(next)
      if (!next.sticky) {
        bannerTimer.current = setTimeout(
          () => {
            setBanner(null)
            bannerTimer.current = null
          },
          options.durationMs ?? (next.tone === 'error' ? 6000 : 3500),
        )
      }
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
    }
  }, [])

  const dismissBanner = useCallback(() => {
    if (bannerTimer.current) {
      clearTimeout(bannerTimer.current)
      bannerTimer.current = null
    }
    setBanner(null)
  }, [])

  const reportError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        // CLI 不可用/未认证需要用户自行修复：常驻提示，直到用户关闭。
        if (error.code === 'CLI_UNAVAILABLE') {
          showBanner(
            'CLI 不可用：未发现可用的 Claude Code 可执行文件。请安装 Claude Code（或设置 AGENTRA_CLAUDE_PATH 指向可执行文件）后重试。',
            { tone: 'error', sticky: true },
          )
          return
        }
        if (error.code === 'CLI_NOT_AUTHENTICATED') {
          showBanner(
            'CLI 未认证：已找到 Claude Code 但登录态不可用。请在终端执行登录命令（Provider 面板可复制）后重试。',
            { tone: 'error', sticky: true },
          )
          return
        }
        showBanner(`${error.code}: ${error.message}`, { tone: 'error' })
        return
      }
      showBanner(error instanceof Error ? error.message : String(error), { tone: 'error' })
    },
    [showBanner],
  )

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await api.listSkills())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshTeams = useCallback(async () => {
    try {
      setTeams(await api.listTeams())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshWorks = useCallback(async () => {
    try {
      setWorks(await api.listWorks())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshTeamMembers = useCallback(
    async (teamId: string) => {
      try {
        const members = await api.listTeamMembers(teamId)
        setTeamMembers((current) => ({ ...current, [teamId]: members }))
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
  )

  const refreshAssignments = useCallback(
    async (workId: string) => {
      try {
        const assignments = await api.listAssignments(workId)
        setAssignmentsByWork((current) => ({ ...current, [workId]: assignments }))
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
  )

  const refreshWorktrees = useCallback(
    async (workId: string) => {
      try {
        const worktrees = await api.listWorktrees(workId)
        setWorktreesByWork((current) => ({ ...current, [workId]: worktrees }))
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
  )

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api.listProviders())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshExecutions = useCallback(async () => {
    try {
      dispatch({ type: 'executionsLoaded', executions: await api.listExecutions() })
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const refreshHealth = useCallback(async () => {
    try {
      const [core, daemon] = await Promise.all([
        window.agentra.getCoreHealth(),
        window.agentra.getDaemonHealth(),
      ])
      setCoreHealth(core.ok ? core.result : null)
      setDaemonHealth(daemon.ok ? daemon.result : null)
    } catch {
      setCoreHealth(null)
      setDaemonHealth(null)
    }
  }, [])

  const refreshExecution = useCallback(
    async (executionId: string) => {
      try {
        const snapshot = await api.getExecution(executionId)
        dispatch({ type: 'executionUpserted', execution: snapshot.execution })
        dispatch({ type: 'logsLoaded', executionId, logs: snapshot.logs })
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
  )

  useEffect(() => {
    void refreshAgents()
    void refreshSkills()
    void refreshProviders()
    void refreshExecutions()
    void refreshHealth()
    void refreshTeams()
    void refreshWorks()
    void refreshProjects()
    const timer = setInterval(() => {
      void refreshHealth()
      void refreshExecutions()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [
    refreshAgents,
    refreshSkills,
    refreshProviders,
    refreshExecutions,
    refreshHealth,
    refreshTeams,
    refreshWorks,
    refreshProjects,
  ])

  // Core 就绪（含重连）后补拉首屏数据：启动时 renderer 常先于 Core 就绪，首拉会撞 NOT_READY，
  // 而 agents / providers 没有轮询，不补拉就会一直是空列表。
  useEffect(() => {
    return api.onCoreReady(() => {
      void refreshAgents()
      void refreshSkills()
      void refreshProviders()
      void refreshExecutions()
      void refreshHealth()
      void refreshTeams()
      void refreshWorks()
      void refreshProjects()
      setBanner((current) => (current?.message.includes('NOT_READY') ? null : current))
    })
  }, [
    refreshAgents,
    refreshSkills,
    refreshProviders,
    refreshExecutions,
    refreshHealth,
    refreshTeams,
    refreshWorks,
    refreshProjects,
  ])

  useEffect(() => {
    return api.onEvent((event) => {
      dispatch({ type: 'event', event })
      const finished = terminalExecutionId(event)
      if (finished) void refreshExecution(finished)
    })
  }, [refreshExecution])

  const createAgent = useCallback(
    async (params: AgentCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createAgent(params)
        await refreshAgents()
        showBanner('Agent 已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError, showBanner],
  )

  const updateAgent = useCallback(
    async (params: AgentUpdateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.updateAgent(params)
        await refreshAgents()
        showBanner('Agent 已更新', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError, showBanner],
  )

  const archiveAgent = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.archiveAgent(id)
        await refreshAgents()
        showBanner('Agent 已归档', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError, showBanner],
  )

  const setAgentStatus = useCallback(
    async (id: string, status: 'active' | 'disabled'): Promise<void> => {
      setBusy(true)
      try {
        await api.updateAgent({ id, status })
        await refreshAgents()
        showBanner(status === 'active' ? 'Agent 已启用' : 'Agent 已停用（不影响已运行任务）', {
          tone: 'success',
        })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError, showBanner],
  )

  const createSkill = useCallback(
    async (params: SkillCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createSkill(params)
        await refreshSkills()
        showBanner('技能已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshSkills, reportError, showBanner],
  )

  const updateSkill = useCallback(
    async (params: SkillUpdateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.updateSkill(params)
        await refreshSkills()
        // Agent 列表展示技能名称；重命名后需要同步。
        await refreshAgents()
        showBanner('技能已更新', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshSkills, refreshAgents, reportError, showBanner],
  )

  const deleteSkill = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.deleteSkill(id)
        await refreshSkills()
        // 删除会从所有 Agent 的引用中移除该技能。
        await refreshAgents()
        showBanner('技能已删除', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshSkills, refreshAgents, reportError, showBanner],
  )

  const refreshProviderDiscovery = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setProviders(await api.refreshProviders())
      showBanner('Provider 发现已刷新', { tone: 'success' })
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }, [reportError, showBanner])

  const startExecution = useCallback(
    async (agentId: string, prompt: string): Promise<boolean> => {
      setBusy(true)
      try {
        const execution = await api.startExecution(agentId, prompt)
        dispatch({ type: 'executionUpserted', execution })
        dispatch({ type: 'select', executionId: execution.id })
        dispatch({ type: 'logsLoaded', executionId: execution.id, logs: [] })
        await refreshExecutions()
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshExecutions, reportError],
  )

  const selectExecution = useCallback(
    async (executionId: string): Promise<void> => {
      dispatch({ type: 'select', executionId })
      await refreshExecution(executionId)
    },
    [refreshExecution],
  )

  const cancelExecution = useCallback(
    async (executionId: string): Promise<void> => {
      try {
        const execution = await api.cancelExecution(executionId)
        dispatch({ type: 'executionUpserted', execution })
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
  )

  const interruptExecution = useCallback(
    async (executionId: string): Promise<void> => {
      try {
        const interrupted = await api.interruptExecution(executionId)
        showBanner(interrupted ? '已发送中断请求' : '执行已结束，中断未生效', {
          tone: interrupted ? 'success' : 'warn',
        })
      } catch (error) {
        reportError(error)
      }
    },
    [reportError, showBanner],
  )

  const sendMessage = useCallback(
    async (executionId: string, message: string): Promise<boolean> => {
      try {
        await api.sendMessage({ executionId, message })
        return true
      } catch (error) {
        reportError(error)
        return false
      }
    },
    [reportError],
  )

  const createTeam = useCallback(
    async (params: TeamCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createTeam(params)
        await refreshTeams()
        showBanner('团队已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshTeams, reportError, showBanner],
  )

  const updateTeam = useCallback(
    async (params: TeamUpdateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.updateTeam(params)
        await refreshTeams()
        showBanner('团队已更新', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshTeams, reportError, showBanner],
  )

  const archiveTeam = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.archiveTeam(id)
        await refreshTeams()
        showBanner('团队已归档', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshTeams, reportError, showBanner],
  )

  const addTeamMember = useCallback(
    async (params: TeamMemberAddParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.addTeamMember(params)
        await refreshTeamMembers(params.teamId)
        showBanner('成员已加入团队', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshTeamMembers, reportError, showBanner],
  )

  const removeTeamMember = useCallback(
    async (teamId: string, agentId: string): Promise<void> => {
      setBusy(true)
      try {
        await api.removeTeamMember(teamId, agentId)
        await refreshTeamMembers(teamId)
        showBanner('成员已移出团队', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshTeamMembers, reportError, showBanner],
  )

  const createProject = useCallback(
    async (params: ProjectCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createProject(params)
        await refreshProjects()
        showBanner('项目已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshProjects, reportError, showBanner],
  )

  const updateProject = useCallback(
    async (params: ProjectUpdateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.updateProject(params)
        await refreshProjects()
        showBanner('项目已更新', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshProjects, reportError, showBanner],
  )

  const createWork = useCallback(
    async (params: WorkCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createWork(params)
        await refreshWorks()
        showBanner('任务已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError, showBanner],
  )

  const linkWorkTeam = useCallback(
    async (workId: string, teamId: string): Promise<void> => {
      setBusy(true)
      try {
        await api.linkWorkTeam(workId, teamId)
        await refreshWorks()
        showBanner('团队已关联到任务', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError, showBanner],
  )

  const workAction = useCallback(
    async (action: 'activate' | 'pause' | 'resume' | 'complete', id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.workAction(action, id)
        await refreshWorks()
        const label = { activate: '激活', pause: '暂停', resume: '恢复', complete: '完成' }[action]
        showBanner(`任务已${label}`, { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError, showBanner],
  )

  const createAssignment = useCallback(
    async (params: AssignmentCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createAssignment(params)
        await refreshAssignments(params.workId)
        showBanner('Assignment 已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAssignments, reportError, showBanner],
  )

  const assignmentAction = useCallback(
    async (action: 'pause' | 'resume' | 'complete', workId: string, id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.assignmentAction(action, id)
        await refreshAssignments(workId)
        showBanner(
          `Assignment 已${action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '完成'}`,
          { tone: 'success' },
        )
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAssignments, reportError, showBanner],
  )

  const createWorktree = useCallback(
    async (workId: string, branchName: string): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createWorktree(workId, branchName)
        await refreshWorktrees(workId)
        showBanner('Worktree 已创建', { tone: 'success' })
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshWorktrees, reportError, showBanner],
  )

  const removeWorktree = useCallback(
    async (workId: string, id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.removeWorktree(id)
        await refreshWorktrees(workId)
        showBanner('Worktree 已清理', { tone: 'success' })
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorktrees, reportError, showBanner],
  )

  return {
    agents,
    skills,
    teams,
    works,
    projects,
    worktreesByWork,
    teamMembers,
    assignmentsByWork,
    providers,
    consoleState,
    coreHealth,
    daemonHealth,
    busy,
    banner,
    dismissBanner,
    actions: {
      createAgent,
      updateAgent,
      archiveAgent,
      setAgentStatus,
      refreshSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      refreshProviderDiscovery,
      startExecution,
      selectExecution,
      cancelExecution,
      interruptExecution,
      sendMessage,
      refreshExecutions,
      createTeam,
      updateTeam,
      archiveTeam,
      addTeamMember,
      removeTeamMember,
      refreshTeamMembers,
      createProject,
      updateProject,
      refreshProjects,
      createWork,
      refreshWorks,
      linkWorkTeam,
      workAction,
      createAssignment,
      refreshAssignments,
      assignmentAction,
      refreshWorktrees,
      createWorktree,
      removeWorktree,
    },
  }
}

export type AgentraStore = ReturnType<typeof useAgentra>
export type { ConsoleState }
