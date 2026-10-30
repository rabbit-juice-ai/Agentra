import { z } from 'zod'
import { Assignment } from '../dto'

export const ASSIGNMENT_LIST_METHOD = 'assignment.list'
export const ASSIGNMENT_GET_METHOD = 'assignment.get'
export const ASSIGNMENT_CREATE_METHOD = 'assignment.create'
export const ASSIGNMENT_PAUSE_METHOD = 'assignment.pause'
export const ASSIGNMENT_RESUME_METHOD = 'assignment.resume'
export const ASSIGNMENT_COMPLETE_METHOD = 'assignment.complete'
export const ASSIGNMENT_REMOVE_METHOD = 'assignment.remove'

export const AssignmentListParams = z.object({ workId: z.string().min(1) }).strict()
export type AssignmentListParams = z.infer<typeof AssignmentListParams>

export const AssignmentListResult = z.object({ assignments: z.array(Assignment) })
export type AssignmentListResult = z.infer<typeof AssignmentListResult>

export const AssignmentGetParams = z.object({ id: z.string().min(1) }).strict()
export type AssignmentGetParams = z.infer<typeof AssignmentGetParams>

export const AssignmentResult = z.object({ assignment: Assignment })
export type AssignmentResult = z.infer<typeof AssignmentResult>

export const AssignmentCreateParams = z
  .object({
    workId: z.string().min(1),
    agentId: z.string().min(1),
    teamId: z.string().min(1).nullable().optional(),
    workRole: z.string().min(1).max(100),
    taskScope: z.string().max(2000).optional(),
    concurrencyLimit: z.number().int().min(1).max(64).nullable().optional(),
    contextRef: z.string().max(2000).nullable().optional(),
  })
  .strict()
export type AssignmentCreateParams = z.infer<typeof AssignmentCreateParams>

export const AssignmentIdParams = z.object({ id: z.string().min(1) }).strict()
export type AssignmentIdParams = z.infer<typeof AssignmentIdParams>
