import { z } from 'zod'
import { IsoTimestamp, Work } from '../dto'

export const PLANNER_CHAT_GET_METHOD = 'planner.chat.get'
export const PLANNER_CHAT_SEND_METHOD = 'planner.chat.send'
export const PLANNER_ACTION_APPLY_METHOD = 'planner.action.apply'
export const PLANNER_ACTION_REJECT_METHOD = 'planner.action.reject'
export const TEAM_TASK_GET_METHOD = 'teamTask.get'
export const TEAM_TASK_COMMENT_METHOD = 'teamTask.comment'
export const TEAM_TASK_SET_STATUS_METHOD = 'teamTask.setStatus'

export const PlannerMessageAuthorType = z.enum(['user', 'planner', 'system'])
export type PlannerMessageAuthorType = z.infer<typeof PlannerMessageAuthorType>

export const PlannerActionStatus = z.enum(['proposed', 'applied', 'rejected'])
export type PlannerActionStatus = z.infer<typeof PlannerActionStatus>

export const PlannerMessage = z.object({
  id: z.string().min(1),
  authorType: PlannerMessageAuthorType,
  authorId: z.string().min(1),
  content: z.string(),
  action: z.record(z.string(), z.unknown()).nullable(),
  actionStatus: PlannerActionStatus.nullable(),
  executionId: z.string().min(1).nullable(),
  relatedWorkId: z.string().min(1).nullable(),
  createdAt: IsoTimestamp,
})
export type PlannerMessage = z.infer<typeof PlannerMessage>

export const PlannerChatGetParams = z.object({}).strict()
export type PlannerChatGetParams = z.infer<typeof PlannerChatGetParams>
export const PlannerChatGetResult = z.object({ messages: z.array(PlannerMessage) })
export type PlannerChatGetResult = z.infer<typeof PlannerChatGetResult>

export const PlannerChatSendParams = z.object({ content: z.string().min(1).max(20_000) }).strict()
export type PlannerChatSendParams = z.infer<typeof PlannerChatSendParams>

export const PlannerChatSendResult = z.object({
  userMessage: PlannerMessage,
  plannerMessage: PlannerMessage,
})
export type PlannerChatSendResult = z.infer<typeof PlannerChatSendResult>

export const PlannerActionParams = z
  .object({
    messageId: z.string().min(1),
    /** 老板确认前可修正任务工作目录；空值使用 Planner 提议或默认临时目录。 */
    rootPath: z.string().min(1).max(4096).optional(),
  })
  .strict()
export type PlannerActionParams = z.infer<typeof PlannerActionParams>

export const PlannerActionRejectParams = z
  .object({ messageId: z.string().min(1), reason: z.string().max(500).optional() })
  .strict()
export type PlannerActionRejectParams = z.infer<typeof PlannerActionRejectParams>

export const PlannerActionResult = z.object({
  message: PlannerMessage,
  workId: z.string().min(1).nullable(),
  teamId: z.string().min(1).nullable(),
})
export type PlannerActionResult = z.infer<typeof PlannerActionResult>

export const TeamTaskMessageAuthorType = z.enum(['user', 'leader', 'member', 'planner', 'system'])
export type TeamTaskMessageAuthorType = z.infer<typeof TeamTaskMessageAuthorType>

export const TeamTaskMessageKind = z.enum(['message', 'decision', 'escalation', 'run', 'status'])
export type TeamTaskMessageKind = z.infer<typeof TeamTaskMessageKind>

export const TeamTaskMessage = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  authorType: TeamTaskMessageAuthorType,
  authorId: z.string().min(1),
  content: z.string(),
  kind: TeamTaskMessageKind,
  metadata: z.record(z.string(), z.unknown()),
  executionId: z.string().min(1).nullable(),
  createdAt: IsoTimestamp,
})
export type TeamTaskMessage = z.infer<typeof TeamTaskMessage>

export const TeamSubtaskStatus = z.enum(['pending', 'running', 'review', 'done', 'blocked'])
export type TeamSubtaskStatus = z.infer<typeof TeamSubtaskStatus>

export const TeamTaskSubtask = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  assigneeAgentId: z.string().min(1).nullable(),
  status: TeamSubtaskStatus,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  completedAt: IsoTimestamp.nullable(),
})
export type TeamTaskSubtask = z.infer<typeof TeamTaskSubtask>

export const TeamRunRole = z.enum(['leader', 'member'])
export type TeamRunRole = z.infer<typeof TeamRunRole>

export const TeamRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type TeamRunStatus = z.infer<typeof TeamRunStatus>

export const TeamTaskRun = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  role: TeamRunRole,
  triggerMessageId: z.string().min(1).nullable(),
  subtaskId: z.string().min(1).nullable(),
  status: TeamRunStatus,
  executionId: z.string().min(1).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
})
export type TeamTaskRun = z.infer<typeof TeamTaskRun>

export const TeamTaskRunStep = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  runId: z.string().min(1),
  stepKey: z.string().min(1),
  name: z.string().min(1),
  summary: z.string(),
  createdAt: IsoTimestamp,
})
export type TeamTaskRunStep = z.infer<typeof TeamTaskRunStep>

export const TeamTaskGetParams = z.object({ workId: z.string().min(1) }).strict()
export type TeamTaskGetParams = z.infer<typeof TeamTaskGetParams>
export const TeamTaskGetResult = z.object({
  work: Work,
  messages: z.array(TeamTaskMessage),
  subtasks: z.array(TeamTaskSubtask),
  runs: z.array(TeamTaskRun),
  steps: z.array(TeamTaskRunStep).default([]),
  activeRun: TeamTaskRun.nullable(),
})
export type TeamTaskGetResult = z.infer<typeof TeamTaskGetResult>

export const TeamCommentMode = z.enum(['normal', 'steer', 'after_run', 'restart', 'skip'])
export type TeamCommentMode = z.infer<typeof TeamCommentMode>

export const TeamTaskCommentParams = z
  .object({
    workId: z.string().min(1),
    content: z.string().min(1).max(20_000),
    authorId: z.string().min(1),
    mentions: z.array(z.string().min(1)).max(10).optional(),
    mode: TeamCommentMode.default('normal'),
  })
  .strict()
export type TeamTaskCommentParams = z.infer<typeof TeamTaskCommentParams>

export const TeamTaskCommentResult = z.object({
  message: TeamTaskMessage,
  run: TeamTaskRun.nullable(),
})
export type TeamTaskCommentResult = z.infer<typeof TeamTaskCommentResult>

export const TeamTaskSetStatusParams = z
  .object({
    workId: z.string().min(1),
    status: z.enum(['triage', 'backlog', 'in_progress', 'review', 'done']),
    decidedBy: z.string().min(1),
  })
  .strict()
export type TeamTaskSetStatusParams = z.infer<typeof TeamTaskSetStatusParams>

export const TeamTaskSetStatusResult = z.object({ work: Work })
export type TeamTaskSetStatusResult = z.infer<typeof TeamTaskSetStatusResult>
