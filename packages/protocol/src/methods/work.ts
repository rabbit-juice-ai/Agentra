import { z } from 'zod'
import { Work } from '../dto'

export const WORK_LIST_METHOD = 'work.list'
export const WORK_GET_METHOD = 'work.get'
export const WORK_CREATE_METHOD = 'work.create'
export const WORK_LINK_TEAM_METHOD = 'work.linkTeam'
export const WORK_ACTIVATE_METHOD = 'work.activate'
export const WORK_PAUSE_METHOD = 'work.pause'
export const WORK_RESUME_METHOD = 'work.resume'
export const WORK_COMPLETE_METHOD = 'work.complete'
export const WORK_TERMINATE_METHOD = 'work.terminate'
export const WORK_ARCHIVE_METHOD = 'work.archive'

export const WorkListParams = z.object({ includeArchived: z.boolean().optional() }).strict()
export type WorkListParams = z.infer<typeof WorkListParams>

export const WorkListResult = z.object({ works: z.array(Work) })
export type WorkListResult = z.infer<typeof WorkListResult>

export const WorkGetParams = z.object({ id: z.string().min(1) }).strict()
export type WorkGetParams = z.infer<typeof WorkGetParams>

export const WorkResult = z.object({ work: Work })
export type WorkResult = z.infer<typeof WorkResult>

export const WorkCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    objective: z.string().max(4000).optional(),
    rootPath: z.string().min(1).max(4096),
    repositoryPath: z.string().min(1).max(4096).nullable().optional(),
    priority: z.string().min(1).max(50).optional(),
  })
  .strict()
export type WorkCreateParams = z.infer<typeof WorkCreateParams>

export const WorkIdParams = z.object({ id: z.string().min(1) }).strict()
export type WorkIdParams = z.infer<typeof WorkIdParams>

export const WorkLinkTeamParams = z
  .object({ workId: z.string().min(1), teamId: z.string().min(1) })
  .strict()
export type WorkLinkTeamParams = z.infer<typeof WorkLinkTeamParams>
