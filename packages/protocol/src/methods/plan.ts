import { z } from 'zod'
import { AgentAccessMode, AgentProfile, IsoTimestamp, Work } from '../dto'
import { Project } from './project'
import { WorkflowRun } from './workflow'

export const PLAN_GENERATE_METHOD = 'plan.generate'
export const PLAN_CREATE_DRAFT_METHOD = 'plan.createDraft'
export const PLAN_GET_METHOD = 'plan.get'
export const PLAN_LIST_BY_WORK_METHOD = 'plan.listByWork'
export const PLAN_LIST_RECENT_METHOD = 'plan.listRecent'
export const PLAN_APPROVE_METHOD = 'plan.approve'
export const PLAN_REJECT_METHOD = 'plan.reject'
export const PLAN_START_RUN_METHOD = 'plan.startRun'
export const PLAN_THREAD_LIST_METHOD = 'plan.thread.list'
export const PLAN_COMMENT_METHOD = 'plan.comment'
export const PLAN_REASSIGN_TASK_METHOD = 'plan.reassignTask'
export const PLAN_CONTINUE_REWORK_METHOD = 'plan.continueRework'
export const PLAN_TAKE_OVER_REWORK_METHOD = 'plan.takeOverRework'
export const PLAN_CONVERT_TO_TASK_METHOD = 'plan.convertToTask'
export const PLAN_CONVERT_TO_PROJECT_METHOD = 'plan.convertToProject'
export const PLAN_DISPATCH_METHOD = 'plan.dispatch'
export const PLAN_ASSIGN_TASK_METHOD = 'plan.assignTask'
export const PLANNER_ENSURE_METHOD = 'planner.ensure'

const TaskKey = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'must match [a-z0-9_-]{1,64}')
const CapabilityTag = z.string().min(1).max(64)

/**
 * Planner 的结构化输出。任务 key 会成为工作流节点 key；
 * verification 表示该任务验收哪些任务，供 PlanCompiler 生成 test_result + condition/rework。
 */
export const PlanTask = z.object({
  key: TaskKey,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  /** 责任角色，如 product / frontend / backend / testing。 */
  responsibilityRole: z.string().min(1).max(64),
  /**
   * 该任务要求的工作权限；选人按此严格匹配：
   * analyze 任务只能交给只读分析 Agent，edit 任务只能交给可编辑 Agent。
   */
  requiredAccessMode: AgentAccessMode.default('edit'),
  /**
   * 任务归属团队；null 表示个人任务，由 Planner 建议、StartRun 直接建 Assignment。
   * 团队任务的最终执行成员由该团队队长在批准后派工产生。
   */
  teamId: z.string().min(1).max(128).nullable().default(null),
  /** Planner 建议的负责人；必须是 Registry 中真实 active 的 Agent，或 null。 */
  suggestedAgentId: z.string().min(1).max(128).nullable().default(null),
  inputs: z.array(z.string().max(200)).max(20).default([]),
  outputs: z.array(z.string().max(200)).max(20).default([]),
  acceptanceCriteria: z.array(z.string().max(500)).max(20).default([]),
  dependsOn: z.array(TaskKey).max(20).default([]),
  parallelGroup: z.string().min(1).max(64).nullable().default(null),
  approvalRequired: z.boolean().default(false),
  verification: z
    .object({ verifies: z.array(TaskKey).min(1).max(20) })
    .nullable()
    .default(null),
})
export type PlanTask = z.infer<typeof PlanTask>

export const PlanCapabilityGap = z.object({
  role: z.string().min(1).max(64),
  missingCapabilities: z.array(CapabilityTag).max(20).default([]),
  reason: z.string().min(1).max(500),
})
export type PlanCapabilityGap = z.infer<typeof PlanCapabilityGap>

export const PlanDraft = z.object({
  agentraPlanVersion: z.literal(1),
  goal: z.string().min(1).max(20_000),
  constraints: z.array(z.string().max(500)).max(50).default([]),
  tasks: z.array(PlanTask).min(1).max(40),
  risks: z.array(z.string().max(500)).max(30).default([]),
  capabilityGaps: z.array(PlanCapabilityGap).max(20).default([]),
  approvalsRequired: z.array(z.string().max(200)).max(20).default([]),
})
export type PlanDraft = z.infer<typeof PlanDraft>

export const PlanViolation = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  taskKey: z.string().min(1).optional(),
})
export type PlanViolation = z.infer<typeof PlanViolation>

export const PlanAssignment = z.object({
  taskKey: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  agentName: z.string().min(1).nullable(),
})
export type PlanAssignment = z.infer<typeof PlanAssignment>

export const PlanValidationResult = z.object({
  valid: z.boolean(),
  violations: z.array(PlanViolation),
  assignments: z.array(PlanAssignment),
})
export type PlanValidationResult = z.infer<typeof PlanValidationResult>

export const PlanGenerateParams = z
  .object({
    goal: z.string().min(1).max(20_000),
    workId: z.string().min(1).optional(),
    constraints: z.array(z.string().max(500)).max(50).optional(),
    /** ai：调用 Planner Agent；fast：不调用模型，按能力匹配生成草稿。 */
    mode: z.enum(['ai', 'fast']).default('ai'),
  })
  .strict()
export type PlanGenerateParams = z.infer<typeof PlanGenerateParams>

export const PlanCreateDraftParams = z
  .object({
    workId: z.string().min(1).optional(),
    goal: z.string().min(1).max(20_000),
    plan: PlanDraft,
  })
  .strict()
export type PlanCreateDraftParams = z.infer<typeof PlanCreateDraftParams>

export const PlannerDraftResult = z.object({
  plan: PlanDraft,
  validation: PlanValidationResult,
  plannerExecutionId: z.string().min(1).nullable(),
  source: z.enum(['planner', 'fallback']),
  fallbackReason: z.string().nullable().default(null),
})
export type PlannerDraftResult = z.infer<typeof PlannerDraftResult>

export const PlanStatus = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type PlanStatus = z.infer<typeof PlanStatus>

export const PlanRecord = z.object({
  id: z.string().min(1),
  workId: z.string().min(1).nullable(),
  goal: z.string().min(1),
  status: PlanStatus,
  currentVersion: z.number().int().min(1),
  workflowVersionId: z.string().min(1).nullable(),
  workflowRunId: z.string().min(1).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  approvedAt: IsoTimestamp.nullable(),
  approvedBy: z.string().min(1).nullable(),
})
export type PlanRecord = z.infer<typeof PlanRecord>

export const PlanVersion = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  version: z.number().int().min(1),
  plan: PlanDraft,
  validation: PlanValidationResult,
  assignments: z.array(PlanAssignment),
  checksum: z.string().min(1),
  status: PlanStatus,
  source: z.enum(['planner', 'fallback']),
  fallbackReason: z.string().nullable(),
  createdAt: IsoTimestamp,
  approvedAt: IsoTimestamp.nullable(),
  approvedBy: z.string().min(1).nullable(),
})
export type PlanVersion = z.infer<typeof PlanVersion>

/** 计划任务的权威成员：启动前由队长派工或老板改派产生；旧计划由 legacy seed 产生。 */
export const PlanTaskAssignmentSource = z.enum(['planner', 'leader', 'user', 'legacy'])
export type PlanTaskAssignmentSource = z.infer<typeof PlanTaskAssignmentSource>

export const PlanTaskAssignmentStatus = z.enum(['active', 'superseded'])
export type PlanTaskAssignmentStatus = z.infer<typeof PlanTaskAssignmentStatus>

export const PlanTaskAssignment = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  planVersionId: z.string().min(1),
  taskKey: z.string().min(1),
  teamId: z.string().min(1).nullable(),
  agentId: z.string().min(1),
  agentName: z.string().nullable(),
  source: PlanTaskAssignmentSource,
  assignedBy: z.string().min(1),
  reason: z.string().nullable(),
  status: PlanTaskAssignmentStatus,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type PlanTaskAssignment = z.infer<typeof PlanTaskAssignment>

/** 每个 plan_version + team 的队长派工执行状态。 */
export const PlanDispatchStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled'])
export type PlanDispatchStatus = z.infer<typeof PlanDispatchStatus>

export const PlanDispatch = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  planVersionId: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().nullable(),
  leaderAgentId: z.string().min(1).nullable(),
  leaderAgentName: z.string().nullable(),
  status: PlanDispatchStatus,
  attempt: z.number().int().min(1),
  executionId: z.string().min(1).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type PlanDispatch = z.infer<typeof PlanDispatch>

export const PlanStartAttemptStatus = z.enum([
  'preparing',
  'starting',
  'running',
  'failed',
  'cancelled',
])
export type PlanStartAttemptStatus = z.infer<typeof PlanStartAttemptStatus>

export const PlanStartAttempt = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  planVersionId: z.string().min(1),
  requestId: z.string().min(1),
  status: PlanStartAttemptStatus,
  workflowVersionId: z.string().min(1).nullable(),
  workflowRunId: z.string().min(1).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type PlanStartAttempt = z.infer<typeof PlanStartAttempt>

export const PlanReadinessState = z.enum([
  'pending_approval',
  'rejected',
  'pending_dispatch',
  'dispatching',
  'dispatch_failed',
  'ready',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type PlanReadinessState = z.infer<typeof PlanReadinessState>

/** 只读派生：UI 的「待派工 / 派工中 / 待启动 / 已就绪」均来自这里，不写 PlanStatus。 */
export const PlanReadiness = z.object({
  state: PlanReadinessState,
  canStart: z.boolean(),
  reason: z.string().nullable(),
  totalTasks: z.number().int().min(0),
  assignedTasks: z.number().int().min(0),
  teamTasks: z.number().int().min(0),
  assignedTeamTasks: z.number().int().min(0),
  /** 旧计划没有 PlanTaskAssignment，启动时从 version.assignments seed。 */
  legacy: z.boolean().default(false),
  dispatches: z.array(PlanDispatch).default([]),
  startAttempt: PlanStartAttempt.nullable().default(null),
})
export type PlanReadiness = z.infer<typeof PlanReadiness>

export const PlanThread = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  taskKey: z.string().min(1),
  createdAt: IsoTimestamp,
})
export type PlanThread = z.infer<typeof PlanThread>

export const PlanComment = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  authorType: z.enum(['user', 'agent', 'system']),
  authorId: z.string().min(1),
  content: z.string().min(1),
  createdAt: IsoTimestamp,
  runId: z.string().min(1).nullable(),
})
export type PlanComment = z.infer<typeof PlanComment>

export const PlanThreadView = z.object({
  thread: PlanThread,
  comments: z.array(PlanComment),
})
export type PlanThreadView = z.infer<typeof PlanThreadView>

export const PlanGenerateResult = PlannerDraftResult.extend({
  planId: z.string().min(1),
  planVersionId: z.string().min(1),
  status: PlanStatus,
})
export type PlanGenerateResult = z.infer<typeof PlanGenerateResult>

export const PlanGetParams = z.object({ planId: z.string().min(1) }).strict()
export type PlanGetParams = z.infer<typeof PlanGetParams>

export const PlanGetResult = z.object({
  plan: PlanRecord,
  version: PlanVersion,
  threads: z.array(PlanThreadView),
  taskAssignments: z.array(PlanTaskAssignment).default([]),
  readiness: PlanReadiness.nullable().default(null),
})
export type PlanGetResult = z.infer<typeof PlanGetResult>

export const PlanListByWorkParams = z.object({ workId: z.string().min(1) }).strict()
export type PlanListByWorkParams = z.infer<typeof PlanListByWorkParams>

export const PlanListByWorkResult = z.object({ plans: z.array(PlanRecord) })
export type PlanListByWorkResult = z.infer<typeof PlanListByWorkResult>

export const PlanListRecentParams = z
  .object({ limit: z.number().int().min(1).max(100).optional() })
  .strict()
export type PlanListRecentParams = z.infer<typeof PlanListRecentParams>

export const PlanListRecentResult = z.object({ plans: z.array(PlanRecord) })
export type PlanListRecentResult = z.infer<typeof PlanListRecentResult>

export const PlanApproveParams = z
  .object({ planId: z.string().min(1), decidedBy: z.string().min(1) })
  .strict()
export type PlanApproveParams = z.infer<typeof PlanApproveParams>

export const PlanRejectParams = z
  .object({
    planId: z.string().min(1),
    decidedBy: z.string().min(1),
    comment: z.string().max(20_000).optional(),
  })
  .strict()
export type PlanRejectParams = z.infer<typeof PlanRejectParams>

export const PlanDecisionResult = z.object({
  plan: PlanRecord,
  version: PlanVersion,
})
export type PlanDecisionResult = z.infer<typeof PlanDecisionResult>

export const PlanStartRunParams = z
  .object({ planId: z.string().min(1), requestId: z.string().uuid().optional() })
  .strict()
export type PlanStartRunParams = z.infer<typeof PlanStartRunParams>

export const PlanStartRunResult = z.object({
  plan: PlanRecord,
  run: WorkflowRun,
  schedulingError: z.string().nullable().default(null),
})
export type PlanStartRunResult = z.infer<typeof PlanStartRunResult>

export const PlanDispatchParams = z.object({ planId: z.string().min(1) }).strict()
export type PlanDispatchParams = z.infer<typeof PlanDispatchParams>

export const PlanDispatchResult = z.object({
  plan: PlanRecord,
  dispatches: z.array(PlanDispatch),
  readiness: PlanReadiness.nullable().default(null),
})
export type PlanDispatchResult = z.infer<typeof PlanDispatchResult>

/** 启动前老板改派：写 active PlanTaskAssignment，不触碰运行中的 Run。 */
export const PlanAssignTaskParams = z
  .object({
    planId: z.string().min(1),
    taskKey: z.string().min(1),
    agentId: z.string().min(1),
    reason: z.string().min(1).max(500),
    decidedBy: z.string().min(1),
  })
  .strict()
export type PlanAssignTaskParams = z.infer<typeof PlanAssignTaskParams>

export const PlanAssignTaskResult = z.object({
  plan: PlanRecord,
  assignment: PlanTaskAssignment,
})
export type PlanAssignTaskResult = z.infer<typeof PlanAssignTaskResult>

/** 设置页读取/创建系统 Planner Agent；不会修改计划或任务。 */
export const PlannerEnsureParams = z.object({}).strict()
export type PlannerEnsureParams = z.infer<typeof PlannerEnsureParams>

export const PlannerEnsureResult = z.object({ agent: AgentProfile })
export type PlannerEnsureResult = z.infer<typeof PlannerEnsureResult>

export const PlanThreadListParams = z.object({ planId: z.string().min(1) }).strict()
export type PlanThreadListParams = z.infer<typeof PlanThreadListParams>

export const PlanThreadListResult = z.object({ threads: z.array(PlanThreadView) })
export type PlanThreadListResult = z.infer<typeof PlanThreadListResult>

export const PlanCommentParams = z
  .object({
    planId: z.string().min(1),
    taskKey: z.string().min(1),
    authorId: z.string().min(1),
    content: z.string().min(1).max(20_000),
    /** 被 @ 的 Agent ID；Core 会为其启动一次群聊协作执行。 */
    mentions: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict()
export type PlanCommentParams = z.infer<typeof PlanCommentParams>

export const PlanCommentResult = z.object({ comment: PlanComment })
export type PlanCommentResult = z.infer<typeof PlanCommentResult>

/**
 * 返工换人：把运行中计划的某个任务显式改派给同一 Work 角色下的另一个 Agent。
 * 只影响后续 attempt，不修改已发布的 WorkflowDefinition。
 */
export const PlanReassignTaskParams = z
  .object({
    planId: z.string().min(1),
    taskKey: z.string().min(1),
    agentId: z.string().min(1),
    decidedBy: z.string().min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()
export type PlanReassignTaskParams = z.infer<typeof PlanReassignTaskParams>

export const PlanReassignTaskResult = z.object({
  plan: PlanRecord,
  taskKey: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().nullable(),
})
export type PlanReassignTaskResult = z.infer<typeof PlanReassignTaskResult>

/** 返工超限后的老板动作：继续返工一轮，或接管并保持暂停。 */
export const PlanReworkActionParams = z
  .object({
    planId: z.string().min(1),
    taskKey: z.string().min(1),
    decidedBy: z.string().min(1),
  })
  .strict()
export type PlanReworkActionParams = z.infer<typeof PlanReworkActionParams>

export const PlanReworkActionResult = z.object({
  plan: PlanRecord,
  taskKey: z.string().min(1),
  reworkStatus: z.enum(['requested', 'in_rework', 'exhausted']),
  round: z.number().int().min(1),
})
export type PlanReworkActionResult = z.infer<typeof PlanReworkActionResult>

/** 独立规划转为任务：创建 Work 并把计划挂到该任务上。 */
export const PlanConvertToTaskParams = z
  .object({
    planId: z.string().min(1),
    name: z.string().min(1).max(200),
    rootPath: z.string().min(1).max(4096),
    projectId: z.string().min(1).nullable().optional(),
  })
  .strict()
export type PlanConvertToTaskParams = z.infer<typeof PlanConvertToTaskParams>

export const PlanConvertToTaskResult = z.object({
  plan: PlanRecord,
  work: Work,
})
export type PlanConvertToTaskResult = z.infer<typeof PlanConvertToTaskResult>

/** 独立规划转为项目：创建项目，并在项目下创建一个承载该计划的任务。 */
export const PlanConvertToProjectParams = z
  .object({
    planId: z.string().min(1),
    projectName: z.string().min(1).max(200),
    projectDescription: z.string().max(4000).optional(),
    taskName: z.string().min(1).max(200),
    rootPath: z.string().min(1).max(4096),
  })
  .strict()
export type PlanConvertToProjectParams = z.infer<typeof PlanConvertToProjectParams>

export const PlanConvertToProjectResult = z.object({
  plan: PlanRecord,
  project: Project,
  work: Work,
})
export type PlanConvertToProjectResult = z.infer<typeof PlanConvertToProjectResult>
