import type {
  WorkflowTemplate,
  WorkflowVersion,
  WorkflowVersionSkip,
  WorkflowViolation,
} from '@agentra/protocol'
import { unwrap } from '../../services/api'
import type { WorkflowDefinition } from './types'

/** 定义层 API：只调用 B2 暴露的 workflow.* 方法，不触碰任何执行入口。 */
export const workflowApi = {
  listTemplates: async (includeArchived = true): Promise<WorkflowTemplate[]> =>
    (await unwrap(window.agentra.listWorkflowTemplates({ includeArchived }))).templates,

  createTemplate: async (name: string): Promise<WorkflowTemplate> =>
    (await unwrap(window.agentra.createWorkflowTemplate({ name }))).template,

  archiveTemplate: async (id: string): Promise<WorkflowTemplate> =>
    (await unwrap(window.agentra.archiveWorkflowTemplate({ id }))).template,

  listVersions: async (
    templateId: string,
  ): Promise<{ versions: WorkflowVersion[]; skipped: WorkflowVersionSkip[] }> =>
    unwrap(window.agentra.listWorkflowVersions({ templateId })),

  createDraft: async (
    templateId: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowVersion> =>
    (await unwrap(window.agentra.createWorkflowDraft({ templateId, definition }))).version,

  publish: async (versionId: string): Promise<WorkflowVersion> =>
    (await unwrap(window.agentra.publishWorkflowVersion({ versionId }))).version,

  validate: async (
    definition: unknown,
  ): Promise<{ valid: boolean; violations: WorkflowViolation[] }> =>
    unwrap(window.agentra.validateWorkflowDefinition({ definition })),
}
