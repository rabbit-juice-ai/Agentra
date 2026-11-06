import type {
  ProjectCreateParams,
  ProjectListResult,
  ProjectStatus,
  ProjectUpdateParams,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { ProjectRecord, ProjectRepository } from '../db/repositories/project-repository'

export class ProjectServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectServiceError'
  }
}

/** 项目 = 任务的合集；只做分组与状态，不承载执行语义。 */
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly audit?: AuditRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(params: ProjectCreateParams): ProjectRecord {
    const now = this.now()
    const record: ProjectRecord = {
      id: newId('prj'),
      name: params.name.trim(),
      description: params.description?.trim() ?? '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    if (record.name.length === 0) {
      throw new ProjectServiceError('project name must not be blank')
    }
    this.projects.create(record)
    this.audit?.append({
      actorType: 'user',
      actorId: 'local-user',
      action: 'project.created',
      targetType: 'project',
      targetId: record.id,
      details: { name: record.name },
      now,
    })
    return record
  }

  list(): ProjectListResult {
    return { projects: this.projects.list() }
  }

  get(id: string): ProjectRecord {
    const project = this.projects.get(id)
    if (!project) throw new ProjectServiceError(`project not found: ${id}`)
    return project
  }

  update(params: ProjectUpdateParams): ProjectRecord {
    const current = this.get(params.id)
    const now = this.now()
    const updated = this.projects.update(
      params.id,
      {
        name: params.name?.trim(),
        description: params.description?.trim(),
        status: params.status as ProjectStatus | undefined,
      },
      now,
    )
    if (!updated) throw new ProjectServiceError(`project not found: ${params.id}`)
    this.audit?.append({
      actorType: 'user',
      actorId: 'local-user',
      action: 'project.updated',
      targetType: 'project',
      targetId: params.id,
      details: {
        fromStatus: current.status,
        toStatus: updated.status,
        name: updated.name,
      },
      now,
    })
    return updated
  }
}
