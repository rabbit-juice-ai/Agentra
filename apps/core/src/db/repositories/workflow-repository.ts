import type { Database } from '../database'

export const WORKFLOW_VERSION_STATUSES = ['draft', 'published', 'deprecated'] as const
export type WorkflowVersionStatus = (typeof WORKFLOW_VERSION_STATUSES)[number]

export type WorkflowTemplateRecord = {
  id: string
  name: string
  description: string
  category: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export type WorkflowVersionRecord = {
  id: string
  templateId: string
  version: number
  schemaVersion: number
  definition: unknown
  definitionJson: string
  checksum: string
  status: WorkflowVersionStatus
  createdAt: string
  publishedAt: string | null
}

export type CreateWorkflowTemplateInput = {
  id: string
  name: string
  description?: string
  category?: string
}

export type UpdateWorkflowTemplateInput = {
  name?: string
  description?: string
  category?: string
}

export type InsertWorkflowVersionInput = {
  id: string
  templateId: string
  version: number
  schemaVersion: number
  definitionJson: string
  checksum: string
}

type TemplateRow = {
  id: string
  name: string
  description: string
  category: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

type VersionRow = {
  id: string
  template_id: string
  version: number
  schema_version: number
  definition_json: string
  checksum: string
  status: string
  created_at: string
  published_at: string | null
}

function toTemplate(row: TemplateRow): WorkflowTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function toVersion(row: VersionRow): WorkflowVersionRecord {
  if (!(WORKFLOW_VERSION_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected workflow_versions.status: ${row.status}`)
  }
  let definition: unknown
  try {
    definition = JSON.parse(row.definition_json)
  } catch (error) {
    throw new Error(
      `workflow_versions.definition_json(${row.id}): invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    schemaVersion: row.schema_version,
    definition,
    definitionJson: row.definition_json,
    checksum: row.checksum,
    status: row.status as WorkflowVersionStatus,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

/** 工作流模板 / 版本的唯一数据访问入口；业务规则在 WorkflowDefinitionService。 */
export class WorkflowRepository {
  constructor(private readonly db: Database) {}

  createTemplate(input: CreateWorkflowTemplateInput, now: string): WorkflowTemplateRecord {
    this.db
      .prepare(
        `INSERT INTO workflow_templates (
           id, name, description, category, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.id, input.name, input.description ?? '', input.category ?? '', now, now)
    const created = this.getTemplate(input.id)
    if (!created) throw new Error(`workflow_templates(${input.id}) missing after insert`)
    return created
  }

  getTemplate(id: string): WorkflowTemplateRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, category, created_at, updated_at, archived_at
         FROM workflow_templates WHERE id = ?`,
      )
      .get(id) as TemplateRow | undefined
    return row ? toTemplate(row) : null
  }

  listTemplates(): WorkflowTemplateRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, category, created_at, updated_at, archived_at
         FROM workflow_templates ORDER BY created_at ASC, id ASC`,
      )
      .all() as TemplateRow[]
    return rows.map(toTemplate)
  }

  updateTemplate(
    id: string,
    patch: UpdateWorkflowTemplateInput,
    now: string,
  ): WorkflowTemplateRecord | null {
    const current = this.getTemplate(id)
    if (!current) return null
    this.db
      .prepare(
        `UPDATE workflow_templates
         SET name = ?, description = ?, category = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.category ?? current.category,
        now,
        id,
      )
    return this.getTemplate(id)
  }

  archiveTemplate(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_templates
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(now, now, id)
    return result.changes > 0
  }

  /** 下一个版本号；并发撞号由 unique(template_id, version) 兜底。 */
  nextVersionNumber(templateId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM workflow_versions WHERE template_id = ?',
      )
      .get(templateId) as { next: number }
    return row.next
  }

  insertVersion(input: InsertWorkflowVersionInput, now: string): WorkflowVersionRecord {
    this.db
      .prepare(
        `INSERT INTO workflow_versions (
           id, template_id, version, schema_version, definition_json, checksum,
           status, created_at, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, NULL)`,
      )
      .run(
        input.id,
        input.templateId,
        input.version,
        input.schemaVersion,
        input.definitionJson,
        input.checksum,
        now,
      )
    const created = this.getVersion(input.id)
    if (!created) throw new Error(`workflow_versions(${input.id}) missing after insert`)
    return created
  }

  getVersion(id: string): WorkflowVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, template_id, version, schema_version, definition_json, checksum,
                status, created_at, published_at
         FROM workflow_versions WHERE id = ?`,
      )
      .get(id) as VersionRow | undefined
    return row ? toVersion(row) : null
  }

  listVersions(templateId: string): WorkflowVersionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, template_id, version, schema_version, definition_json, checksum,
                status, created_at, published_at
         FROM workflow_versions WHERE template_id = ?
         ORDER BY version DESC`,
      )
      .all(templateId) as VersionRow[]
    return rows.map(toVersion)
  }

  /** 发布 CAS：只有 draft 能迁移到 published；返回是否命中。 */
  casPublish(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_versions
         SET status = 'published', published_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .run(now, id)
    return result.changes > 0
  }

  deprecate(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_versions
         SET status = 'deprecated', published_at = COALESCE(published_at, ?)
         WHERE id = ? AND status = 'published'`,
      )
      .run(now, id)
    return result.changes > 0
  }
}
