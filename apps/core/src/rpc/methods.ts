import type {} from '@agentra/protocol'
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
  APPROVAL_DECIDE_METHOD,
  APPROVAL_GET_METHOD,
  APPROVAL_LIST_PENDING_METHOD,
  ApprovalDecideParams,
  ApprovalGetParams,
  ApprovalGetResult,
  ApprovalListPendingParams,
  ApprovalListPendingResult,
  ApprovalResult,
  ARTIFACT_LIST_METHOD,
  ARTIFACT_PREVIEW_METHOD,
  ArtifactListParams,
  ArtifactListResult,
  ArtifactPreviewParams,
  ArtifactPreviewResult,
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
  BACKUP_CREATE_METHOD,
  BACKUP_EXPORT_METHOD,
  BACKUP_LIST_METHOD,
  BACKUP_RESTORE_METHOD,
  BACKUP_RESTORE_PRECHECK_METHOD,
  BackupCreateParamsValue,
  BackupExportParamsValue,
  BackupExportResultValue,
  BackupListParamsValue,
  BackupListResultValue,
  BackupRestoreAcceptedValue,
  BackupRestoreParamsValue,
  BackupRestorePrecheckParamsValue,
  BackupRestorePrecheckResultValue,
  BackupResultValue,
  CORE_MAINTENANCE_STATUS_METHOD,
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
  type MaintenanceStatusParams,
  MaintenanceStatusParamsValue,
  type MaintenanceStatusResult,
  MaintenanceStatusResultValue,
  PLAN_APPROVE_METHOD,
  PLAN_COMMENT_METHOD,
  PLAN_CONTINUE_REWORK_METHOD,
  PLAN_CONVERT_TO_PROJECT_METHOD,
  PLAN_CONVERT_TO_TASK_METHOD,
  PLAN_CREATE_DRAFT_METHOD,
  PLAN_GENERATE_METHOD,
  PLAN_GET_METHOD,
  PLAN_LIST_BY_WORK_METHOD,
  PLAN_LIST_RECENT_METHOD,
  PLAN_REASSIGN_TASK_METHOD,
  PLAN_REJECT_METHOD,
  PLAN_START_RUN_METHOD,
  PLAN_TAKE_OVER_REWORK_METHOD,
  PLAN_THREAD_LIST_METHOD,
  PlanApproveParams,
  PlanCommentParams,
  PlanCommentResult,
  PlanConvertToProjectParams,
  PlanConvertToProjectResult,
  PlanConvertToTaskParams,
  PlanConvertToTaskResult,
  PlanCreateDraftParams,
  PlanDecisionResult,
  PlanGenerateParams,
  PlanGenerateResult,
  PlanGetParams,
  PlanGetResult,
  PlanListByWorkParams,
  PlanListByWorkResult,
  PlanListRecentParams,
  PlanListRecentResult,
  PlanReassignTaskParams,
  PlanReassignTaskResult,
  PlanRejectParams,
  PlanReworkActionParams,
  PlanReworkActionResult,
  PlanStartRunParams,
  PlanStartRunResult,
  PlanThreadListParams,
  PlanThreadListResult,
  PROJECT_CREATE_METHOD,
  PROJECT_GET_METHOD,
  PROJECT_LIST_METHOD,
  PROJECT_UPDATE_METHOD,
  ProjectCreateParams,
  ProjectGetParams,
  ProjectListParams,
  ProjectListResult,
  ProjectResult,
  ProjectUpdateParams,
  RESTORE_STATUS_METHOD,
  RestoreStatusParamsValue,
  RestoreStatusResultValue,
  RpcMethodError,
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
  WORKFLOW_RUN_GET_METHOD,
  WORKTREE_CREATE_METHOD,
  WORKTREE_LIST_METHOD,
  WORKTREE_REMOVE_METHOD,
  WorkCreateParams,
  type Work as WorkDto,
  WorkflowRunGetParams,
  WorkflowRunGetResult,
  WorkGetParams,
  WorkIdParams,
  WorkLinkTeamParams,
  WorkListParams,
  WorkListResult,
  WorkResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListParams,
  WorktreeListResult,
  WorktreeRemoveParams,
  WorktreeRemoveResult,
} from '@agentra/protocol'
import { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { MaintenanceController } from '../lifecycle/maintenance-controller'
import type { AgentService } from '../services/agent-service'
import type { ApprovalRpcService } from '../services/approval-rpc-service'
import type { ArtifactRpcService } from '../services/artifact-rpc-service'
import type { AssignmentService } from '../services/assignment-service'
import type { BackupRestorePrecheckService } from '../services/backup-restore-precheck-service'
import type { BackupRpcService } from '../services/backup-rpc-service'
import type { CoreEventHub } from '../services/event-hub'
import type { ExecutionService } from '../services/execution-service'
import { coreHealthMethods } from '../services/health'
import type { PlanService } from '../services/plan-service'
import { PlanServiceError } from '../services/plan-service'
import type { PlannerService } from '../services/planner-service'
import type { ProjectService } from '../services/project-service'
import { ProjectServiceError } from '../services/project-service'
import type { ProviderRegistry } from '../services/provider-registry'
import type { RestoreCoordinator } from '../services/restore-coordinator'
import { RestoreCoordinatorError } from '../services/restore-coordinator'
import type { TeamService } from '../services/team-service'
import type { WorkService } from '../services/work-service'
import type { WorktreeService } from '../services/worktree-service'
import type { WorkflowEngine } from '../workflow/engine'
import { WorkflowRunQueryError, type WorkflowRunQueryService } from '../workflow/run-query-service'
import type { MethodTable, RpcMethodDef } from './dispatcher'

export type CoreMethodServices = {
  agents: AgentService
  planner?: PlannerService
  plans?: PlanService
  projects?: ProjectService
  registry: ProviderRegistry
  executions: ExecutionService
  hub: CoreEventHub
  teams: TeamService
  works: WorkService
  workEffects?: (id: string, action: string) => Promise<void>
  assignments: AssignmentService
  worktrees: WorktreeService
  workflowRuns: WorkflowRunQueryService
  workflowEngine?: Pick<WorkflowEngine, 'kick'>
  approvals: ApprovalRpcService
  artifacts: ArtifactRpcService
  backups: BackupRpcService
  backupPrecheck: BackupRestorePrecheckService
  /** S55-2C：老 Core 的 Restore 异步接受编排（进入 maintenance 后由其接管）。 */
  restore?: Pick<RestoreCoordinator, 'request' | 'status'>
}

export type CoreLifecycleServices = {
  maintenance: MaintenanceController
  drain: DrainCoordinator
}

/**
 * Work 的对外形态：DB 记录 + 只读派生的 teamIds（来自 work_teams）。
 * teamIds 不进 works 表，避免同一事实两处存储。
 */
function toWorkDto(services: CoreMethodServices, work: Parameters<WorkService['get']>[0]): WorkDto {
  return { ...services.works.get(work), teamIds: services.works.listTeamIds(work) }
}

/** 执行 Work 状态动作后按 id 取回 DTO（迁移结果以库内状态为准）。 */
const workActions = new WeakMap<WorkService, Map<string, Promise<unknown>>>()

/** 同一 Work 的状态与进程处置串行；不同 Work 不互相阻塞。失败后允许重试取消。 */
function toWorkDtoAfter(
  services: CoreMethodServices,
  id: string,
  action: 'activate' | 'pause' | 'resume' | 'complete' | 'terminate' | 'archive',
): Promise<WorkDto> {
  let actions = workActions.get(services.works)
  if (!actions) {
    actions = new Map()
    workActions.set(services.works, actions)
  }
  const previous = actions.get(id) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      services.works[action](id)
      await services.workEffects?.(id, action)
      return toWorkDto(services, id)
    })
  actions.set(id, next)
  void next
    .finally(() => {
      if (actions.get(id) === next) actions.delete(id)
    })
    .catch(() => undefined)
  return next
}

/**
 * S55-2B-1B：`core.maintenance.status` 定义工厂。
 * 业务 socket 与最小 boot socket 共用同一实现，避免双份定义漂移。
 */
export function maintenanceStatusMethod(
  maintenance: MaintenanceController,
  drain: DrainCoordinator,
): RpcMethodDef<MaintenanceStatusParams, MaintenanceStatusResult> {
  return defineMethod(
    MaintenanceStatusParamsValue,
    MaintenanceStatusResultValue,
    () => ({
      ...maintenance.snapshot(),
      drain: drain.snapshot(),
    }),
    'read',
  )
}

/** Desktop 可见的全部 RPC 方法（Core 是唯一业务入口）。 */
export function coreMethods(
  version: string,
  daemonSocketPath: string,
  services: CoreMethodServices,
  lifecycle: CoreLifecycleServices = {
    maintenance: new MaintenanceController(),
    drain: new DrainCoordinator(),
  },
): MethodTable {
  const requirePlans = (): PlanService => {
    if (!services.plans) throw new RpcMethodError('NOT_READY', 'plans are not configured')
    return services.plans
  }
  const requireProjects = (): ProjectService => {
    if (!services.projects) throw new RpcMethodError('NOT_READY', 'projects are not configured')
    return services.projects
  }
  const projectError = (error: unknown): never => {
    if (error instanceof ProjectServiceError) {
      throw new RpcMethodError('INVALID_PARAMS', error.message)
    }
    throw error
  }
  const planError = (error: unknown): never => {
    if (error instanceof PlanServiceError) {
      throw new RpcMethodError('INVALID_PARAMS', error.message)
    }
    throw error
  }
  return {
    ...coreHealthMethods(version, daemonSocketPath),
    [CORE_MAINTENANCE_STATUS_METHOD]: maintenanceStatusMethod(
      lifecycle.maintenance,
      lifecycle.drain,
    ),

    [AGENT_LIST_METHOD]: defineMethod(
      AgentListParams,
      AgentListResult,
      (params) => ({
        agents: services.agents.list(params.includeArchived ?? false),
      }),
      'read',
    ),
    [AGENT_GET_METHOD]: defineMethod(
      AgentGetParams,
      AgentResult,
      (params) => ({
        agent: services.agents.get(params.id),
      }),
      'read',
    ),
    [AGENT_CREATE_METHOD]: defineMethod(AgentCreateParams, AgentResult, (params) => ({
      agent: services.agents.create(params),
    })),
    [AGENT_UPDATE_METHOD]: defineMethod(AgentUpdateParams, AgentResult, (params) => ({
      agent: services.agents.update(params),
    })),
    [AGENT_ARCHIVE_METHOD]: defineMethod(AgentArchiveParams, AgentResult, (params) => ({
      agent: services.agents.archive(params.id),
    })),

    [PLAN_GENERATE_METHOD]: defineMethod(PlanGenerateParams, PlanGenerateResult, async (params) => {
      try {
        return await requirePlans().generate(params)
      } catch (error) {
        return planError(error)
      }
    }),
    [PLAN_CREATE_DRAFT_METHOD]: defineMethod(
      PlanCreateDraftParams,
      PlanGenerateResult,
      (params) => {
        try {
          return requirePlans().createDraft(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_GET_METHOD]: defineMethod(
      PlanGetParams,
      PlanGetResult,
      (params) => {
        try {
          return requirePlans().get(params.planId)
        } catch (error) {
          return planError(error)
        }
      },
      'read',
    ),
    [PLAN_LIST_BY_WORK_METHOD]: defineMethod(
      PlanListByWorkParams,
      PlanListByWorkResult,
      (params) => ({ plans: requirePlans().listByWork(params.workId) }),
      'read',
    ),
    [PLAN_LIST_RECENT_METHOD]: defineMethod(
      PlanListRecentParams,
      PlanListRecentResult,
      (params) => ({ plans: requirePlans().listRecent(params.limit) }),
      'read',
    ),
    [PLAN_APPROVE_METHOD]: defineMethod(PlanApproveParams, PlanDecisionResult, (params) => {
      try {
        return requirePlans().approve(params.planId, params.decidedBy)
      } catch (error) {
        return planError(error)
      }
    }),
    [PLAN_REJECT_METHOD]: defineMethod(PlanRejectParams, PlanDecisionResult, (params) => {
      try {
        return requirePlans().reject(params.planId, params.decidedBy, params.comment)
      } catch (error) {
        return planError(error)
      }
    }),
    [PLAN_START_RUN_METHOD]: defineMethod(
      PlanStartRunParams,
      PlanStartRunResult,
      async (params) => {
        try {
          return await requirePlans().startRun(params.planId, params.requestId)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_THREAD_LIST_METHOD]: defineMethod(
      PlanThreadListParams,
      PlanThreadListResult,
      (params) => {
        try {
          return requirePlans().listThreads(params.planId)
        } catch (error) {
          return planError(error)
        }
      },
      'read',
    ),
    [PLAN_COMMENT_METHOD]: defineMethod(PlanCommentParams, PlanCommentResult, async (params) => {
      try {
        return await requirePlans().comment(params)
      } catch (error) {
        return planError(error)
      }
    }),
    [PLAN_REASSIGN_TASK_METHOD]: defineMethod(
      PlanReassignTaskParams,
      PlanReassignTaskResult,
      (params) => {
        try {
          return requirePlans().reassignTask(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_CONTINUE_REWORK_METHOD]: defineMethod(
      PlanReworkActionParams,
      PlanReworkActionResult,
      async (params) => {
        try {
          return await requirePlans().continueRework(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_TAKE_OVER_REWORK_METHOD]: defineMethod(
      PlanReworkActionParams,
      PlanReworkActionResult,
      (params) => {
        try {
          return requirePlans().takeOverRework(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_CONVERT_TO_TASK_METHOD]: defineMethod(
      PlanConvertToTaskParams,
      PlanConvertToTaskResult,
      (params) => {
        try {
          return requirePlans().convertToTask(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),
    [PLAN_CONVERT_TO_PROJECT_METHOD]: defineMethod(
      PlanConvertToProjectParams,
      PlanConvertToProjectResult,
      (params) => {
        try {
          return requirePlans().convertToProject(params)
        } catch (error) {
          return planError(error)
        }
      },
    ),

    [RUNTIME_PROVIDER_LIST_METHOD]: defineMethod(
      RuntimeProviderListParams,
      RuntimeProviderListResult,
      () => ({ providers: services.registry.list() }),
      'read',
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
    [EXECUTION_GET_METHOD]: defineMethod(
      ExecutionGetParams,
      ExecutionGetResult,
      (params) => ({
        execution: services.executions.get(params.executionId),
        logs: services.executions.logsFor({ executionId: params.executionId }),
      }),
      'read',
    ),
    [EXECUTION_LIST_METHOD]: defineMethod(
      ExecutionListParams,
      ExecutionListResult,
      (params) => ({
        executions: services.executions.list(params.limit ?? 50),
      }),
      'read',
    ),
    [EXECUTION_LOGS_METHOD]: defineMethod(
      ExecutionLogsParams,
      ExecutionLogsResult,
      (params) => ({
        logs: services.executions.logsFor(params),
      }),
      'read',
    ),
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
    [EXECUTION_STATUS_METHOD]: defineMethod(
      ExecutionStatusParams,
      ExecutionResult,
      (params) => ({
        execution: services.executions.get(params.executionId),
      }),
      'read',
    ),

    // ---- 阶段 2：Team ----
    [TEAM_LIST_METHOD]: defineMethod(
      TeamListParams,
      TeamListResult,
      (params) => ({
        teams: services.teams.list(params.includeArchived ?? false),
      }),
      'read',
    ),
    [TEAM_GET_METHOD]: defineMethod(
      TeamGetParams,
      TeamResult,
      (params) => ({
        team: services.teams.get(params.id),
      }),
      'read',
    ),
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
      'read',
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
    [WORK_LIST_METHOD]: defineMethod(
      WorkListParams,
      WorkListResult,
      (params) => ({
        works: services.works
          .list(params.includeArchived ?? false, params.projectId)
          .map((work) => ({ ...work, teamIds: services.works.listTeamIds(work.id) })),
      }),
      'read',
    ),
    [PROJECT_LIST_METHOD]: defineMethod(
      ProjectListParams,
      ProjectListResult,
      () => {
        try {
          return requireProjects().list()
        } catch (error) {
          return projectError(error)
        }
      },
      'read',
    ),
    [PROJECT_GET_METHOD]: defineMethod(
      ProjectGetParams,
      ProjectResult,
      (params) => {
        try {
          return { project: requireProjects().get(params.id) }
        } catch (error) {
          return projectError(error)
        }
      },
      'read',
    ),
    [PROJECT_CREATE_METHOD]: defineMethod(ProjectCreateParams, ProjectResult, (params) => {
      try {
        return { project: requireProjects().create(params) }
      } catch (error) {
        return projectError(error)
      }
    }),
    [PROJECT_UPDATE_METHOD]: defineMethod(ProjectUpdateParams, ProjectResult, (params) => {
      try {
        return { project: requireProjects().update(params) }
      } catch (error) {
        return projectError(error)
      }
    }),
    [WORK_GET_METHOD]: defineMethod(
      WorkGetParams,
      WorkResult,
      (params) => ({
        work: toWorkDto(services, params.id),
      }),
      'read',
    ),
    [WORK_CREATE_METHOD]: defineMethod(WorkCreateParams, WorkResult, (params) => ({
      work: { ...services.works.create(params), teamIds: [] },
    })),
    [WORK_LINK_TEAM_METHOD]: defineMethod(WorkLinkTeamParams, WorkResult, (params) => {
      services.works.linkTeam(params.workId, params.teamId)
      return { work: toWorkDto(services, params.workId) }
    }),
    [WORK_ACTIVATE_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'activate'),
    })),
    [WORK_PAUSE_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'pause'),
    })),
    [WORK_RESUME_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'resume'),
    })),
    [WORK_COMPLETE_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'complete'),
    })),
    [WORK_TERMINATE_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'terminate'),
    })),
    [WORK_ARCHIVE_METHOD]: defineMethod(WorkIdParams, WorkResult, async (params) => ({
      work: await toWorkDtoAfter(services, params.id, 'archive'),
    })),

    // ---- 阶段 2：Assignment ----
    // ---- 阶段 2：Worktree ----
    [WORKTREE_LIST_METHOD]: defineMethod(
      WorktreeListParams,
      WorktreeListResult,
      (params) => ({
        worktrees: services.worktrees.list(params.workId),
      }),
      'read',
    ),
    [WORKTREE_CREATE_METHOD]: defineMethod(
      WorktreeCreateParams,
      WorktreeCreateResult,
      (params) => ({
        worktree: services.worktrees.create(params),
      }),
    ),
    [WORKTREE_REMOVE_METHOD]: defineMethod(
      WorktreeRemoveParams,
      WorktreeRemoveResult,
      (params) => ({
        worktree: services.worktrees.remove(params.id, params.confirm),
      }),
    ),

    [ASSIGNMENT_LIST_METHOD]: defineMethod(
      AssignmentListParams,
      AssignmentListResult,
      (params) => ({ assignments: services.assignments.listByWork(params.workId) }),
      'read',
    ),
    [ASSIGNMENT_GET_METHOD]: defineMethod(
      AssignmentGetParams,
      AssignmentResult,
      (params) => ({
        assignment: services.assignments.get(params.id),
      }),
      'read',
    ),
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

    [BACKUP_CREATE_METHOD]: defineMethod(BackupCreateParamsValue, BackupResultValue, (params) => ({
      backup: services.backups.create(params.type),
    })),
    [BACKUP_LIST_METHOD]: defineMethod(
      BackupListParamsValue,
      BackupListResultValue,
      (params) => ({
        backups: services.backups.list(params.limit),
      }),
      'read',
    ),
    [BACKUP_EXPORT_METHOD]: defineMethod(
      BackupExportParamsValue,
      BackupExportResultValue,
      (params) => ({ target: services.backups.exportTo(params.backupId, params.targetDir) }),
    ),
    [BACKUP_RESTORE_PRECHECK_METHOD]: defineMethod(
      BackupRestorePrecheckParamsValue,
      BackupRestorePrecheckResultValue,
      (params) => services.backupPrecheck.precheck(params.backupId),
      'read',
    ),

    // S55-2C：异步接受（进入 maintenance 前的最后外部写入口）；maintenance gate 仍拦截
    // entering_maintenance 之后的重复请求（RESTORE_ALREADY_ACTIVE 由服务层返回）。
    [BACKUP_RESTORE_METHOD]: defineMethod(
      BackupRestoreParamsValue,
      BackupRestoreAcceptedValue,
      (params) => {
        if (!services.restore) {
          throw new RpcMethodError('INTERNAL', 'restore coordinator is not configured')
        }
        try {
          return services.restore.request(params.backupId)
        } catch (error) {
          if (error instanceof RestoreCoordinatorError) {
            throw new RpcMethodError(error.code, error.message)
          }
          throw error
        }
      },
    ),

    // S55-2C：只读状态查询，可对照 boot.sock / 业务 socket 任一入口。
    [RESTORE_STATUS_METHOD]: defineMethod(
      RestoreStatusParamsValue,
      RestoreStatusResultValue,
      (params) => {
        const journal = services.restore?.status() ?? null
        const target =
          journal && (!params.journalId || journal.journalId === params.journalId) ? journal : null
        if (params.journalId && !target) {
          throw new RpcMethodError(
            'EXECUTION_NOT_FOUND',
            `restore journal not found: ${params.journalId}`,
          )
        }
        return {
          active: target !== null,
          journalId: target?.journalId ?? null,
          backupId: target?.backupId ?? null,
          phase: target?.phase ?? null,
          globalRevision: target?.globalRevision ?? null,
          operations:
            target?.operations.map((operation) => ({
              operationId: operation.operationId,
              kind: operation.kind,
              status: operation.status,
              opRev: operation.opRev,
            })) ?? [],
          currentOperationId: target?.currentOperationId ?? null,
          errorCode: target?.lastError?.code ?? null,
          recoveryLocked:
            target?.phase === 'recovery_locked' || target?.phase === 'rollback_failed',
          manualInterventionRequired:
            target?.phase === 'recovery_locked' || target?.phase === 'rollback_failed',
          updatedAt: target?.updatedAt ?? null,
        }
      },
      'read',
    ),

    [ARTIFACT_PREVIEW_METHOD]: defineMethod(
      ArtifactPreviewParams,
      ArtifactPreviewResult,
      (params) => services.artifacts.preview(params),
      'read',
    ),
    [ARTIFACT_LIST_METHOD]: defineMethod(
      ArtifactListParams,
      ArtifactListResult,
      (params) => services.artifacts.listByWork(params.workId),
      'read',
    ),

    [APPROVAL_DECIDE_METHOD]: defineMethod(ApprovalDecideParams, ApprovalResult, async (params) => {
      const approval = services.approvals.decide(params)
      // decide 返回时事务已提交。幂等重试可以重新唤醒调度，但 CAS 不会重复启动节点。
      if (params.decision !== 'reject') await services.workflowEngine?.kick(approval.workflowRunId)
      return { approval }
    }),
    [APPROVAL_GET_METHOD]: defineMethod(
      ApprovalGetParams,
      ApprovalGetResult,
      (params) => services.approvals.get(params.nodeRunId),
      'read',
    ),
    [APPROVAL_LIST_PENDING_METHOD]: defineMethod(
      ApprovalListPendingParams,
      ApprovalListPendingResult,
      (params) => ({ approvals: services.approvals.listPending(params.runId) }),
      'read',
    ),

    [WORKFLOW_RUN_GET_METHOD]: defineMethod(
      WorkflowRunGetParams,
      WorkflowRunGetResult,
      (params) => {
        try {
          const view = services.workflowRuns.get(params.runId)
          return {
            run: view.run,
            branches: view.branches,
            nodes: view.nodes.map((node) => ({
              id: node.id,
              workflowNodeKey: node.workflowNodeKey,
              branchRunId: node.branchRunId,
              status: node.status,
              attempt: node.attempt,
              output: node.outputSnapshot,
              error: node.error,
              startedAt: node.startedAt,
              endedAt: node.endedAt,
            })),
          }
        } catch (error) {
          if (error instanceof WorkflowRunQueryError) {
            throw new RpcMethodError('INVALID_PARAMS', error.message)
          }
          throw error
        }
      },
      'read',
    ),

    [EVENTS_SUBSCRIBE_METHOD]: defineMethod(
      EventsSubscribeParams,
      EventsSubscribeResult,
      (_params, ctx) => {
        const unsubscribe = services.hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
      'read',
    ),
  }
}
