import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type { ProjectRepository } from '../db/repositories/project-repository'
import type { TeamRepository } from '../db/repositories/team-repository'
import type {
  WorkCollaborationMode,
  WorkIssueStatus,
  WorkRecord,
  WorkRepository,
  WorkStatus,
} from '../db/repositories/work-repository'
import type { TaskMemoryService } from './task-memory-service'

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RpcMethodError('INVALID_PARAMS', `${field} must not be blank`)
  }
  return trimmed
}

function normalizeAcceptanceCriteria(values: string[] | undefined): string[] {
  const criteria = (values ?? []).map((value) => value.trim()).filter(Boolean)
  if (criteria.length > 20) {
    throw new RpcMethodError('INVALID_PARAMS', 'acceptanceCriteria cannot exceed 20 items')
  }
  for (const item of criteria) {
    if (item.length > 500) {
      throw new RpcMethodError('INVALID_PARAMS', 'acceptance criteria item exceeds 500 chars')
    }
  }
  return criteria
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
  completed: ['archived', 'active'],
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
  projectId?: string | null
  collaborationMode?: WorkCollaborationMode
  ownerTeamId?: string | null
  issueStatus?: WorkIssueStatus
  assigneeAgentId?: string | null
  acceptanceCriteria?: string[]
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
    private readonly onTransition?: (workId: string, to: WorkStatus, now: string) => void,
    private readonly projects?: Pick<ProjectRepository, 'get'>,
    private readonly taskMemories?: Pick<
      TaskMemoryService,
      'ensureForWorkInTransaction' | 'refreshForWorkInTransaction'
    >,
    private readonly onTransitionCommitted?: (workId: string, to: WorkStatus, now: string) => void,
  ) {
    this.works = works
  }

  create(input: CreateWorkInput): WorkRecord {
    const now = this.now()
    const projectId = input.projectId ?? 'prj-default'
    if (this.projects && !this.projects.get(projectId)) {
      throw new RpcMethodError('INVALID_PARAMS', `project not found: ${projectId}`)
    }
    const ownerTeamId = input.ownerTeamId ?? null
    if (ownerTeamId) {
      const team = this.teams.get(ownerTeamId)
      if (!team || team.status !== 'active') {
        throw new RpcMethodError('INVALID_PARAMS', `team ${ownerTeamId} is not active`)
      }
    }
    const work: WorkRecord = {
      id: newId('work'),
      name: requireText(input.name, 'name'),
      description: input.description ?? '',
      objective: input.objective ?? '',
      status: 'draft',
      priority: input.priority?.trim() || 'normal',
      rootPath: requireText(input.rootPath, 'rootPath'),
      repositoryPath: input.repositoryPath ?? null,
      projectId,
      collaborationMode: input.collaborationMode ?? 'workflow',
      ownerTeamId,
      issueStatus: input.issueStatus ?? 'backlog',
      assigneeAgentId: input.assigneeAgentId ?? null,
      acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria),
      acceptanceCriteriaVersion: 1,
      acceptanceCriteriaUpdatedAt: now,
      settings: {},
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    transaction(this.db, () => {
      this.works.insert(work)
      this.taskMemories?.ensureForWorkInTransaction(work)
    })
    return work
  }

  get(id: string): WorkRecord {
    const work = this.works.get(id)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${id}`)
    return work
  }

  list(includeArchived = false, projectId?: string): WorkRecord[] {
    return projectId
      ? this.works.listByProject(projectId, includeArchived)
      : this.works.list(includeArchived)
  }

  listByProject(projectId: string, includeArchived = false): WorkRecord[] {
    return this.works.listByProject(projectId, includeArchived)
  }

  linkTeam(workId: string, teamId: string): void {
    const work = this.get(workId)
    if (work.status === 'archived') {
      throw new RpcMethodError('INVALID_PARAMS', `work ${workId} is archived`)
    }
    if (work.collaborationMode === 'team' && work.ownerTeamId && work.ownerTeamId !== teamId) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `team task ${workId} already belongs to team ${work.ownerTeamId}`,
      )
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
    if (this.get(id).status === 'paused') return this.get(id)
    return this.transition(id, 'paused', { from: ['active'] })
  }

  /** 恢复只对已暂停的 Work 有意义；draft 用 activate。 */
  resume(id: string): WorkRecord {
    if (this.get(id).status === 'active') return this.get(id)
    return this.transition(id, 'active', { from: ['paused'] })
  }

  complete(id: string): WorkRecord {
    return this.transition(id, 'completed', { from: ['active', 'paused'] })
  }

  activate(id: string): WorkRecord {
    return this.transition(id, 'active', { from: ['draft'] })
  }

  /**
   * 仅由显式恢复调用：completed → active。
   * 不是普通状态迁移；必须记录重开原因、来源 Checkpoint 与 Recovery Attempt。
   */
  reopenCompleted(
    id: string,
    input: {
      reason: string
      recoveryAttemptId: string
      checkpointId: string
      actorType?: 'user' | 'agent' | 'system'
      actorId?: string | null
      issueStatus?: WorkIssueStatus
    },
  ): WorkRecord {
    const now = this.now()
    transaction(this.db, () => {
      this.reopenCompletedInTransaction(id, input, now)
    })
    this.onTransitionCommitted?.(id, 'active', now)
    return this.get(id)
  }

  /** 已处于事务内时使用；RecoveryService 用它把 attempt 与 Work 重开绑定在同一事务。 */
  reopenCompletedInTransaction(
    id: string,
    input: {
      reason: string
      recoveryAttemptId: string
      checkpointId: string
      actorType?: 'user' | 'agent' | 'system'
      actorId?: string | null
      issueStatus?: WorkIssueStatus
    },
    now: string,
  ): WorkRecord {
    const work = this.get(id)
    if (work.status !== 'completed') {
      throw new RpcMethodError('INVALID_PARAMS', `work ${id} is ${work.status}, not completed`)
    }
    const reason = input.reason.trim()
    if (reason.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'reopen reason must not be blank')
    }
    const issueStatus = input.issueStatus ?? 'in_progress'
    if (!this.works.updateStatus(id, 'completed', 'active', now, null)) {
      throw new RpcMethodError('INVALID_PARAMS', `work ${id} changed concurrently`)
    }
    if (work.issueStatus !== issueStatus) {
      if (!this.works.setIssueStatus(id, [work.issueStatus], issueStatus, now)) {
        throw new RpcMethodError('INVALID_PARAMS', `work ${id} issue status changed concurrently`)
      }
    }
    this.audit.append({
      actorType: input.actorType ?? 'system',
      actorId: input.actorId ?? 'agentra',
      action: 'work.reopened',
      targetType: 'work',
      targetId: id,
      details: {
        from: 'completed',
        to: 'active',
        reason,
        checkpointId: input.checkpointId,
        recoveryAttemptId: input.recoveryAttemptId,
        previousCompletedAt: work.completedAt,
        issueStatus,
      },
      now,
    })
    this.onTransition?.(id, 'active', now)
    return this.get(id)
  }

  /** 团队协作任务状态；调用方负责校验角色/迁移是否合理。 */
  setIssueStatus(id: string, status: WorkIssueStatus): WorkRecord {
    const work = this.get(id)
    if (work.issueStatus === status) return work
    const now = this.now()
    if (!this.works.setIssueStatus(id, [work.issueStatus], status, now)) {
      throw new RpcMethodError('INVALID_PARAMS', `work ${id} issue status changed concurrently`)
    }
    this.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'work.issue_status_changed',
      targetType: 'work',
      targetId: id,
      details: { from: work.issueStatus, to: status },
      now,
    })
    return this.get(id)
  }

  assignAgent(id: string, agentId: string | null): WorkRecord {
    this.get(id)
    const now = this.now()
    if (!this.works.setAssignee(id, agentId, now)) {
      throw new RpcMethodError('INVALID_PARAMS', `work ${id} not found`)
    }
    this.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'work.assignee_changed',
      targetType: 'work',
      targetId: id,
      details: { toAgentId: agentId },
      now,
    })
    return this.get(id)
  }

  /**
   * Work 正式验收标准更新。内容不变时不做任何写入/版本递增。
   * 更新、版本递增、Task Memory 刷新与审计在同一事务内完成。
   */
  updateAcceptanceCriteria(
    id: string,
    values: string[],
    options: {
      actorType?: 'user' | 'agent' | 'system'
      actorId?: string | null
      source?: string
    } = {},
  ): WorkRecord {
    const current = this.get(id)
    const criteria = normalizeAcceptanceCriteria(values)
    if (JSON.stringify(current.acceptanceCriteria) === JSON.stringify(criteria)) return current
    const now = this.now()
    const nextVersion = current.acceptanceCriteriaVersion + 1
    const source = options.source ?? 'work.acceptance_criteria_update'
    transaction(this.db, () => {
      if (
        !this.works.updateAcceptanceCriteria(
          id,
          current.acceptanceCriteriaVersion,
          criteria,
          nextVersion,
          now,
          now,
        )
      ) {
        throw new RpcMethodError(
          'INVALID_PARAMS',
          `work ${id} acceptance criteria changed concurrently`,
        )
      }
      const updated = this.get(id)
      this.taskMemories?.refreshForWorkInTransaction(updated, source)
      this.audit.append({
        actorType: options.actorType ?? 'system',
        actorId: options.actorId ?? 'agentra',
        action: 'work.acceptance_criteria_changed',
        targetType: 'work',
        targetId: id,
        details: {
          fromVersion: current.acceptanceCriteriaVersion,
          toVersion: nextVersion,
          source,
          at: now,
          fromCriteria: current.acceptanceCriteria,
          toCriteria: criteria,
        },
        now,
      })
    })
    return this.get(id)
  }

  /** Work 级终止：终态不可逆，写审计（WORKFLOW §4）。 */
  terminate(id: string): WorkRecord {
    if (this.get(id).status === 'cancelled') return this.get(id)
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
      this.onTransition?.(id, to, now)
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
    this.onTransitionCommitted?.(id, to, now)

    return this.get(id)
  }
}
