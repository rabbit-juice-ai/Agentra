import type {
  AgentCreateParams,
  AgentListResult,
  AgentResult,
  AgentUpdateParams,
  AssignmentCreateParams,
  AssignmentIdParams,
  AssignmentListResult,
  AssignmentResult,
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
  TeamArchiveParams,
  TeamCreateParams,
  TeamGetParams,
  TeamListResult,
  TeamMemberAddParams,
  TeamMemberListResult,
  TeamMemberRemoveParams,
  TeamMemberResult,
  TeamResult,
  WorkCreateParams,
  WorkIdParams,
  WorkLinkTeamParams,
  WorkListResult,
  WorkResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListResult,
  WorktreeRemoveParams,
  WorktreeRemoveResult,
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

  // ---- 阶段 2：Team ----
  listTeams(params?: { includeArchived?: boolean }): Promise<RpcResult<TeamListResult>>
  getTeam(params: TeamGetParams): Promise<RpcResult<TeamResult>>
  createTeam(params: TeamCreateParams): Promise<RpcResult<TeamResult>>
  archiveTeam(params: TeamArchiveParams): Promise<RpcResult<TeamResult>>
  listTeamMembers(params: { teamId: string }): Promise<RpcResult<TeamMemberListResult>>
  addTeamMember(params: TeamMemberAddParams): Promise<RpcResult<TeamMemberResult>>
  removeTeamMember(params: TeamMemberRemoveParams): Promise<RpcResult<{ removed: true }>>

  // ---- 阶段 2：Work ----
  listWorks(params?: { includeArchived?: boolean }): Promise<RpcResult<WorkListResult>>
  createWork(params: WorkCreateParams): Promise<RpcResult<WorkResult>>
  linkWorkTeam(params: WorkLinkTeamParams): Promise<RpcResult<WorkResult>>
  activateWork(params: WorkIdParams): Promise<RpcResult<WorkResult>>
  pauseWork(params: WorkIdParams): Promise<RpcResult<WorkResult>>
  resumeWork(params: WorkIdParams): Promise<RpcResult<WorkResult>>
  completeWork(params: WorkIdParams): Promise<RpcResult<WorkResult>>

  // ---- 阶段 2：Assignment ----
  listWorktrees(params: { workId: string }): Promise<RpcResult<WorktreeListResult>>
  createWorktree(params: WorktreeCreateParams): Promise<RpcResult<WorktreeCreateResult>>
  removeWorktree(params: WorktreeRemoveParams): Promise<RpcResult<WorktreeRemoveResult>>

  listAssignments(params: { workId: string }): Promise<RpcResult<AssignmentListResult>>
  createAssignment(params: AssignmentCreateParams): Promise<RpcResult<AssignmentResult>>
  pauseAssignment(params: AssignmentIdParams): Promise<RpcResult<AssignmentResult>>
  resumeAssignment(params: AssignmentIdParams): Promise<RpcResult<AssignmentResult>>
  completeAssignment(params: AssignmentIdParams): Promise<RpcResult<AssignmentResult>>

  /** 订阅 Core 推送的执行事件；返回取消订阅函数。 */
  onEvent(listener: (event: RuntimeEvent) => void): () => void

  /** Core 连接就绪（含重连成功）时回调；renderer 据此补拉首屏数据。 */
  onCoreReady(listener: () => void): () => void
}
