import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  Assignment,
  AssignmentCreateParams,
  HealthResult,
  RuntimeProviderRecord,
  Team,
  TeamCreateParams,
  TeamMember,
  TeamMemberAddParams,
  Work,
  WorkCreateParams,
  Worktree,
} from '@agentra/protocol'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { ApiError, api } from '../services/api'
import {
  type ConsoleState,
  consoleReducer,
  initialConsoleState,
  terminalExecutionId,
} from '../state/console-reducer'

const POLL_INTERVAL_MS = 5000

/**
 * 全部数据获取与状态推导集中在这里：组件只消费状态、调用 actions。
 * Desktop 只经 Core RPC（AGENTS §2）。
 */
export function useAgentra() {
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [works, setWorks] = useState<Work[]>([])
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember[]>>({})
  const [assignmentsByWork, setAssignmentsByWork] = useState<Record<string, Assignment[]>>({})
  const [worktreesByWork, setWorktreesByWork] = useState<Record<string, Worktree[]>>({})
  const [providers, setProviders] = useState<RuntimeProviderRecord[]>([])
  const [consoleState, dispatch] = useReducer(consoleReducer, initialConsoleState)
  const [coreHealth, setCoreHealth] = useState<HealthResult | null>(null)
  const [daemonHealth, setDaemonHealth] = useState<HealthResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const reportError = useCallback((error: unknown) => {
    if (error instanceof ApiError) {
      // 阶段 5 第 181 行：CLI 不可用/未认证是用户可自行修复的状态，
      // banner 给出可执行的提示，而不是只透传错误码（Core 拦截在阶段 1 已实现）。
      if (error.code === 'CLI_UNAVAILABLE') {
        setBanner(
          'CLI 不可用：未发现可用的 Claude Code 可执行文件。请安装 Claude Code（或设置 AGENTRA_CLAUDE_PATH 指向可执行文件）后重试。',
        )
        return
      }
      if (error.code === 'CLI_NOT_AUTHENTICATED') {
        setBanner(
          'CLI 未认证：已找到 Claude Code 但登录态不可用。请在终端执行登录命令（Provider 面板可复制）后重试。',
        )
        return
      }
      setBanner(`${error.code}: ${error.message}`)
      return
    }
    setBanner(error instanceof Error ? error.message : String(error))
  }, [])

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
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
    void refreshProviders()
    void refreshExecutions()
    void refreshHealth()
    void refreshTeams()
    void refreshWorks()
    const timer = setInterval(() => {
      void refreshHealth()
      void refreshExecutions()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [
    refreshAgents,
    refreshProviders,
    refreshExecutions,
    refreshHealth,
    refreshTeams,
    refreshWorks,
  ])

  // Core 就绪（含重连）后补拉首屏数据：启动时 renderer 常先于 Core 就绪，首拉会撞 NOT_READY，
  // 而 agents / providers 没有轮询，不补拉就会一直是空列表。
  useEffect(() => {
    return api.onCoreReady(() => {
      void refreshAgents()
      void refreshProviders()
      void refreshExecutions()
      void refreshHealth()
      void refreshTeams()
      void refreshWorks()
      setBanner((current) => (current?.includes('NOT_READY') ? null : current))
    })
  }, [
    refreshAgents,
    refreshProviders,
    refreshExecutions,
    refreshHealth,
    refreshTeams,
    refreshWorks,
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
        setBanner('Agent 已创建')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError],
  )

  const updateAgent = useCallback(
    async (params: AgentUpdateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.updateAgent(params)
        await refreshAgents()
        setBanner('Agent 已更新')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError],
  )

  const archiveAgent = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.archiveAgent(id)
        await refreshAgents()
        setBanner('Agent 已归档')
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError],
  )

  const setAgentStatus = useCallback(
    async (id: string, status: 'active' | 'disabled'): Promise<void> => {
      setBusy(true)
      try {
        await api.updateAgent({ id, status })
        await refreshAgents()
        setBanner(status === 'active' ? 'Agent 已启用' : 'Agent 已停用（不影响已运行任务）')
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAgents, reportError],
  )

  const refreshProviderDiscovery = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setProviders(await api.refreshProviders())
      setBanner('Provider 发现已刷新')
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }, [reportError])

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
        setBanner(interrupted ? '已发送中断请求' : '执行已结束，中断未生效')
      } catch (error) {
        reportError(error)
      }
    },
    [reportError],
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
        setBanner('Team 已创建')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshTeams, reportError],
  )

  const addTeamMember = useCallback(
    async (params: TeamMemberAddParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.addTeamMember(params)
        await refreshTeamMembers(params.teamId)
        setBanner('成员已加入 Team')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshTeamMembers, reportError],
  )

  const createWork = useCallback(
    async (params: WorkCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createWork(params)
        await refreshWorks()
        setBanner('Work 已创建')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError],
  )

  const linkWorkTeam = useCallback(
    async (workId: string, teamId: string): Promise<void> => {
      setBusy(true)
      try {
        await api.linkWorkTeam(workId, teamId)
        await refreshWorks()
        setBanner('Team 已关联到 Work')
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError],
  )

  const workAction = useCallback(
    async (action: 'activate' | 'pause' | 'resume' | 'complete', id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.workAction(action, id)
        await refreshWorks()
        const label = { activate: '激活', pause: '暂停', resume: '恢复', complete: '完成' }[action]
        setBanner(`Work 已${label}`)
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorks, reportError],
  )

  const createAssignment = useCallback(
    async (params: AssignmentCreateParams): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createAssignment(params)
        await refreshAssignments(params.workId)
        setBanner('Assignment 已创建')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshAssignments, reportError],
  )

  const assignmentAction = useCallback(
    async (action: 'pause' | 'resume' | 'complete', workId: string, id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.assignmentAction(action, id)
        await refreshAssignments(workId)
        setBanner(
          `Assignment 已${action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '完成'}`,
        )
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshAssignments, reportError],
  )

  const createWorktree = useCallback(
    async (workId: string, branchName: string): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createWorktree(workId, branchName)
        await refreshWorktrees(workId)
        setBanner('Worktree 已创建')
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refreshWorktrees, reportError],
  )

  const removeWorktree = useCallback(
    async (workId: string, id: string): Promise<void> => {
      setBusy(true)
      try {
        await api.removeWorktree(id)
        await refreshWorktrees(workId)
        setBanner('Worktree 已清理')
      } catch (error) {
        reportError(error)
      } finally {
        setBusy(false)
      }
    },
    [refreshWorktrees, reportError],
  )

  return {
    agents,
    teams,
    works,
    worktreesByWork,
    teamMembers,
    assignmentsByWork,
    providers,
    consoleState,
    coreHealth,
    daemonHealth,
    busy,
    banner,
    dismissBanner: () => setBanner(null),
    actions: {
      createAgent,
      updateAgent,
      archiveAgent,
      setAgentStatus,
      refreshProviderDiscovery,
      startExecution,
      selectExecution,
      cancelExecution,
      interruptExecution,
      sendMessage,
      refreshExecutions,
      createTeam,
      addTeamMember,
      refreshTeamMembers,
      createWork,
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
