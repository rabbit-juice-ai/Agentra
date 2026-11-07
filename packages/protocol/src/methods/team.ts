import { z } from 'zod'
import { Team, TeamMember } from '../dto'

export const TEAM_LIST_METHOD = 'team.list'
export const TEAM_GET_METHOD = 'team.get'
export const TEAM_CREATE_METHOD = 'team.create'
export const TEAM_UPDATE_METHOD = 'team.update'
export const TEAM_ARCHIVE_METHOD = 'team.archive'
export const TEAM_MEMBER_LIST_METHOD = 'team.member.list'
export const TEAM_MEMBER_ADD_METHOD = 'team.member.add'
export const TEAM_MEMBER_REMOVE_METHOD = 'team.member.remove'

export const TeamListParams = z.object({ includeArchived: z.boolean().optional() }).strict()
export type TeamListParams = z.infer<typeof TeamListParams>

export const TeamListResult = z.object({ teams: z.array(Team) })
export type TeamListResult = z.infer<typeof TeamListResult>

export const TeamGetParams = z.object({ id: z.string().min(1) }).strict()
export type TeamGetParams = z.infer<typeof TeamGetParams>

export const TeamResult = z.object({ team: Team })
export type TeamResult = z.infer<typeof TeamResult>

export const TeamCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    instructions: z.string().max(20_000).optional(),
  })
  .strict()
export type TeamCreateParams = z.infer<typeof TeamCreateParams>

export const TeamUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    instructions: z.string().max(20_000).optional(),
  })
  .strict()
export type TeamUpdateParams = z.infer<typeof TeamUpdateParams>

export const TeamArchiveParams = z.object({ id: z.string().min(1) }).strict()
export type TeamArchiveParams = z.infer<typeof TeamArchiveParams>

export const TeamMemberListParams = z.object({ teamId: z.string().min(1) }).strict()
export type TeamMemberListParams = z.infer<typeof TeamMemberListParams>

export const TeamMemberListResult = z.object({ members: z.array(TeamMember) })
export type TeamMemberListResult = z.infer<typeof TeamMemberListResult>

export const TeamMemberAddParams = z
  .object({
    teamId: z.string().min(1),
    agentId: z.string().min(1),
  })
  .strict()
export type TeamMemberAddParams = z.infer<typeof TeamMemberAddParams>

export const TeamMemberResult = z.object({ member: TeamMember })
export type TeamMemberResult = z.infer<typeof TeamMemberResult>

export const TeamMemberRemoveParams = z
  .object({ teamId: z.string().min(1), agentId: z.string().min(1) })
  .strict()
export type TeamMemberRemoveParams = z.infer<typeof TeamMemberRemoveParams>

export const TeamMemberRemoveResult = z.object({ removed: z.literal(true) })
export type TeamMemberRemoveResult = z.infer<typeof TeamMemberRemoveResult>
