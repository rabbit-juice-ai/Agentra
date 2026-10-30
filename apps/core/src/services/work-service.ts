import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { TeamRepository } from '../db/repositories/team-repository'
import type { WorkRecord, WorkRepository, WorkStatus } from '../db/repositories/work-repository'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

/**
 * Work 状态机（DATABASE §2.3 + WORKFLOW §4）。
 * completed / cancelled 是终态的前置：只能归档；archived 不可再迁移。
 * 终止（terminate）= cancelled，不可逆，且必须写审计。
 */
const WORK_TRANSITIONS: Record<WorkStatus, readonly WorkStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
}

export type CreateWorkInput = {
  name: string
  description?: string
  objective?: string
  rootPath: string
  repositoryPath?: string | null
  priority?: string
}

/** Work 领域服务：CRUD + 与 Team 关联 + 暂停/恢复/完成/终止/归档。 */
export class WorkService {
  private readonly works: WorkRepository

  constructor(
    private readonly db: Database,
    works: WorkRepository,
    private readonly teams: TeamRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.works = works
  }

  create(input: CreateWorkInput): WorkRecord {
    const now = this.now()
    const work: WorkRecord = {
      id: newId('work'),
      name: requireText(input.name, 'name'),
      description: input.description ?? '',
      objective: input.objective ?? '',
      status: 'draft',
      priority: input.priority?.trim() || 'normal',
      rootPath: requireText(input.rootPath, 'rootPath'),
      repositoryPath: input.repositoryPath ?? null,
      settings: {},
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    transaction(this.db, () => {
      this.works.insert(work)
    })
    return work
  }

  get(id: string): WorkRecord {
    const work = this.works.get(id)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${id}`)
    return work
  }

  list(includeArchived = false): WorkRecord[] {
    return this.works.list(includeArchived)
  }

  linkTeam(workId: string, teamId: string): void {
    const work = this.get(workId)
    if (work.status === 'archived') {
      throw new RpcMethodError('INVALID_PARAMS', `work ${workId} is archived`)
    }
    const team = this.teams.get(teamId)
    if (!team) throw new RpcMethodError('INVALID_PARAMS', `team not found: ${teamId}`)
    if (team.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `team ${teamId} is ${team.status}`)
    }
    this.works.linkTeam(workId, teamId, this.now())
  }

  unlinkTeam(workId: string, teamId: string): void {
    this.get(workId)
    if (!this.works.unlinkTeam(workId, teamId)) {
      throw new RpcMethodError('INVALID_PARAMS', `team ${teamId} is not linked to work ${workId}`)
    }
  }

  listTeamIds(workId: string): string[] {
    this.get(workId)
    return this.works.listTeamIds(workId)
  }

  /** Work 级暂停：置 paused；后续不再调度该 Work 下的执行（调度器在阶段 4 接入）。 */
  pause(id: string): WorkRecord {
    return this.transition(id, 'paused', { from: ['active'] })
  }

  /** 恢复只对已暂停的 Work 有意义；draft 用 activate。 */
  resume(id: string): WorkRecord {
    return this.transition(id, 'active', { from: ['paused'] })
  }

  complete(id: string): WorkRecord {
    return this.transition(id, 'completed', { from: ['active', 'paused'] })
  }

  activate(id: string): WorkRecord {
    return this.transition(id, 'active', { from: ['draft'] })
  }

  /** Work 级终止：终态不可逆，写审计（WORKFLOW §4）。 */
  terminate(id: string): WorkRecord {
    return this.transition(id, 'cancelled', {
      from: ['draft', 'active', 'paused'],
      audit: { action: 'work.terminated' },
    })
  }

  archive(id: string): WorkRecord {
    return this.transition(id, 'archived', { from: ['completed', 'cancelled'] })
  }

  private transition(
    id: string,
    to: WorkStatus,
    options: { from: readonly WorkStatus[]; audit?: { action: string } },
  ): WorkRecord {
    const work = this.get(id)
    // 两层校验：动作允许的来源状态 + 状态机迁移表。
    if (!options.from.includes(work.status) || !WORK_TRANSITIONS[work.status].includes(to)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${id} cannot transition ${work.status} → ${to}`,
      )
    }
    const audit = options.audit
    const now = this.now()
    const completedAt =
      to === 'completed' || to === 'cancelled' ? (work.completedAt ?? now) : work.completedAt

    transaction(this.db, () => {
      const applied = this.works.updateStatus(id, work.status, to, now, completedAt)
      if (!applied) {
        // 期间被其他写入改过状态：拒绝，避免丢失并发迁移。
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `work ${id} changed concurrently (expected ${work.status} → ${to})`,
        )
      }
      if (audit) {
        this.audit.append({
          actorType: 'user',
          actorId: null,
          action: audit.action,
          targetType: 'work',
          targetId: id,
          details: { from: work.status, to },
          now,
        })
      }
    })

    return this.get(id)
  }
}
