import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  Execution,
  ExecutionLog,
  ExecutionSendMessageParams,
  RuntimeEvent,
  RuntimeProviderRecord,
} from '@agentra/protocol'
import type { RpcResult } from '../../shared/api'

/** Core 返回的业务错误：保留错误码，UI 可据此给出可执行提示。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function unwrap<T>(promise: Promise<RpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new ApiError(result.error.code, result.error.message)
  return result.result
}

/**
 * renderer 的 Core API 封装：组件不直接触碰 window.agentra，
 * 业务调用集中在这里与 hooks 中（AGENTS §2：业务逻辑不写在 React 组件里）。
 */
export const api = {
  listAgents: async (): Promise<AgentProfile[]> =>
    (await unwrap(window.agentra.listAgents({}))).agents,
  createAgent: async (params: AgentCreateParams): Promise<AgentProfile> =>
    (await unwrap(window.agentra.createAgent(params))).agent,
  updateAgent: async (params: AgentUpdateParams): Promise<AgentProfile> =>
    (await unwrap(window.agentra.updateAgent(params))).agent,
  archiveAgent: async (id: string): Promise<AgentProfile> =>
    (await unwrap(window.agentra.archiveAgent({ id }))).agent,

  listProviders: async (): Promise<RuntimeProviderRecord[]> =>
    (await unwrap(window.agentra.listProviders())).providers,
  refreshProviders: async (): Promise<RuntimeProviderRecord[]> =>
    (await unwrap(window.agentra.refreshProviders())).providers,

  startExecution: async (agentId: string, prompt: string): Promise<Execution> =>
    (await unwrap(window.agentra.startExecution({ agentId, prompt }))).execution,
  listExecutions: async (limit = 50): Promise<Execution[]> =>
    (await unwrap(window.agentra.listExecutions({ limit }))).executions,
  getExecution: async (
    executionId: string,
  ): Promise<{ execution: Execution; logs: ExecutionLog[] }> =>
    unwrap(window.agentra.getExecution({ executionId })),
  getLogs: async (executionId: string, afterSequence = 0): Promise<ExecutionLog[]> =>
    (await unwrap(window.agentra.getExecutionLogs({ executionId, afterSequence }))).logs,
  cancelExecution: async (executionId: string): Promise<Execution> =>
    (await unwrap(window.agentra.cancelExecution({ executionId }))).execution,
  interruptExecution: async (executionId: string): Promise<boolean> =>
    (await unwrap(window.agentra.interruptExecution({ executionId }))).interrupted,
  sendMessage: async (params: ExecutionSendMessageParams): Promise<void> => {
    await unwrap(window.agentra.sendExecutionMessage(params))
  },

  onEvent: (listener: (event: RuntimeEvent) => void): (() => void) =>
    window.agentra.onEvent(listener),
}
