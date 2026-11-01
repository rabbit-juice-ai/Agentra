import { z } from 'zod'
import { IsoTimestamp } from '../dto'

/**
 * 阶段 3：工作流定义层 RPC（只做模板与版本的 CRUD / 校验 / 发布）。
 * 不定义任何 `workflow.run.*` —— 执行入口属阶段 4，本版本不得暴露。
 */

export const WORKFLOW_TEMPLATE_LIST_METHOD = 'workflow.template.list'
export const WORKFLOW_TEMPLATE_GET_METHOD = 'workflow.template.get'
export const WORKFLOW_TEMPLATE_CREATE_METHOD = 'workflow.template.create'
export const WORKFLOW_TEMPLATE_UPDATE_METHOD = 'workflow.template.update'
export const WORKFLOW_TEMPLATE_ARCHIVE_METHOD = 'workflow.template.archive'
export const WORKFLOW_VERSION_LIST_METHOD = 'workflow.version.list'
export const WORKFLOW_VERSION_GET_METHOD = 'workflow.version.get'
export const WORKFLOW_VERSION_CREATE_DRAFT_METHOD = 'workflow.version.createDraft'
export const WORKFLOW_VERSION_PUBLISH_METHOD = 'workflow.version.publish'
export const WORKFLOW_VERSION_VALIDATE_METHOD = 'workflow.version.validate'

/** S4-7：只读运行态查询（不是执行入口；恢复后的 reconciliation_required 必须可见）。 */
export const WORKFLOW_RUN_GET_METHOD = 'workflow.run.get'
/** S5-3b：按 Work 列出 Run（只读；供失败终态呈现定位 Run，不是执行入口）。 */
export const WORKFLOW_RUN_LIST_BY_WORK_METHOD = 'workflow.run.listByWork'

/** S5-1：审批决策 API（领域事件 approval.decided 的协议入口）。 */
/** S5-3：Artifact 只读服务面（预览/元数据；创建走 Core 内部，不做通用透传）。 */
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

export const ApprovalListPendingParamsSchema = z.object({ runId: z.string().min(1) }).strict()
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

export const WorkflowTemplateListParams = z
  .object({ includeArchived: z.boolean().optional() })
  .strict()
export type WorkflowTemplateListParams = z.infer<typeof WorkflowTemplateListParams>

export const WorkflowTemplateListResult = z.object({ templates: z.array(WorkflowTemplate) })
export type WorkflowTemplateListResult = z.infer<typeof WorkflowTemplateListResult>

export const WorkflowTemplateGetParams = z.object({ id: z.string().min(1) }).strict()
export type WorkflowTemplateGetParams = z.infer<typeof WorkflowTemplateGetParams>

export const WorkflowTemplateResult = z.object({ template: WorkflowTemplate })
export type WorkflowTemplateResult = z.infer<typeof WorkflowTemplateResult>

export const WorkflowTemplateCreateParams = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.string().max(100).optional(),
  })
  .strict()
export type WorkflowTemplateCreateParams = z.infer<typeof WorkflowTemplateCreateParams>

export const WorkflowTemplateUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    category: z.string().max(100).optional(),
  })
  .strict()
export type WorkflowTemplateUpdateParams = z.infer<typeof WorkflowTemplateUpdateParams>

export const WorkflowTemplateIdParams = z.object({ id: z.string().min(1) }).strict()
export type WorkflowTemplateIdParams = z.infer<typeof WorkflowTemplateIdParams>

export const WorkflowVersionListParams = z.object({ templateId: z.string().min(1) }).strict()
export type WorkflowVersionListParams = z.infer<typeof WorkflowVersionListParams>

/** 列表中被跳过的不可读行：可诊断，但不阻塞其余版本。 */
export const WorkflowVersionSkip = z.object({
  id: z.string().min(1),
  version: z.number().int().nullable(),
  reason: z.string().min(1),
})
export type WorkflowVersionSkip = z.infer<typeof WorkflowVersionSkip>

export const WorkflowVersionListResult = z.object({
  versions: z.array(WorkflowVersion),
  skipped: z.array(WorkflowVersionSkip).default([]),
})
export type WorkflowVersionListResult = z.infer<typeof WorkflowVersionListResult>

export const WorkflowVersionGetParams = z.object({ versionId: z.string().min(1) }).strict()
export type WorkflowVersionGetParams = z.infer<typeof WorkflowVersionGetParams>

export const WorkflowVersionResult = z.object({ version: WorkflowVersion })
export type WorkflowVersionResult = z.infer<typeof WorkflowVersionResult>

export const WorkflowVersionCreateDraftParams = z
  .object({ templateId: z.string().min(1), definition: z.unknown() })
  .strict()
export type WorkflowVersionCreateDraftParams = z.infer<typeof WorkflowVersionCreateDraftParams>

export const WorkflowVersionPublishParams = z.object({ versionId: z.string().min(1) }).strict()
export type WorkflowVersionPublishParams = z.infer<typeof WorkflowVersionPublishParams>

export const WorkflowVersionValidateParams = z.object({ definition: z.unknown() }).strict()
export type WorkflowVersionValidateParams = z.infer<typeof WorkflowVersionValidateParams>

/** 与 publish 失败时的 detail.violations 结构完全一致（WORKFLOW §2）。 */
export const WorkflowVersionValidateResult = z.object({
  valid: z.boolean(),
  violations: z.array(WorkflowViolation),
})
export type WorkflowVersionValidateResult = z.infer<typeof WorkflowVersionValidateResult>

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

export const WorkflowRunListByWorkParams = z.object({ workId: z.string().min(1) }).strict()
export type WorkflowRunListByWorkParams = z.infer<typeof WorkflowRunListByWorkParams>

export const WorkflowRunListByWorkResult = z.object({
  runs: z.array(WorkflowRun),
})
export type WorkflowRunListByWorkResult = z.infer<typeof WorkflowRunListByWorkResult>
export type WorkflowRunGetParams = z.infer<typeof WorkflowRunGetParams>

export const WorkflowRunGetResult = z.object({
  run: WorkflowRun,
  branches: z.array(WorkflowRunBranch),
  nodes: z.array(WorkflowRunNode),
})
export type WorkflowRunGetResult = z.infer<typeof WorkflowRunGetResult>

export {
  ApprovalDecideParamsSchema as ApprovalDecideParams,
  ApprovalGetParamsSchema as ApprovalGetParams,
  ApprovalGetResultSchema as ApprovalGetResult,
  ApprovalListPendingParamsSchema as ApprovalListPendingParams,
  ApprovalListPendingResultSchema as ApprovalListPendingResult,
  ApprovalResultSchema as ApprovalResult,
}

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
