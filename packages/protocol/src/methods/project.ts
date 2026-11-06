import { z } from 'zod'
import { IsoTimestamp } from '../dto'

/**
 * 项目 = 任务的合集。项目只做分组与状态，不承载执行语义；
 * 执行仍由任务（Work）下的计划与执行内核完成。
 */
export const PROJECT_CREATE_METHOD = 'project.create'
export const PROJECT_LIST_METHOD = 'project.list'
export const PROJECT_GET_METHOD = 'project.get'
export const PROJECT_UPDATE_METHOD = 'project.update'

export const ProjectStatus = z.enum(['active', 'paused', 'completed', 'archived'])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const Project = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  status: ProjectStatus,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type Project = z.infer<typeof Project>

export const ProjectCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
  })
  .strict()
export type ProjectCreateParams = z.infer<typeof ProjectCreateParams>

export const ProjectResult = z.object({ project: Project })
export type ProjectResult = z.infer<typeof ProjectResult>

export const ProjectListParams = z.object({}).strict()
export type ProjectListParams = z.infer<typeof ProjectListParams>

export const ProjectListResult = z.object({ projects: z.array(Project) })
export type ProjectListResult = z.infer<typeof ProjectListResult>

export const ProjectGetParams = z.object({ id: z.string().min(1) }).strict()
export type ProjectGetParams = z.infer<typeof ProjectGetParams>

export const ProjectUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    status: ProjectStatus.optional(),
  })
  .strict()
export type ProjectUpdateParams = z.infer<typeof ProjectUpdateParams>
