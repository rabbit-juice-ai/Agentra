import {
  AGENT_ARCHIVE_METHOD,
  AGENT_CREATE_METHOD,
  AGENT_GET_METHOD,
  AGENT_LIST_METHOD,
  AGENT_UPDATE_METHOD,
  AgentArchiveParams,
  AgentCreateParams,
  AgentGetParams,
  AgentListParams,
  AgentListResult,
  AgentResult,
  AgentUpdateParams,
  ASSIGNMENT_COMPLETE_METHOD,
  ASSIGNMENT_CREATE_METHOD,
  ASSIGNMENT_GET_METHOD,
  ASSIGNMENT_LIST_METHOD,
  ASSIGNMENT_PAUSE_METHOD,
  ASSIGNMENT_REMOVE_METHOD,
  ASSIGNMENT_RESUME_METHOD,
  AssignmentCreateParams,
  AssignmentGetParams,
  AssignmentIdParams,
  AssignmentListParams,
  AssignmentListResult,
  AssignmentResult,
  defineMethod,
  EVENTS_SUBSCRIBE_METHOD,
  EventsSubscribeParams,
  EventsSubscribeResult,
  EXECUTION_CANCEL_METHOD,
  EXECUTION_GET_METHOD,
  EXECUTION_INTERRUPT_METHOD,
  EXECUTION_LIST_METHOD,
  EXECUTION_LOGS_METHOD,
  EXECUTION_SEND_MESSAGE_METHOD,
  EXECUTION_START_METHOD,
  EXECUTION_STATUS_METHOD,
  ExecutionCancelParams,
  ExecutionGetParams,
  ExecutionGetResult,
  ExecutionInterruptParams,
  ExecutionInterruptResult,
  ExecutionListParams,
  ExecutionListResult,
  ExecutionLogsParams,
  ExecutionLogsResult,
  ExecutionResult,
  ExecutionSendMessageParams,
  ExecutionSendMessageResult,
  ExecutionStartParams,
  ExecutionStatusParams,
  RUNTIME_PROVIDER_LIST_METHOD,
  RUNTIME_PROVIDER_REFRESH_METHOD,
  RuntimeProviderListParams,
  RuntimeProviderListResult,
  RuntimeProviderRefreshParams,
  TEAM_ARCHIVE_METHOD,
  TEAM_CREATE_METHOD,
  TEAM_GET_METHOD,
  TEAM_LIST_METHOD,
  TEAM_MEMBER_ADD_METHOD,
  TEAM_MEMBER_LIST_METHOD,
  TEAM_MEMBER_REMOVE_METHOD,
  TeamArchiveParams,
  TeamCreateParams,
  TeamGetParams,
  TeamListParams,
  TeamListResult,
  TeamMemberAddParams,
  TeamMemberListParams,
  TeamMemberListResult,
  TeamMemberRemoveParams,
  TeamMemberRemoveResult,
  TeamMemberResult,
  TeamResult,
  WORK_ACTIVATE_METHOD,
  WORK_ARCHIVE_METHOD,
  WORK_COMPLETE_METHOD,
  WORK_CREATE_METHOD,
  WORK_GET_METHOD,
  WORK_LINK_TEAM_METHOD,
  WORK_LIST_METHOD,
  WORK_PAUSE_METHOD,
  WORK_RESUME_METHOD,
  WORK_TERMINATE_METHOD,
  WorkCreateParams,
  type Work as WorkDto,
  WorkGetParams,
  WorkIdParams,
  WorkLinkTeamParams,
  WorkListParams,
  WorkListResult,
  WorkResult,
} from '@agentra/protocol'
import type { AgentService } from '../services/agent-service'
import type { AssignmentService } from '../services/assignment-service'
import type { CoreEventHub } from '../services/event-hub'
import type { ExecutionService } from '../services/execution-service'
import { coreHealthMethods } from '../services/health'
import type { ProviderRegistry } from '../services/provider-registry'
import type { TeamService } from '../services/team-service'
import type { WorkService } from '../services/work-service'
import type { MethodTable } from './dispatcher'

export type CoreMethodServices = {
  agents: AgentService
  registry: ProviderRegistry
  executions: ExecutionService
  hub: CoreEventHub
  teams: TeamService
  works: WorkService
  assignments: AssignmentService
}

/**
 * Work 的对外形态：DB 记录 + 只读派生的 teamIds（来自 work_teams）。
 * teamIds 不进 works 表，避免同一事实两处存储。
 */
function toWorkDto(services: CoreMethodServices, work: Parameters<WorkService['get']>[0]): WorkDto {
  return { ...services.works.get(work), teamIds: services.works.listTeamIds(work) }
}

/** 执行 Work 状态动作后按 id 取回 DTO（迁移结果以库内状态为准）。 */
function toWorkDtoAfter(
  services: CoreMethodServices,
  id: string,
  action: 'activate' | 'pause' | 'resume' | 'complete' | 'terminate' | 'archive',
): WorkDto {
  services.works[action](id)
  return toWorkDto(services, id)
}

/** Desktop 可见的全部 RPC 方法（Core 是唯一业务入口）。 */
export function coreMethods(
  version: string,
  daemonSocketPath: string,
  services: CoreMethodServices,
): MethodTable {
  return {
    ...coreHealthMethods(version, daemonSocketPath),

    [AGENT_LIST_METHOD]: defineMethod(AgentListParams, AgentListResult, (params) => ({
      agents: services.agents.list(params.includeArchived ?? false),
    })),
    [AGENT_GET_METHOD]: defineMethod(AgentGetParams, AgentResult, (params) => ({
      agent: services.agents.get(params.id),
    })),
    [AGENT_CREATE_METHOD]: defineMethod(AgentCreateParams, AgentResult, (params) => ({
      agent: services.agents.create(params),
    })),
    [AGENT_UPDATE_METHOD]: defineMethod(AgentUpdateParams, AgentResult, (params) => ({
      agent: services.agents.update(params),
    })),
    [AGENT_ARCHIVE_METHOD]: defineMethod(AgentArchiveParams, AgentResult, (params) => ({
      agent: services.agents.archive(params.id),
    })),

    [RUNTIME_PROVIDER_LIST_METHOD]: defineMethod(
      RuntimeProviderListParams,
      RuntimeProviderListResult,
      () => ({ providers: services.registry.list() }),
    ),
    [RUNTIME_PROVIDER_REFRESH_METHOD]: defineMethod(
      RuntimeProviderRefreshParams,
      RuntimeProviderListResult,
      async () => ({ providers: await services.registry.refresh() }),
    ),

    [EXECUTION_START_METHOD]: defineMethod(
      ExecutionStartParams,
      ExecutionResult,
      async (params) => ({ execution: await services.executions.start(params) }),
    ),
    [EXECUTION_GET_METHOD]: defineMethod(ExecutionGetParams, ExecutionGetResult, (params) => ({
      execution: services.executions.get(params.executionId),
      logs: services.executions.logsFor({ executionId: params.executionId }),
    })),
    [EXECUTION_LIST_METHOD]: defineMethod(ExecutionListParams, ExecutionListResult, (params) => ({
      executions: services.executions.list(params.limit ?? 50),
    })),
    [EXECUTION_LOGS_METHOD]: defineMethod(ExecutionLogsParams, ExecutionLogsResult, (params) => ({
      logs: services.executions.logsFor(params),
    })),
    [EXECUTION_SEND_MESSAGE_METHOD]: defineMethod(
      ExecutionSendMessageParams,
      ExecutionSendMessageResult,
      (params) => services.executions.sendMessage(params),
    ),
    [EXECUTION_INTERRUPT_METHOD]: defineMethod(
      ExecutionInterruptParams,
      ExecutionInterruptResult,
      (params) => services.executions.interrupt(params),
    ),
    [EXECUTION_CANCEL_METHOD]: defineMethod(
      ExecutionCancelParams,
      ExecutionResult,
      async (params) => ({ execution: await services.executions.cancel(params) }),
    ),
    [EXECUTION_STATUS_METHOD]: defineMethod(ExecutionStatusParams, ExecutionResult, (params) => ({
      execution: services.executions.get(params.executionId),
    })),

    // ---- 阶段 2：Team ----
    [TEAM_LIST_METHOD]: defineMethod(TeamListParams, TeamListResult, (params) => ({
      teams: services.teams.list(params.includeArchived ?? false),
    })),
    [TEAM_GET_METHOD]: defineMethod(TeamGetParams, TeamResult, (params) => ({
      team: services.teams.get(params.id),
    })),
    [TEAM_CREATE_METHOD]: defineMethod(TeamCreateParams, TeamResult, (params) => ({
      team: services.teams.create(params),
    })),
    [TEAM_ARCHIVE_METHOD]: defineMethod(TeamArchiveParams, TeamResult, (params) => ({
      team: services.teams.archive(params.id),
    })),
    [TEAM_MEMBER_LIST_METHOD]: defineMethod(
      TeamMemberListParams,
      TeamMemberListResult,
      (params) => ({ members: services.teams.listMembers(params.teamId) }),
    ),
    [TEAM_MEMBER_ADD_METHOD]: defineMethod(TeamMemberAddParams, TeamMemberResult, (params) => ({
      member: services.teams.addMember(params.teamId, params.agentId, params.teamRole),
    })),
    [TEAM_MEMBER_REMOVE_METHOD]: defineMethod(
      TeamMemberRemoveParams,
      TeamMemberRemoveResult,
      (params) => {
        services.teams.removeMember(params.teamId, params.agentId)
        return { removed: true as const }
      },
    ),

    // ---- 阶段 2：Work ----
    [WORK_LIST_METHOD]: defineMethod(WorkListParams, WorkListResult, (params) => ({
      works: services.works
        .list(params.includeArchived ?? false)
        .map((work) => ({ ...work, teamIds: services.works.listTeamIds(work.id) })),
    })),
    [WORK_GET_METHOD]: defineMethod(WorkGetParams, WorkResult, (params) => ({
      work: toWorkDto(services, params.id),
    })),
    [WORK_CREATE_METHOD]: defineMethod(WorkCreateParams, WorkResult, (params) => ({
      work: { ...services.works.create(params), teamIds: [] },
    })),
    [WORK_LINK_TEAM_METHOD]: defineMethod(WorkLinkTeamParams, WorkResult, (params) => {
      services.works.linkTeam(params.workId, params.teamId)
      return { work: toWorkDto(services, params.workId) }
    }),
    [WORK_ACTIVATE_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'activate'),
    })),
    [WORK_PAUSE_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'pause'),
    })),
    [WORK_RESUME_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'resume'),
    })),
    [WORK_COMPLETE_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'complete'),
    })),
    [WORK_TERMINATE_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'terminate'),
    })),
    [WORK_ARCHIVE_METHOD]: defineMethod(WorkIdParams, WorkResult, (params) => ({
      work: toWorkDtoAfter(services, params.id, 'archive'),
    })),

    // ---- 阶段 2：Assignment ----
    [ASSIGNMENT_LIST_METHOD]: defineMethod(
      AssignmentListParams,
      AssignmentListResult,
      (params) => ({ assignments: services.assignments.listByWork(params.workId) }),
    ),
    [ASSIGNMENT_GET_METHOD]: defineMethod(AssignmentGetParams, AssignmentResult, (params) => ({
      assignment: services.assignments.get(params.id),
    })),
    [ASSIGNMENT_CREATE_METHOD]: defineMethod(
      AssignmentCreateParams,
      AssignmentResult,
      (params) => ({ assignment: services.assignments.create(params) }),
    ),
    [ASSIGNMENT_PAUSE_METHOD]: defineMethod(AssignmentIdParams, AssignmentResult, (params) => ({
      assignment: services.assignments.pause(params.id),
    })),
    [ASSIGNMENT_RESUME_METHOD]: defineMethod(AssignmentIdParams, AssignmentResult, (params) => ({
      assignment: services.assignments.resume(params.id),
    })),
    [ASSIGNMENT_COMPLETE_METHOD]: defineMethod(AssignmentIdParams, AssignmentResult, (params) => ({
      assignment: services.assignments.complete(params.id),
    })),
    [ASSIGNMENT_REMOVE_METHOD]: defineMethod(AssignmentIdParams, AssignmentResult, (params) => ({
      assignment: services.assignments.remove(params.id),
    })),

    [EVENTS_SUBSCRIBE_METHOD]: defineMethod(
      EventsSubscribeParams,
      EventsSubscribeResult,
      (_params, ctx) => {
        const unsubscribe = services.hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
    ),
  }
}
