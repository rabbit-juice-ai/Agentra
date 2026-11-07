import type {
  AgentCreateParams,
  AgentGenerateDraftParams,
  AgentGenerateDraftResult,
  AgentListResult,
  AgentResult,
  AgentUpdateParams,
  ApprovalDecideParams,
  ApprovalGetParams,
  ApprovalGetResult,
  ApprovalListPendingParams,
  ApprovalListPendingResult,
  ApprovalResult,
  ArtifactListParams,
  ArtifactListResult,
  ArtifactPreviewParams,
  ArtifactPreviewResult,
  AssignmentCreateParams,
  AssignmentIdParams,
  AssignmentListResult,
  AssignmentResult,
  Backup,
  BackupRestoreAccepted,
  BackupRestoreParams,
  BackupRestorePrecheckResult,
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
  PlanApproveParams,
  PlanCommentParams,
  PlanCommentResult,
  PlanConvertToProjectParams,
  PlanConvertToProjectResult,
  PlanConvertToTaskParams,
  PlanConvertToTaskResult,
  PlanDecisionResult,
  PlanGenerateParams,
  PlanGenerateResult,
  PlanGetParams,
  PlanGetResult,
  PlanListByWorkParams,
  PlanListByWorkResult,
  PlanListRecentParams,
  PlanListRecentResult,
  PlanReassignTaskParams,
  PlanReassignTaskResult,
  PlanRejectParams,
  PlanReworkActionParams,
  PlanReworkActionResult,
  PlanStartRunParams,
  PlanStartRunResult,
  PlanThreadListParams,
  PlanThreadListResult,
  ProjectCreateParams,
  ProjectGetParams,
  ProjectListResult,
  ProjectResult,
  ProjectUpdateParams,
  RestoreStatusParams,
  RestoreStatusResult,
  RuntimeEvent,
  RuntimeProviderListResult,
  RuntimeProviderModelsParams,
  RuntimeProviderModelsResult,
  SkillCreateParams,
  SkillDeleteResult,
  SkillListResult,
  SkillResult,
  SkillUpdateParams,
  TeamArchiveParams,
  TeamCreateParams,
  TeamGetParams,
  TeamListResult,
  TeamMemberAddParams,
  TeamMemberListResult,
  TeamMemberRemoveParams,
  TeamMemberResult,
  TeamResult,
  TeamUpdateParams,
  WorkCreateParams,
  WorkflowRunGetParams,
  WorkflowRunGetResult,
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
  | { ok: false; error: { code: string; message: string; detail?: unknown } }

// ---- 阶段 5.5 S55-1B：备份中心 RPC 超时策略 ----
// create/export 可能执行 VACUUM INTO 或复制大量文件，单独放宽到 120s；
// precheck 需要复制/哈希数据库与 Artifact，同样放宽；list 保持默认 15s。
export const BACKUP_CREATE_TIMEOUT_MS = 120_000
export const BACKUP_EXPORT_TIMEOUT_MS = 120_000
export const BACKUP_PRECHECK_TIMEOUT_MS = 120_000
export const BACKUP_LIST_DEFAULT_LIMIT = 50

/** Planner 会等待本地 CLI 完成规划，单独放宽 IPC 超时。 */
export const PLAN_GENERATE_TIMEOUT_MS = 120_000
export const PLAN_START_RUN_TIMEOUT_MS = 60_000
export const PLAN_REASSIGN_TIMEOUT_MS = 30_000

/** Provider 模型读取需要启动一次 CLI 子进程，放宽 IPC/Daemon 超时。 */
export const PROVIDER_MODELS_TIMEOUT_MS = 25_000
/** AI 生成 Agent 草案会等待一次本地 CLI 执行。 */
export const AGENT_GENERATE_DRAFT_TIMEOUT_MS = 120_000

export function backupRpcTimeoutMs(
  operation: 'create' | 'list' | 'export' | 'precheck',
): number | undefined {
  if (operation === 'create') return BACKUP_CREATE_TIMEOUT_MS
  if (operation === 'export') return BACKUP_EXPORT_TIMEOUT_MS
  if (operation === 'precheck') return BACKUP_PRECHECK_TIMEOUT_MS
  return undefined
}

export type BackupCreateResult = { backup: Backup }
export type BackupListResult = { backups: Backup[] }
export type BackupExportResult = { target: string }
export type BackupListParams = { limit?: number }
export type BackupExportParams = { backupId: string; targetDir: string }
export type BackupRestorePrecheckParams = { backupId: string }

/**
 * Preload 暴露给 renderer 的最小 API 白名单。
 * 所有业务调用都经 Core RPC；Desktop 不直接访问数据库或 spawn CLI。
 */
export type AgentraApi = {
  getCoreHealth(): Promise<RpcResult<HealthResult>>
  getDaemonHealth(): Promise<RpcResult<HealthResult>>
  getAppInfo(): Promise<{ version: string; dataDir: string }>
  openDataDir(): Promise<{ path: string; error: string | null }>

  listAgents(params?: { includeArchived?: boolean }): Promise<RpcResult<AgentListResult>>
  createAgent(params: AgentCreateParams): Promise<RpcResult<AgentResult>>
  updateAgent(params: AgentUpdateParams): Promise<RpcResult<AgentResult>>
  archiveAgent(params: { id: string }): Promise<RpcResult<AgentResult>>
  generateAgentDraft(params: AgentGenerateDraftParams): Promise<RpcResult<AgentGenerateDraftResult>>

  listProviders(): Promise<RpcResult<RuntimeProviderListResult>>
  refreshProviders(): Promise<RpcResult<RuntimeProviderListResult>>
  listProviderModels(
    params: RuntimeProviderModelsParams,
  ): Promise<RpcResult<RuntimeProviderModelsResult>>

  listSkills(): Promise<RpcResult<SkillListResult>>
  createSkill(params: SkillCreateParams): Promise<RpcResult<SkillResult>>
  updateSkill(params: SkillUpdateParams): Promise<RpcResult<SkillResult>>
  deleteSkill(params: { id: string }): Promise<RpcResult<SkillDeleteResult>>

  generatePlan(params: PlanGenerateParams): Promise<RpcResult<PlanGenerateResult>>
  getPlan(params: PlanGetParams): Promise<RpcResult<PlanGetResult>>
  listPlansByWork(params: PlanListByWorkParams): Promise<RpcResult<PlanListByWorkResult>>
  listRecentPlans(params?: PlanListRecentParams): Promise<RpcResult<PlanListRecentResult>>
  convertPlanToTask(params: PlanConvertToTaskParams): Promise<RpcResult<PlanConvertToTaskResult>>
  convertPlanToProject(
    params: PlanConvertToProjectParams,
  ): Promise<RpcResult<PlanConvertToProjectResult>>
  approvePlan(params: PlanApproveParams): Promise<RpcResult<PlanDecisionResult>>
  rejectPlan(params: PlanRejectParams): Promise<RpcResult<PlanDecisionResult>>
  startPlanRun(params: PlanStartRunParams): Promise<RpcResult<PlanStartRunResult>>
  listPlanThreads(params: PlanThreadListParams): Promise<RpcResult<PlanThreadListResult>>
  commentOnPlan(params: PlanCommentParams): Promise<RpcResult<PlanCommentResult>>
  reassignPlanTask(params: PlanReassignTaskParams): Promise<RpcResult<PlanReassignTaskResult>>
  continuePlanRework(params: PlanReworkActionParams): Promise<RpcResult<PlanReworkActionResult>>
  takeOverPlanRework(params: PlanReworkActionParams): Promise<RpcResult<PlanReworkActionResult>>

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
  updateTeam(params: TeamUpdateParams): Promise<RpcResult<TeamResult>>
  archiveTeam(params: TeamArchiveParams): Promise<RpcResult<TeamResult>>
  listTeamMembers(params: { teamId: string }): Promise<RpcResult<TeamMemberListResult>>
  addTeamMember(params: TeamMemberAddParams): Promise<RpcResult<TeamMemberResult>>
  removeTeamMember(params: TeamMemberRemoveParams): Promise<RpcResult<{ removed: true }>>

  // ---- 阶段 2：Work ----
  listProjects(): Promise<RpcResult<ProjectListResult>>
  getProject(params: ProjectGetParams): Promise<RpcResult<ProjectResult>>
  createProject(params: ProjectCreateParams): Promise<RpcResult<ProjectResult>>
  updateProject(params: ProjectUpdateParams): Promise<RpcResult<ProjectResult>>
  listWorks(params?: {
    includeArchived?: boolean
    projectId?: string
  }): Promise<RpcResult<WorkListResult>>
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

  // 阶段 5 S5-3：审批中心 + 运行态查询（无执行入口）。
  decideApproval(params: ApprovalDecideParams): Promise<RpcResult<ApprovalResult>>
  getApproval(params: ApprovalGetParams): Promise<RpcResult<ApprovalGetResult>>
  listPendingApprovals(
    params: ApprovalListPendingParams,
  ): Promise<RpcResult<ApprovalListPendingResult>>
  getWorkflowRun(params: WorkflowRunGetParams): Promise<RpcResult<WorkflowRunGetResult>>
  listArtifacts(params: ArtifactListParams): Promise<RpcResult<ArtifactListResult>>
  previewArtifact(params: ArtifactPreviewParams): Promise<RpcResult<ArtifactPreviewResult>>

  // ---- 阶段 5.5 S55-1B：备份中心（创建固定 manual；恢复/删除不在本阶段） ----
  createBackup(): Promise<RpcResult<BackupCreateResult>>
  listBackups(params?: BackupListParams): Promise<RpcResult<BackupListResult>>
  exportBackup(params: BackupExportParams): Promise<RpcResult<BackupExportResult>>

  // ---- 阶段 5.5 S55-2A：恢复预检（只读） ----
  restorePrecheck(
    params: BackupRestorePrecheckParams,
  ): Promise<RpcResult<BackupRestorePrecheckResult>>

  // ---- 阶段 5.5 S55-2C：恢复执行（异步受理）与状态查询（只读；UI 在 2E） ----
  restoreBackup(params: BackupRestoreParams): Promise<RpcResult<BackupRestoreAccepted>>
  getRestoreStatus(params?: RestoreStatusParams): Promise<RpcResult<RestoreStatusResult>>

  /** 订阅 Core 推送的执行事件；返回取消订阅函数。 */
  onEvent(listener: (event: RuntimeEvent) => void): () => void

  /** Core 连接就绪（含重连成功）时回调；renderer 据此补拉首屏数据。 */
  onCoreReady(listener: () => void): () => void
}
