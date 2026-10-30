import type {
  AgentCreateParams,
  AgentListResult,
  AgentResult,
  AgentUpdateParams,
  ExecutionGetResult,
  ExecutionInterruptResult,
  ExecutionListResult,
  ExecutionLogsParams,
  ExecutionLogsResult,
  ExecutionResult,
  ExecutionSendMessageParams,
  ExecutionSendMessageResult,
  ExecutionStartParams,
  HealthResult,
  RuntimeEvent,
  RuntimeProviderListResult,
} from '@agentra/protocol'

/** Desktop 主进程 ↔ renderer 的唯一结果形态（错误码原样透传 Core）。 */
export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } }

/**
 * Preload 暴露给 renderer 的最小 API 白名单。
 * 所有业务调用都经 Core RPC；Desktop 不直接访问数据库或 spawn CLI。
 */
export type AgentraApi = {
  getCoreHealth(): Promise<RpcResult<HealthResult>>
  getDaemonHealth(): Promise<RpcResult<HealthResult>>

  listAgents(params?: { includeArchived?: boolean }): Promise<RpcResult<AgentListResult>>
  createAgent(params: AgentCreateParams): Promise<RpcResult<AgentResult>>
  updateAgent(params: AgentUpdateParams): Promise<RpcResult<AgentResult>>
  archiveAgent(params: { id: string }): Promise<RpcResult<AgentResult>>

  listProviders(): Promise<RpcResult<RuntimeProviderListResult>>
  refreshProviders(): Promise<RpcResult<RuntimeProviderListResult>>

  startExecution(params: ExecutionStartParams): Promise<RpcResult<ExecutionResult>>
  getExecution(params: { executionId: string }): Promise<RpcResult<ExecutionGetResult>>
  listExecutions(params?: { limit?: number }): Promise<RpcResult<ExecutionListResult>>
  getExecutionLogs(params: ExecutionLogsParams): Promise<RpcResult<ExecutionLogsResult>>
  cancelExecution(params: { executionId: string }): Promise<RpcResult<ExecutionResult>>
  interruptExecution(params: { executionId: string }): Promise<RpcResult<ExecutionInterruptResult>>
  sendExecutionMessage(
    params: ExecutionSendMessageParams,
  ): Promise<RpcResult<ExecutionSendMessageResult>>

  /** 订阅 Core 推送的执行事件；返回取消订阅函数。 */
  onEvent(listener: (event: RuntimeEvent) => void): () => void

  /** Core 连接就绪（含重连成功）时回调；renderer 据此补拉首屏数据。 */
  onCoreReady(listener: () => void): () => void
}
