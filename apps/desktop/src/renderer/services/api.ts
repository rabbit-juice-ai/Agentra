import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  ApprovalDecideParams,
  AssignmentCreateParams,
  AssignmentStatus,
  Execution,
  ExecutionLog,
  ExecutionSendMessageParams,
  RuntimeEvent,
  RuntimeProviderRecord,
  TeamCreateParams,
  TeamMemberAddParams,
  WorkCreateParams,
  WorkStatus,
} from '@agentra/protocol'
import type { RpcResult } from '../../shared/api'

/** Core 返回的业务错误：保留错误码，UI 可据此给出可执行提示。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Core 的结构化补充信息（如 { violations }），UI 据此逐条展示。 */
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function unwrap<T>(promise: Promise<RpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new ApiError(result.error.code, result.error.message, result.error.detail)
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

  listTeams: async (includeArchived = false) =>
    (await unwrap(window.agentra.listTeams({ includeArchived }))).teams,
  createTeam: async (params: TeamCreateParams) =>
    (await unwrap(window.agentra.createTeam(params))).team,
  listTeamMembers: async (teamId: string) =>
    (await unwrap(window.agentra.listTeamMembers({ teamId }))).members,
  addTeamMember: async (params: TeamMemberAddParams) =>
    (await unwrap(window.agentra.addTeamMember(params))).member,

  listWorks: async (includeArchived = false) =>
    (await unwrap(window.agentra.listWorks({ includeArchived }))).works,
  createWork: async (params: WorkCreateParams) =>
    (await unwrap(window.agentra.createWork(params))).work,
  linkWorkTeam: async (workId: string, teamId: string) =>
    (await unwrap(window.agentra.linkWorkTeam({ workId, teamId }))).work,
  workAction: async (
    action: 'activate' | 'pause' | 'resume' | 'complete',
    id: string,
  ): Promise<{ id: string; status: WorkStatus }> => {
    const call = {
      activate: window.agentra.activateWork,
      pause: window.agentra.pauseWork,
      resume: window.agentra.resumeWork,
      complete: window.agentra.completeWork,
    }[action]
    return (await unwrap(call({ id }))).work
  },

  listWorktrees: async (workId: string) =>
    (await unwrap(window.agentra.listWorktrees({ workId }))).worktrees,
  createWorktree: async (workId: string, branchName: string) =>
    (await unwrap(window.agentra.createWorktree({ workId, branchName }))).worktree,
  removeWorktree: async (id: string) =>
    (await unwrap(window.agentra.removeWorktree({ id, confirm: true }))).worktree,

  listAssignments: async (workId: string) =>
    (await unwrap(window.agentra.listAssignments({ workId }))).assignments,
  createAssignment: async (params: AssignmentCreateParams) =>
    (await unwrap(window.agentra.createAssignment(params))).assignment,
  assignmentAction: async (
    action: 'pause' | 'resume' | 'complete',
    id: string,
  ): Promise<{ id: string; status: AssignmentStatus }> => {
    const call = {
      pause: window.agentra.pauseAssignment,
      resume: window.agentra.resumeAssignment,
      complete: window.agentra.completeAssignment,
    }[action]
    return (await unwrap(call({ id }))).assignment
  },

  // 阶段 5 S5-3：审批中心 + 运行态查询。
  listPendingApprovals: async (runId: string) =>
    (await unwrap(window.agentra.listPendingApprovals({ runId }))).approvals,
  decideApproval: async (params: ApprovalDecideParams) =>
    (await unwrap(window.agentra.decideApproval(params))).approval,
  getApproval: async (nodeRunId: string) => await unwrap(window.agentra.getApproval({ nodeRunId })),
  getWorkflowRun: async (runId: string) => await unwrap(window.agentra.getWorkflowRun({ runId })),
  listWorkflowRunsByWork: async (workId: string) =>
    (await unwrap(window.agentra.listWorkflowRunsByWork({ workId }))).runs,
  listArtifacts: async (workId: string) =>
    (await unwrap(window.agentra.listArtifacts({ workId }))).artifacts,
  previewArtifact: async (artifactId: string, version?: number) =>
    await unwrap(window.agentra.previewArtifact({ artifactId, version })),

  onEvent: (listener: (event: RuntimeEvent) => void): (() => void) =>
    window.agentra.onEvent(listener),

  onCoreReady: (listener: () => void): (() => void) => window.agentra.onCoreReady(listener),
}
