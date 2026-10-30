import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  HealthResult,
  RuntimeProvider,
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
  const [providers, setProviders] = useState<RuntimeProvider[]>([])
  const [consoleState, dispatch] = useReducer(consoleReducer, initialConsoleState)
  const [coreHealth, setCoreHealth] = useState<HealthResult | null>(null)
  const [daemonHealth, setDaemonHealth] = useState<HealthResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const reportError = useCallback((error: unknown) => {
    if (error instanceof ApiError) setBanner(`${error.code}: ${error.message}`)
    else setBanner(error instanceof Error ? error.message : String(error))
  }, [])

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

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
    const timer = setInterval(() => {
      void refreshHealth()
      void refreshExecutions()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshAgents, refreshProviders, refreshExecutions, refreshHealth])

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

  return {
    agents,
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
      refreshProviderDiscovery,
      startExecution,
      selectExecution,
      cancelExecution,
      interruptExecution,
      sendMessage,
      refreshExecutions,
    },
  }
}

export type AgentraStore = ReturnType<typeof useAgentra>
export type { ConsoleState }
