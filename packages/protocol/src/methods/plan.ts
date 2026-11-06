import { z } from 'zod'
import { IsoTimestamp, Work } from '../dto'
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
  /** 结构化能力要求；Planner 不能只靠名称或职责描述选人。 */
  requiredCapabilities: z.array(CapabilityTag).max(20).default([]),
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
})
export type PlanStartRunResult = z.infer<typeof PlanStartRunResult>

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
