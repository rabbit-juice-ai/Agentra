import { z } from 'zod'
import { Worktree } from '../dto'

export const WORKTREE_LIST_METHOD = 'worktree.list'
export const WORKTREE_CREATE_METHOD = 'worktree.create'
export const WORKTREE_REMOVE_METHOD = 'worktree.remove'

export const WorktreeListParams = z.object({ workId: z.string().min(1) }).strict()
export type WorktreeListParams = z.infer<typeof WorktreeListParams>

export const WorktreeListResult = z.object({ worktrees: z.array(Worktree) })
export type WorktreeListResult = z.infer<typeof WorktreeListResult>

export const WorktreeCreateParams = z
  .object({
    workId: z.string().min(1),
    branchName: z.string().min(1).max(200),
    assignmentId: z.string().min(1).nullable().optional(),
    baseRef: z.string().min(1).max(200).optional(),
  })
  .strict()
export type WorktreeCreateParams = z.infer<typeof WorktreeCreateParams>

export const WorktreeCreateResult = z.object({ worktree: Worktree })
export type WorktreeCreateResult = z.infer<typeof WorktreeCreateResult>

export const WorktreeRemoveParams = z
  .object({
    id: z.string().min(1),
    /** 必须显式为 true：清理不可默认执行（DEVELOPMENT_PLAN「清理必须确认」）。 */
    confirm: z.boolean(),
  })
  .strict()
export type WorktreeRemoveParams = z.infer<typeof WorktreeRemoveParams>

export const WorktreeRemoveResult = z.object({ worktree: Worktree })
export type WorktreeRemoveResult = z.infer<typeof WorktreeRemoveResult>
