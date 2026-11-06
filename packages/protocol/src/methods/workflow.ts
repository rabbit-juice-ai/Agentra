import { z } from 'zod'
import { IsoTimestamp } from '../dto'

/**
 * 执行内核只读查询。工作流模板/版本的产品级 CRUD 已移除：
 * 定义由 PlanCompiler 在 PlanService 内部生成，不对外暴露编辑入口。
 */

/** S4-7：只读运行态查询（不是执行入口；恢复后的 reconciliation_required 必须可见）。 */
export const WORKFLOW_RUN_GET_METHOD = 'workflow.run.get'

/** S5-1：审批决策 API（领域事件 approval.decided 的协议入口）。 */
/** S5-3：Artifact 只读服务面（预览/元数据；创建走 Core 内部，不做通用透传）。 */
/** S55-1：备份链（手动创建 / 列表 / 导出；恢复属 S55-2）。 */
export const BACKUP_CREATE_METHOD = 'backup.create'
export const BACKUP_LIST_METHOD = 'backup.list'
export const BACKUP_EXPORT_METHOD = 'backup.export'
/** S55-2A：恢复预检（只读；实际恢复不在本阶段）。 */
export const BACKUP_RESTORE_PRECHECK_METHOD = 'backup.restorePrecheck'
/** S55-2C：异步接受 Restore 请求（只允许已登记 backupId）。 */
export const BACKUP_RESTORE_METHOD = 'backup.restore'
/** S55-2C：只读查询活动 Restore Journal 快照。 */
export const RESTORE_STATUS_METHOD = 'restore.status'

export const ARTIFACT_PREVIEW_METHOD = 'artifact.preview'
export const ARTIFACT_LIST_METHOD = 'artifact.list'
export const APPROVAL_DECIDE_METHOD = 'approval.decide'
export const APPROVAL_GET_METHOD = 'approval.get'
export const APPROVAL_LIST_PENDING_METHOD = 'approval.listPending'

export const ApprovalDecisionEnum = z.enum(['approve', 'request_changes', 'reject'])
export type ApprovalDecisionValue = z.infer<typeof ApprovalDecisionEnum>

export const ApprovalStatusEnum = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'cancelled',
])
export type ApprovalStatusValue = z.infer<typeof ApprovalStatusEnum>

export const Approval = z.object({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  nodeRunId: z.string().min(1),
  targetNodeRunId: z.string().nullable(),
  approvalType: z.string().min(1),
  status: ApprovalStatusEnum,
  requestedBy: z.string().min(1),
  decidedBy: z.string().nullable(),
  decisionComment: z.string().nullable(),
  round: z.number().int().min(1),
  reworkRequestId: z.string().nullable(),
  requestedAt: IsoTimestamp,
  decidedAt: IsoTimestamp.nullable(),
})
export type Approval = z.infer<typeof Approval>

export const ApprovalDecideParamsSchema = z
  .object({
    nodeRunId: z.string().min(1),
    decision: ApprovalDecisionEnum,
    decidedBy: z.string().min(1),
    /** request_changes 必填（A3）；approve/reject 可空。 */
    comment: z.string().max(20_000).optional(),
  })
  .strict()
export type ApprovalDecideParams = z.infer<typeof ApprovalDecideParams>

export const ApprovalResultSchema = z.object({ approval: Approval })
export type ApprovalResult = z.infer<typeof ApprovalResult>

export const ApprovalGetParamsSchema = z.object({ nodeRunId: z.string().min(1) }).strict()
export type ApprovalGetParams = z.infer<typeof ApprovalGetParams>

export const ApprovalGetResultSchema = z.object({
  approval: Approval.nullable(),
  history: z.array(Approval),
})
export type ApprovalGetResult = z.infer<typeof ApprovalGetResult>

export const ApprovalListPendingParamsSchema = z
  .object({ runId: z.string().min(1).optional() })
  .strict()
export type ApprovalListPendingParams = z.infer<typeof ApprovalListPendingParams>

export const ApprovalListPendingResultSchema = z.object({ approvals: z.array(Approval) })
export type ApprovalListPendingResult = z.infer<typeof ApprovalListPendingResult>

export const WorkflowVersionStatus = z.enum(['draft', 'published', 'deprecated'])
export type WorkflowVersionStatus = z.infer<typeof WorkflowVersionStatus>

export const WorkflowTemplate = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  archivedAt: IsoTimestamp.nullable(),
})
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>

export const WorkflowVersion = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  version: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  /** 存储的是 Zod parse 后的定义（默认值已填充、未知字段已剔除），不是客户端原始 JSON。 */
  definition: z.unknown(),
  checksum: z.string().min(1),
  status: WorkflowVersionStatus,
  createdAt: IsoTimestamp,
  publishedAt: IsoTimestamp.nullable(),
})
export type WorkflowVersion = z.infer<typeof WorkflowVersion>

/**
 * violation 的成员闭集（16 项）由 WORKFLOW §2 定义、由 @agentra/workflow-schema 产出；
 * 这里只校验形状——协议层不复制第二份枚举，避免两处漂移。
 */
export const WorkflowViolation = z.object({
  violation: z.string().min(1),
  nodeKey: z.string().min(1).optional(),
  edgeKey: z.string().min(1).optional(),
  message: z.string().min(1),
})
export type WorkflowViolation = z.infer<typeof WorkflowViolation>

export const WorkflowRun = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  status: z.string().min(1),
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type WorkflowRun = z.infer<typeof WorkflowRun>

export const WorkflowRunBranch = z.object({
  id: z.string().min(1),
  branchKey: z.string().min(1),
  status: z.string().min(1),
  pauseReason: z.string().nullable(),
  pausedAt: IsoTimestamp.nullable(),
  resumedAt: IsoTimestamp.nullable(),
})
export type WorkflowRunBranch = z.infer<typeof WorkflowRunBranch>

export const WorkflowRunNode = z.object({
  id: z.string().min(1),
  workflowNodeKey: z.string().min(1),
  branchRunId: z.string().nullable(),
  status: z.string().min(1),
  attempt: z.number().int().min(1),
  output: z.unknown().nullable(),
  error: z.unknown().nullable(),
  startedAt: IsoTimestamp.nullable(),
  endedAt: IsoTimestamp.nullable(),
})
export type WorkflowRunNode = z.infer<typeof WorkflowRunNode>

export const WorkflowRunGetParams = z.object({ runId: z.string().min(1) }).strict()
export type WorkflowRunGetParams = z.infer<typeof WorkflowRunGetParams>

export const WorkflowRunGetResult = z.object({
  run: WorkflowRun,
  branches: z.array(WorkflowRunBranch),
  nodes: z.array(WorkflowRunNode),
})
export type WorkflowRunGetResult = z.infer<typeof WorkflowRunGetResult>

export const ApprovalDecideParams = ApprovalDecideParamsSchema
export const ApprovalGetParams = ApprovalGetParamsSchema
export const ApprovalGetResult = ApprovalGetResultSchema
export const ApprovalListPendingParams = ApprovalListPendingParamsSchema
export const ApprovalListPendingResult = ApprovalListPendingResultSchema
export const ApprovalResult = ApprovalResultSchema

export const WorkflowArtifactRef = z
  .object({
    name: z.string(),
    artifactId: z.string(),
    versionId: z.string(),
    version: z.number().int().positive(),
    nodeRunId: z.string(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
export type WorkflowArtifactRef = z.infer<typeof WorkflowArtifactRef>

export const ArtifactVersion = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  version: z.number().int().min(1),
  storagePath: z.string().min(1),
  checksum: z.string().min(1),
  createdAt: IsoTimestamp,
})
export type ArtifactVersion = z.infer<typeof ArtifactVersion>

export const ArtifactRecord = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  nodeRunId: z.string().nullable(),
  artifactType: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  mimeType: z.string().nullable(),
  createdAt: IsoTimestamp,
})
export type ArtifactRecord = z.infer<typeof ArtifactRecord>

export const ArtifactPreviewParamsSchema = z
  .object({ artifactId: z.string().min(1), version: z.number().int().min(1).optional() })
  .strict()
export type ArtifactPreviewParams = z.infer<typeof ArtifactPreviewParamsSchema>

export const ArtifactPreviewResultSchema = z.object({
  artifact: ArtifactRecord,
  version: ArtifactVersion,
  /** base64 编码的文件内容；文本类 UI 可自行解码。 */
  contentBase64: z.string(),
})
export type ArtifactPreviewResult = z.infer<typeof ArtifactPreviewResultSchema>

export const ArtifactListParamsSchema = z.object({ workId: z.string().min(1) }).strict()
export type ArtifactListParams = z.infer<typeof ArtifactListParamsSchema>

export const ArtifactListResultSchema = z.object({
  artifacts: z.array(ArtifactRecord.extend({ versions: z.array(ArtifactVersion) })),
})
export type ArtifactListResult = z.infer<typeof ArtifactListResultSchema>

export {
  ArtifactListParamsSchema as ArtifactListParams,
  ArtifactListResultSchema as ArtifactListResult,
  ArtifactPreviewParamsSchema as ArtifactPreviewParams,
  ArtifactPreviewResultSchema as ArtifactPreviewResult,
}

export const BackupType = z.enum(['manual', 'pre_restore'])
export type BackupType = z.infer<typeof BackupType>

export const BackupStatus = z.enum(['creating', 'completed', 'failed', 'verified', 'restored'])
export type BackupStatus = z.infer<typeof BackupStatus>

export const Backup = z.object({
  id: z.string().min(1),
  type: BackupType,
  manifestVersion: z.number().int().min(1),
  dbSha256: z.string().nullable(),
  fileCount: z.number().int().min(0),
  status: BackupStatus,
  storagePath: z.string().min(1),
  error: z.unknown().nullable(),
  createdAt: IsoTimestamp,
  completedAt: IsoTimestamp.nullable(),
  verifiedAt: IsoTimestamp.nullable(),
})
export type Backup = z.infer<typeof Backup>

export const BackupCreateParamsSchema = z.object({ type: BackupType.optional() }).strict()
export type BackupCreateParams = z.infer<typeof BackupCreateParamsSchema>

export const BackupListParamsSchema = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .strict()
export type BackupListParams = z.infer<typeof BackupListParamsSchema>

export const BackupListResultSchema = z.object({ backups: z.array(Backup) })
export type BackupListResult = z.infer<typeof BackupListResultSchema>

export const BackupResultSchema = z.object({ backup: Backup })
export type BackupResult = z.infer<typeof BackupResultSchema>

export const BackupExportParamsSchema = z
  .object({ backupId: z.string().min(1), targetDir: z.string().min(1) })
  .strict()
export type BackupExportParams = z.infer<typeof BackupExportParamsSchema>

export const BackupExportResultSchema = z.object({ target: z.string().min(1) })
export type BackupExportResult = z.infer<typeof BackupExportResultSchema>

// ---- S55-2A：恢复预检（只读） ----

export const BackupRestorePrecheckFailureCode = z.enum([
  'BACKUP_NOT_FOUND',
  'BACKUP_PATH_UNSAFE',
  'BACKUPS_ROOT_UNAVAILABLE',
  'MANIFEST_INVALID',
  'DATABASE_MISSING',
  'DATABASE_SIZE_MISMATCH',
  'DATABASE_SHA256_MISMATCH',
  'DATABASE_INTEGRITY_FAILED',
  'DATABASE_SCHEMA_INVALID',
  'ARTIFACT_MISSING',
  'ARTIFACT_SIZE_MISMATCH',
  'ARTIFACT_SHA256_MISMATCH',
  'ARTIFACT_PATH_UNSAFE',
  'ARTIFACT_MAPPING_MISMATCH',
  'SCHEMA_VERSION_UNSUPPORTED',
  'SCHEMA_VERSION_INVALID',
  'STORAGE_PATH_INCOMPATIBLE',
  'ARTIFACTS_ROOT_UNAVAILABLE',
  'PRECHECK_INTERNAL',
])
export type BackupRestorePrecheckFailureCode = z.infer<typeof BackupRestorePrecheckFailureCode>

export const BackupRestorePrecheckParamsSchema = z.object({ backupId: z.string().min(1) }).strict()
export type BackupRestorePrecheckParams = z.infer<typeof BackupRestorePrecheckParamsSchema>

export const BackupRestorePrecheckFailure = z.object({
  code: BackupRestorePrecheckFailureCode,
  message: z.string().min(1),
  detail: z.unknown().optional(),
})
export type BackupRestorePrecheckFailure = z.infer<typeof BackupRestorePrecheckFailure>

export const BackupRestorePrecheckDatabase = z.object({
  file: z.literal('database.db'),
  bytes: z.number().int().min(0),
  sha256: z.string().length(64),
  integrityCheck: z.enum(['ok', 'failed']),
  userVersion: z.number().int().min(0),
})
export type BackupRestorePrecheckDatabase = z.infer<typeof BackupRestorePrecheckDatabase>

export const BackupRestorePrecheckSchemaCompatibility = z.object({
  backupUserVersion: z.number().int().min(0),
  currentUserVersion: z.number().int().min(0),
  compatible: z.boolean(),
})
export type BackupRestorePrecheckSchemaCompatibility = z.infer<
  typeof BackupRestorePrecheckSchemaCompatibility
>

export const BackupRestorePrecheckResultSchema = z.object({
  backupId: z.string().min(1),
  type: BackupType.nullable(),
  createdAt: IsoTimestamp.nullable(),
  manifestVersion: z.number().int().min(1).nullable(),
  database: BackupRestorePrecheckDatabase.nullable(),
  artifactCount: z.number().int().min(0).nullable(),
  schemaCompatibility: BackupRestorePrecheckSchemaCompatibility.nullable(),
  allowedToRestore: z.boolean(),
  failure: BackupRestorePrecheckFailure.nullable(),
})
export type BackupRestorePrecheckResult = z.infer<typeof BackupRestorePrecheckResultSchema>

// ---- S55-2C：Restore 异步接受与只读状态 ----

export const RestorePhaseSchema = z.enum([
  'requested',
  'prepared',
  'drained',
  'handed_off',
  'capture',
  'capture_verified',
  'forward_replacement',
  'replaced',
  'self_row_fixing',
  'reconciling',
  'verifying',
  'verified',
  'completed',
  'rollback_in_progress',
  'rolled_back',
  'rollback_failed',
  'aborted',
  'recovery_locked',
])
export type RestorePhase = z.infer<typeof RestorePhaseSchema>

export const RestoreOperationKindSchema = z.enum([
  'db',
  'wal',
  'shm',
  'artifacts',
  'archive',
  'marker',
  'cleanup',
])
export type RestoreOperationKind = z.infer<typeof RestoreOperationKindSchema>

export const RestoreOperationStatusSchema = z.enum([
  'not_started',
  'intent',
  'capturing',
  'captured',
  'verifying',
  'verified',
  'installed',
  'done',
  'rb_staged',
  'rb_verified',
  'blocked',
])
export type RestoreOperationStatus = z.infer<typeof RestoreOperationStatusSchema>

export const RestoreOperationStatusViewSchema = z
  .object({
    operationId: z.string().min(1),
    kind: RestoreOperationKindSchema,
    status: RestoreOperationStatusSchema,
    opRev: z.number().int().min(1),
  })
  .strict()
export type RestoreOperationStatusView = z.infer<typeof RestoreOperationStatusViewSchema>

export const BackupRestoreParamsSchema = z.object({ backupId: z.string().min(1) }).strict()
export type BackupRestoreParams = z.infer<typeof BackupRestoreParamsSchema>

export const BackupRestoreAcceptedSchema = z
  .object({
    journalId: z.string().min(1),
    state: z.literal('requested'),
  })
  .strict()
export type BackupRestoreAccepted = z.infer<typeof BackupRestoreAcceptedSchema>

export const RestoreStatusParamsSchema = z
  .object({ journalId: z.string().min(1).optional() })
  .strict()
export type RestoreStatusParams = z.infer<typeof RestoreStatusParamsSchema>

export const RestoreStatusResultSchema = z
  .object({
    active: z.boolean(),
    journalId: z.string().nullable(),
    backupId: z.string().nullable(),
    phase: RestorePhaseSchema.nullable(),
    globalRevision: z.number().int().min(1).nullable(),
    operations: z.array(RestoreOperationStatusViewSchema),
    currentOperationId: z.string().nullable(),
    errorCode: z.string().nullable(),
    recoveryLocked: z.boolean(),
    manualInterventionRequired: z.boolean(),
    updatedAt: IsoTimestamp.nullable(),
  })
  .strict()
export type RestoreStatusResult = z.infer<typeof RestoreStatusResultSchema>

export {
  BackupCreateParamsSchema as BackupCreateParamsValue,
  BackupExportParamsSchema as BackupExportParamsValue,
  BackupExportResultSchema as BackupExportResultValue,
  BackupListParamsSchema as BackupListParamsValue,
  BackupListResultSchema as BackupListResultValue,
  BackupRestoreAcceptedSchema as BackupRestoreAcceptedValue,
  BackupRestoreParamsSchema as BackupRestoreParamsValue,
  BackupRestorePrecheckParamsSchema as BackupRestorePrecheckParamsValue,
  BackupRestorePrecheckResultSchema as BackupRestorePrecheckResultValue,
  BackupResultSchema as BackupResultValue,
  RestoreStatusParamsSchema as RestoreStatusParamsValue,
  RestoreStatusResultSchema as RestoreStatusResultValue,
}
