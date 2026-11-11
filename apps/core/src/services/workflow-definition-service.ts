import { newId } from '@agentra/shared'
import {
  computeChecksum,
  type Violation,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type {
  SkippedWorkflowVersion,
  UpdateWorkflowTemplateInput,
  WorkflowRepository,
  WorkflowTemplateRecord,
  WorkflowVersionRecord,
} from '../db/repositories/workflow-repository'

export type WorkflowDefinitionErrorCode =
  | 'INVALID_DEFINITION'
  | 'UNKNOWN_NODE_TYPE'
  | 'VERSION_CONFLICT'
  | 'CAS_FAILED'
  | 'NOT_FOUND'

/** 定义层错误：violations 与 RPC 的 detail.violations 同构（B2 负责映射到信封）。 */
export class WorkflowDefinitionError extends Error {
  constructor(
    readonly code: WorkflowDefinitionErrorCode,
    message: string,
    readonly violations: Violation[] = [],
  ) {
    super(message)
    this.name = 'WorkflowDefinitionError'
  }
}

/** node:sqlite 的 UNIQUE 约束错误（errcode 2067 = SQLITE_CONSTRAINT_UNIQUE）。 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { errcode?: unknown }).errcode === 2067) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes('UNIQUE constraint failed')
}

export type CreateTemplateInput = {
  name: string
  description?: string
  category?: string
}

/**
 * 工作流定义服务（阶段 3：只做定义、编辑、校验、保存、发布）。
 * 不创建任何 WorkflowRun / NodeRun / Execution。
 */
export class WorkflowDefinitionService {
  constructor(
    private readonly db: Database,
    private readonly workflows: WorkflowRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createTemplate(input: CreateTemplateInput): WorkflowTemplateRecord {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new WorkflowDefinitionError('INVALID_DEFINITION', 'template name must not be blank')
    }
    return transaction(this.db, () =>
      this.workflows.createTemplate(
        {
          id: newId('wft'),
          name,
          description: input.description?.trim(),
          category: input.category?.trim(),
        },
        this.now(),
      ),
    )
  }

  /**
   * StartRun 专用：在调用方事务内创建 template + draft + published version。
   * 不自己开事务；任何失败由调用方整体回滚，避免 orphan workflow version。
   */
  createPublishedVersionInTransaction(
    input: {
      name: string
      description?: string
      category?: string
      definition: WorkflowDefinition
    },
    now: string,
  ): WorkflowVersionRecord {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new WorkflowDefinitionError('INVALID_DEFINITION', 'template name must not be blank')
    }
    const definition = this.validate(input.definition)
    const checksum = computeChecksum(definition)
    const template = this.workflows.createTemplate(
      {
        id: newId('wft'),
        name,
        description: input.description?.trim(),
        category: input.category?.trim(),
      },
      now,
    )
    const version = this.workflows.insertVersion(
      {
        id: newId('wfv'),
        templateId: template.id,
        version: this.workflows.nextVersionNumber(template.id),
        schemaVersion: definition.schemaVersion,
        definitionJson: JSON.stringify(definition),
        checksum,
      },
      now,
    )
    if (!this.workflows.casPublish(version.id, now)) {
      throw new WorkflowDefinitionError(
        'CAS_FAILED',
        `workflow version ${version.id} publish conflict`,
        [{ violation: 'cas_failed', message: 'concurrent publish detected' }],
      )
    }
    const published = this.workflows.getVersion(version.id)
    if (!published) {
      throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${version.id} not found`)
    }
    return published
  }

  getTemplate(id: string): WorkflowTemplateRecord {
    const template = this.workflows.getTemplate(id)
    if (!template) {
      throw new WorkflowDefinitionError('NOT_FOUND', `workflow template ${id} not found`)
    }
    return template
  }

  listTemplates(): WorkflowTemplateRecord[] {
    return this.workflows.listTemplates()
  }

  updateTemplate(id: string, patch: UpdateWorkflowTemplateInput): WorkflowTemplateRecord {
    const updated = transaction(this.db, () => this.workflows.updateTemplate(id, patch, this.now()))
    if (!updated) {
      throw new WorkflowDefinitionError('NOT_FOUND', `workflow template ${id} not found`)
    }
    return updated
  }

  archiveTemplate(id: string): void {
    const archived = transaction(this.db, () => this.workflows.archiveTemplate(id, this.now()))
    if (!archived) {
      throw new WorkflowDefinitionError(
        'NOT_FOUND',
        `workflow template ${id} not found or already archived`,
      )
    }
  }

  /**
   * 新建 draft：先校验定义，再算 checksum，最后在事务内取号 + 插入。
   * 并发取号撞车由 unique(template_id, version) 兜底，映射为 version_conflict。
   */
  createDraft(templateId: string, definitionInput: unknown): WorkflowVersionRecord {
    this.getTemplate(templateId)

    const definition = this.validate(definitionInput)
    const checksum = computeChecksum(definition)
    const now = this.now()

    try {
      return transaction(this.db, () => {
        const version = this.workflows.nextVersionNumber(templateId)
        return this.workflows.insertVersion(
          {
            id: newId('wfv'),
            templateId,
            version,
            schemaVersion: definition.schemaVersion,
            definitionJson: JSON.stringify(definition),
            checksum,
          },
          now,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowDefinitionError(
          'VERSION_CONFLICT',
          `workflow template ${templateId} version conflict; retry with a fresh version number`,
          [{ violation: 'version_conflict', message: 'workflow version already exists' }],
        )
      }
      throw error
    }
  }

  /**
   * 发布：事务内重新校验存储的定义 → 重算 checksum 与库中值比对 → CAS 置 published。
   * CAS 未命中（并发发布 / 已非 draft）映射为 cas_failed。
   */
  publish(versionId: string): WorkflowVersionRecord {
    const now = this.now()
    return transaction(this.db, () => {
      const record = this.workflows.getVersion(versionId)
      if (!record) {
        throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${versionId} not found`)
      }

      if (record.status !== 'draft') {
        throw new WorkflowDefinitionError(
          'CAS_FAILED',
          `workflow version ${versionId} is ${record.status}; only draft versions can be published`,
          [{ violation: 'cas_failed', message: `version is already ${record.status}` }],
        )
      }

      const definition = this.validate(record.definition)
      const checksum = computeChecksum(definition)
      if (checksum !== record.checksum) {
        throw new WorkflowDefinitionError(
          'INVALID_DEFINITION',
          `workflow version ${versionId} checksum mismatch: stored ${record.checksum}, recomputed ${checksum}`,
        )
      }

      if (!this.workflows.casPublish(versionId, now)) {
        throw new WorkflowDefinitionError(
          'CAS_FAILED',
          `workflow version ${versionId} publish conflict`,
          [{ violation: 'cas_failed', message: 'concurrent publish detected' }],
        )
      }

      const published = this.workflows.getVersion(versionId)
      if (!published) {
        throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${versionId} not found`)
      }
      return published
    })
  }

  deprecate(versionId: string): WorkflowVersionRecord {
    const now = this.now()
    return transaction(this.db, () => {
      const record = this.workflows.getVersion(versionId)
      if (!record) {
        throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${versionId} not found`)
      }
      if (record.status !== 'published') {
        throw new WorkflowDefinitionError(
          'CAS_FAILED',
          `workflow version ${versionId} is ${record.status}; only published versions can be deprecated`,
          [{ violation: 'cas_failed', message: `version is ${record.status}` }],
        )
      }
      this.workflows.deprecate(versionId, now)
      const deprecated = this.workflows.getVersion(versionId)
      if (!deprecated) {
        throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${versionId} not found`)
      }
      return deprecated
    })
  }

  getVersion(versionId: string): WorkflowVersionRecord {
    const record = this.workflows.getVersion(versionId)
    if (!record) {
      throw new WorkflowDefinitionError('NOT_FOUND', `workflow version ${versionId} not found`)
    }
    return record
  }

  listVersions(templateId: string): {
    versions: WorkflowVersionRecord[]
    skipped: SkippedWorkflowVersion[]
  } {
    return this.workflows.listVersions(templateId)
  }

  /** 校验并返回解析后的定义（默认值已填充，未知字段已拒绝）。 */
  validate(input: unknown): WorkflowDefinition {
    const outcome = validateWorkflowDefinition(input)
    if (outcome.ok) return outcome.definition
    if (outcome.kind === 'error') {
      throw new WorkflowDefinitionError('UNKNOWN_NODE_TYPE', outcome.message)
    }
    const summary = outcome.violations.map((item) => item.violation).join(', ')
    throw new WorkflowDefinitionError(
      'INVALID_DEFINITION',
      `workflow definition is invalid: ${summary}`,
      outcome.violations,
    )
  }
}
