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

export const WorkflowVersionListResult = z.object({ versions: z.array(WorkflowVersion) })
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
