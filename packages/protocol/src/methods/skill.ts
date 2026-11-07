import { z } from 'zod'
import { Skill } from '../dto'

export const SKILL_LIST_METHOD = 'skill.list'
export const SKILL_CREATE_METHOD = 'skill.create'
export const SKILL_UPDATE_METHOD = 'skill.update'
export const SKILL_DELETE_METHOD = 'skill.delete'

export const SkillListParams = z.object({}).strict()
export type SkillListParams = z.infer<typeof SkillListParams>

export const SkillListResult = z.object({ skills: z.array(Skill) })
export type SkillListResult = z.infer<typeof SkillListResult>

export const SkillCreateParams = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(4000).optional(),
    instructions: z.string().min(1).max(100_000),
  })
  .strict()
export type SkillCreateParams = z.infer<typeof SkillCreateParams>

export const SkillUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(4000).optional(),
    instructions: z.string().min(1).max(100_000).optional(),
  })
  .strict()
export type SkillUpdateParams = z.infer<typeof SkillUpdateParams>

export const SkillDeleteParams = z.object({ id: z.string().min(1) }).strict()
export type SkillDeleteParams = z.infer<typeof SkillDeleteParams>

export const SkillResult = z.object({ skill: Skill })
export type SkillResult = z.infer<typeof SkillResult>

export const SkillDeleteResult = z.object({ deleted: z.boolean() })
export type SkillDeleteResult = z.infer<typeof SkillDeleteResult>
