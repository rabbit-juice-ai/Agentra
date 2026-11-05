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
  WORKFLOW_RUN_LIST_BY_WORK_METHOD,
  WORKFLOW_TEMPLATE_ARCHIVE_METHOD,
  WORKFLOW_TEMPLATE_CREATE_METHOD,
  WORKFLOW_TEMPLATE_GET_METHOD,
  WORKFLOW_TEMPLATE_LIST_METHOD,
  WORKFLOW_TEMPLATE_UPDATE_METHOD,
  WORKFLOW_VERSION_CREATE_DRAFT_METHOD,
  WORKFLOW_VERSION_GET_METHOD,
  WORKFLOW_VERSION_LIST_METHOD,
  WORKFLOW_VERSION_PUBLISH_METHOD,
  WORKFLOW_VERSION_VALIDATE_METHOD,
  WORKTREE_CREATE_METHOD,
  WORKTREE_LIST_METHOD,
  WORKTREE_REMOVE_METHOD,
  WorkCreateParams,
  type Work as WorkDto,
  WorkflowRunGetParams,
  WorkflowRunGetResult,
  WorkflowRunListByWorkParams,
  WorkflowRunListByWorkResult,
  WorkflowTemplateCreateParams,
  WorkflowTemplateGetParams,
  WorkflowTemplateIdParams,
  WorkflowTemplateListParams,
  WorkflowTemplateListResult,
  WorkflowTemplateResult,
  WorkflowTemplateUpdateParams,
  WorkflowVersionCreateDraftParams,
  WorkflowVersionGetParams,
  WorkflowVersionListParams,
  WorkflowVersionListResult,
  WorkflowVersionPublishParams,
  WorkflowVersionResult,
  WorkflowVersionValidateParams,
  WorkflowVersionValidateResult,
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
import { validateWorkflowDefinition } from '@agentra/workflow-schema'
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
import type { ProviderRegistry } from '../services/provider-registry'
import type { RestoreCoordinator } from '../services/restore-coordinator'
import { RestoreCoordinatorError } from '../services/restore-coordinator'
import type { TeamService } from '../services/team-service'
import type { WorkService } from '../services/work-service'
import {
  WorkflowDefinitionError,
  type WorkflowDefinitionService,
} from '../services/workflow-definition-service'
import type { WorktreeService } from '../services/worktree-service'
import { WorkflowRunQueryError, type WorkflowRunQueryService } from '../workflow/run-query-service'
import type { MethodTable, RpcMethodDef } from './dispatcher'

export type CoreMethodServices = {
  agents: AgentService
  registry: ProviderRegistry
  executions: ExecutionService
  hub: CoreEventHub
  teams: TeamService
  works: WorkService
  assignments: AssignmentService
  worktrees: WorktreeService
  workflows: WorkflowDefinitionService
  workflowRuns: WorkflowRunQueryService
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
function toWorkDtoAfter(
  services: CoreMethodServices,
  id: string,
  action: 'activate' | 'pause' | 'resume' | 'complete' | 'terminate' | 'archive',
): WorkDto {
  services.works[action](id)
  return toWorkDto(services, id)
}

/**
 * 定义层错误 → RPC 错误码：
 * - UNKNOWN_NODE_TYPE 是错误码，不是 violation；
 * - 其余定义/版本错误统一 INVALID_PARAMS，violations 放 detail（与 validate 返回结构一致）。
 */
function runWorkflow<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) {
      const detail = error.violations.length > 0 ? { violations: error.violations } : undefined
      if (error.code === 'UNKNOWN_NODE_TYPE') {
        throw new RpcMethodError('UNKNOWN_NODE_TYPE', error.message, detail)
      }
      throw new RpcMethodError('INVALID_PARAMS', error.message, detail)
    }
    throw error
  }
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
          .list(params.includeArchived ?? false)
          .map((work) => ({ ...work, teamIds: services.works.listTeamIds(work.id) })),
      }),
      'read',
    ),
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

    [WORKFLOW_TEMPLATE_LIST_METHOD]: defineMethod(
      WorkflowTemplateListParams,
      WorkflowTemplateListResult,
      (params) => ({
        templates: services.workflows
          .listTemplates()
          .filter((template) => params.includeArchived === true || template.archivedAt === null),
      }),
      'read',
    ),
    [WORKFLOW_TEMPLATE_GET_METHOD]: defineMethod(
      WorkflowTemplateGetParams,
      WorkflowTemplateResult,
      (params) => runWorkflow(() => ({ template: services.workflows.getTemplate(params.id) })),
      'read',
    ),
    [WORKFLOW_TEMPLATE_CREATE_METHOD]: defineMethod(
      WorkflowTemplateCreateParams,
      WorkflowTemplateResult,
      (params) => ({ template: services.workflows.createTemplate(params) }),
    ),
    [WORKFLOW_TEMPLATE_UPDATE_METHOD]: defineMethod(
      WorkflowTemplateUpdateParams,
      WorkflowTemplateResult,
      (params) =>
        runWorkflow(() => ({
          template: services.workflows.updateTemplate(params.id, {
            name: params.name,
            description: params.description,
            category: params.category,
          }),
        })),
    ),
    [WORKFLOW_TEMPLATE_ARCHIVE_METHOD]: defineMethod(
      WorkflowTemplateIdParams,
      WorkflowTemplateResult,
      (params) =>
        runWorkflow(() => {
          services.workflows.archiveTemplate(params.id)
          return { template: services.workflows.getTemplate(params.id) }
        }),
    ),

    [WORKFLOW_VERSION_LIST_METHOD]: defineMethod(
      WorkflowVersionListParams,
      WorkflowVersionListResult,
      (params) => services.workflows.listVersions(params.templateId),
      'read',
    ),
    [WORKFLOW_VERSION_GET_METHOD]: defineMethod(
      WorkflowVersionGetParams,
      WorkflowVersionResult,
      (params) => runWorkflow(() => ({ version: services.workflows.getVersion(params.versionId) })),
      'read',
    ),
    [WORKFLOW_VERSION_CREATE_DRAFT_METHOD]: defineMethod(
      WorkflowVersionCreateDraftParams,
      WorkflowVersionResult,
      (params) =>
        runWorkflow(() => ({
          version: services.workflows.createDraft(params.templateId, params.definition),
        })),
    ),
    [WORKFLOW_VERSION_PUBLISH_METHOD]: defineMethod(
      WorkflowVersionPublishParams,
      WorkflowVersionResult,
      (params) => runWorkflow(() => ({ version: services.workflows.publish(params.versionId) })),
    ),
    [WORKFLOW_VERSION_VALIDATE_METHOD]: defineMethod(
      WorkflowVersionValidateParams,
      WorkflowVersionValidateResult,
      (params) => {
        const outcome = validateWorkflowDefinition(params.definition)
        if (outcome.ok) return { valid: true, violations: [] }
        if (outcome.kind === 'error') {
          throw new RpcMethodError('UNKNOWN_NODE_TYPE', outcome.message)
        }
        return { valid: false, violations: outcome.violations }
      },
      'read',
    ),

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

    [WORKFLOW_RUN_LIST_BY_WORK_METHOD]: defineMethod(
      WorkflowRunListByWorkParams,
      WorkflowRunListByWorkResult,
      (params) => ({ runs: services.workflowRuns.listByWork(params.workId) }),
      'read',
    ),

    [APPROVAL_DECIDE_METHOD]: defineMethod(ApprovalDecideParams, ApprovalResult, (params) => ({
      approval: services.approvals.decide(params),
    })),
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
