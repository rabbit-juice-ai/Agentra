import crypto from 'node:crypto'
import type { PlanRecord, PlanVersion, WorkflowRun } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  PlanDispatchRepository,
  PlanStartAttemptRecord,
  PlanStartAttemptRepository,
} from '../db/repositories/plan-dispatch-repository'
import type {
  PlanCommentRepository,
  PlanRepository,
  PlanThreadRepository,
  PlanVersionRepository,
} from '../db/repositories/plan-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { WorkflowEngine } from '../workflow/engine'
import type { WorkflowRunService } from '../workflow/run-service'
import type { AssignmentService } from './assignment-service'
import type { PlanAssignmentService } from './plan-assignment-service'
import { assignmentsToTaskMap, compilePlanDefinition, PlanCompileError } from './plan-compiler'
import type { WorkflowDefinitionService } from './workflow-definition-service'

const SnapshotAssignment = z
  .object({
    taskKey: z.string().min(1),
    teamId: z.string().min(1).nullable(),
    agentId: z.string().min(1),
    source: z.enum(['planner', 'leader', 'user', 'legacy']),
    reason: z.string().nullable(),
    workRole: z.string().min(1),
  })
  .strict()
const Snapshot = z.array(SnapshotAssignment)

type SnapshotAssignment = z.infer<typeof SnapshotAssignment>

export type PlanStartErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'PLAN_NOT_APPROVED'
  | 'STANDALONE_PLAN'
  | 'WORK_NOT_ACTIVE'
  | 'PLAN_NOT_READY'
  | 'DISPATCH_IN_PROGRESS'
  | 'START_IN_PROGRESS'
  | 'COMPILE_FAILED'
  | 'ASSIGNMENT_CONFLICT'
  | 'RUN_CREATE_FAILED'
  | 'INTERRUPTED'

export class PlanStartError extends Error {
  constructor(
    readonly code: PlanStartErrorCode,
    message: string,
    readonly violations: unknown[] = [],
  ) {
    super(message)
    this.name = 'PlanStartError'
  }
}

export type PlanStartServiceDeps = {
  db: Database
  plans: Pick<PlanRepository, 'get' | 'setRun'>
  versions: Pick<PlanVersionRepository, 'latestByPlan' | 'updateStatus'>
  assignments: PlanAssignmentService
  startAttempts: PlanStartAttemptRepository
  dispatches: Pick<PlanDispatchRepository, 'listByVersion'>
  workAssignments: Pick<AssignmentService, 'ensureForPlanInTransaction' | 'previewPlanRoles'>
  works: Pick<WorkRepository, 'get'>
  workflows: Pick<WorkflowDefinitionService, 'createPublishedVersionInTransaction'>
  runs: Pick<WorkflowRunRepository, 'get'>
  runService: Pick<WorkflowRunService, 'createRunInTransaction'>
  engine: Pick<WorkflowEngine, 'kick'>
  threads: Pick<PlanThreadRepository, 'listByPlan'>
  comments: Pick<PlanCommentRepository, 'create'>
  audit?: Pick<AuditRepository, 'append'>
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
  /** PlanService 的线程事件窗口：必须在 kick 前注册，kick 后 flush。 */
  eventWindow?: {
    beforeKick(planId: string, workflowVersionId: string): void
    afterKick(workflowVersionId: string): void
  }
  now?: () => string
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { errcode?: unknown }).errcode === 2067) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes('UNIQUE constraint failed')
}

/**
 * StartRun 的唯一入口：
 * claim（唯一 active attempt + assignment snapshot）→ 编译 → 单事务写 workflow version/run/plan
 * → 事务外 kick。任何失败都不留下 orphan workflow version 或第二个 Run。
 */
export class PlanStartService {
  private readonly now: () => string

  constructor(private readonly deps: PlanStartServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async startRun(
    planId: string,
    requestId?: string,
  ): Promise<{
    plan: PlanRecord
    run: WorkflowRun
    schedulingError: string | null
  }> {
    const existingPlan = this.requirePlan(planId)
    if (existingPlan.status === 'running' && existingPlan.workflowRunId) {
      return this.retryExistingRun(existingPlan)
    }
    if (existingPlan.status !== 'approved') {
      throw new PlanStartError(
        'PLAN_NOT_APPROVED',
        `plan ${planId} is ${existingPlan.status}, cannot start run`,
      )
    }
    if (!existingPlan.workId) {
      throw new PlanStartError(
        'STANDALONE_PLAN',
        `plan ${planId} is standalone; convert it to a task first`,
      )
    }
    const work = this.deps.works.get(existingPlan.workId)
    if (!work) throw new PlanStartError('WORK_NOT_ACTIVE', `work ${existingPlan.workId} not found`)
    if (work.status !== 'active') {
      throw new PlanStartError(
        'WORK_NOT_ACTIVE',
        `work ${existingPlan.workId} is ${work.status}, cannot start run`,
      )
    }
    const version = this.deps.versions.latestByPlan(planId)
    if (!version) throw new PlanStartError('PLAN_NOT_FOUND', `plan ${planId} has no version`)
    const attemptRequestId = requestId ?? crypto.randomUUID()
    const attempt = this.claim(existingPlan, version, attemptRequestId)

    let definition: ReturnType<typeof compilePlanDefinition>
    try {
      const snapshot = Snapshot.parse(JSON.parse(attempt.assignmentSnapshotJson))
      definition = compilePlanDefinition({
        plan: version.plan,
        taskAssignments: assignmentsToTaskMap(
          snapshot.map((item) => ({
            taskKey: item.taskKey,
            agentId: item.agentId,
            agentName: null,
          })),
          new Map(snapshot.map((item) => [item.agentId, item.workRole])),
        ),
      })
    } catch (error) {
      const violations = error instanceof PlanCompileError ? error.violations : []
      const message = error instanceof Error ? error.message : String(error)
      this.deps.startAttempts.markFailed(attempt.id, 'COMPILE_FAILED', message, this.now())
      throw new PlanStartError('COMPILE_FAILED', message, violations)
    }

    const now = this.now()
    let created: { plan: PlanRecord; run: WorkflowRun; workflowVersionId: string }
    try {
      created = transaction(this.deps.db, () => {
        const currentPlan = this.requirePlan(planId)
        if (currentPlan.status !== 'approved') {
          throw new PlanStartError(
            'PLAN_NOT_APPROVED',
            `plan ${planId} is ${currentPlan.status}, cannot start run`,
          )
        }
        const currentVersion = this.deps.versions.latestByPlan(planId)
        if (!currentVersion || currentVersion.id !== version.id) {
          throw new PlanStartError('PLAN_NOT_APPROVED', `plan ${planId} version changed`)
        }
        const currentAttempt = this.deps.startAttempts.get(attempt.id)
        if (!currentAttempt) {
          throw new PlanStartError(
            'START_IN_PROGRESS',
            `start attempt ${attempt.id} is no longer preparing`,
          )
        }
        if (currentAttempt.status !== 'preparing') {
          throw new PlanStartError(
            'START_IN_PROGRESS',
            `start attempt ${attempt.id} is no longer preparing`,
          )
        }
        const runningDispatch = this.deps.dispatches
          .listByVersion(version.id)
          .find((dispatch) => dispatch.status === 'running')
        if (runningDispatch) {
          throw new PlanStartError(
            'DISPATCH_IN_PROGRESS',
            `team ${runningDispatch.teamId} dispatch is still running`,
          )
        }
        const snapshot = Snapshot.parse(JSON.parse(currentAttempt.assignmentSnapshotJson))
        const roles = this.deps.workAssignments.ensureForPlanInTransaction(
          currentPlan.workId as string,
          snapshot.map((item) => item.agentId),
          new Map(snapshot.map((item) => [item.agentId, item.teamId])),
          now,
        )
        for (const item of snapshot) {
          if (roles.get(item.agentId) !== item.workRole) {
            throw new PlanStartError(
              'ASSIGNMENT_CONFLICT',
              `agent ${item.agentId} workRole changed between claim and commit`,
            )
          }
        }
        const workflowVersion = this.deps.workflows.createPublishedVersionInTransaction(
          {
            name: `Plan ${planId.slice(-8)}`,
            description: currentPlan.goal.slice(0, 200),
            category: 'plan',
            definition,
          },
          now,
        )
        const run = this.deps.runService.createRunInTransaction(
          {
            workId: currentPlan.workId as string,
            workflowVersionId: workflowVersion.id,
            requestId: currentAttempt.requestId,
          },
          now,
        )
        if (!this.deps.plans.setRun(planId, workflowVersion.id, run.id, now)) {
          throw new PlanStartError('PLAN_NOT_APPROVED', `plan ${planId} changed concurrently`)
        }
        if (!this.deps.versions.updateStatus(version.id, ['approved'], 'running', now)) {
          throw new PlanStartError('PLAN_NOT_APPROVED', `plan version ${version.id} changed`)
        }
        if (!this.deps.startAttempts.markStarting(attempt.id, workflowVersion.id, run.id, now)) {
          throw new PlanStartError('START_IN_PROGRESS', `start attempt ${attempt.id} changed`)
        }
        this.systemComment(planId, `执行已启动：${run.id}。`, now, run.id)
        return { plan: this.requirePlan(planId), run, workflowVersionId: workflowVersion.id }
      })
    } catch (error) {
      const code = error instanceof PlanStartError ? error.code : 'RUN_CREATE_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      this.deps.startAttempts.markFailed(attempt.id, code, message, this.now())
      if (error instanceof PlanStartError) throw error
      throw new PlanStartError('RUN_CREATE_FAILED', message)
    }

    this.deps.eventWindow?.beforeKick(planId, created.workflowVersionId)
    let schedulingError: string | null = null
    try {
      await this.deps.engine.kick(created.run.id, true)
    } catch (error) {
      schedulingError = '调度未完成；Run 已保存，请按相同请求重试或查看运行状态。'
      this.deps.logger?.warn('plan run scheduling failed', {
        planId,
        runId: created.run.id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.deps.startAttempts.markRunning(attempt.id, this.now())
      this.deps.eventWindow?.afterKick(created.workflowVersionId)
    }
    this.audit(planId, 'plan.run_started', {
      versionId: version.id,
      workflowVersionId: created.workflowVersionId,
      runId: created.run.id,
      requestId: attempt.requestId,
      schedulingError,
    })
    return {
      plan: this.requirePlan(planId),
      run: created.run,
      schedulingError,
    }
  }

  /**
   * Core 启动恢复：上次进程遗留的 preparing/starting attempt 不能被永久占用。
   * - 已有 Run：标记 running 并重新 kick；
   * - 没有 Run：标记 failed，允许用户重新启动。
   */
  async recoverStaleAttempts(): Promise<void> {
    for (const attempt of this.deps.startAttempts.listUnfinished()) {
      const plan = this.deps.plans.get(attempt.planId)
      const runId = attempt.workflowRunId ?? plan?.workflowRunId ?? null
      const run = runId ? this.deps.runs.get(runId) : null
      if (run && plan?.status === 'running') {
        this.deps.startAttempts.markRunning(attempt.id, this.now())
        await this.deps.engine.kick(run.id, true).catch((error) => {
          this.deps.logger?.warn('stale start attempt kick failed', {
            planId: plan.id,
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        continue
      }
      this.deps.startAttempts.markFailed(
        attempt.id,
        'INTERRUPTED',
        'Core restarted while plan start was in progress',
        this.now(),
      )
      this.deps.logger?.warn('stale plan start attempt failed closed', {
        planId: attempt.planId,
        attemptId: attempt.id,
      })
    }
  }

  private claim(plan: PlanRecord, version: PlanVersion, requestId: string): PlanStartAttemptRecord {
    const now = this.now()
    try {
      return transaction(this.deps.db, () => {
        const current = this.requirePlan(plan.id)
        if (current.status !== 'approved') {
          throw new PlanStartError(
            'PLAN_NOT_APPROVED',
            `plan ${plan.id} is ${current.status}, cannot start run`,
          )
        }
        if (this.deps.startAttempts.getByRequestId(requestId)) {
          throw new PlanStartError(
            'START_IN_PROGRESS',
            `start request ${requestId} was already claimed`,
          )
        }
        if (this.deps.startAttempts.getActiveByVersion(version.id)) {
          throw new PlanStartError('START_IN_PROGRESS', `plan ${plan.id} is already starting`)
        }
        const runningDispatch = this.deps.dispatches
          .listByVersion(version.id)
          .find((dispatch) => dispatch.status === 'running')
        if (runningDispatch) {
          throw new PlanStartError(
            'DISPATCH_IN_PROGRESS',
            `team ${runningDispatch.teamId} dispatch is still running`,
          )
        }

        let active = this.deps.assignments.listActiveByVersion(version.id)
        const allTasksPersonal = version.plan.tasks.every((task) => task.teamId === null)
        if (active.length === 0 && allTasksPersonal) {
          this.deps.assignments.seedPersonalAssignmentsInTransaction(
            current,
            version,
            'legacy',
            now,
          )
          active = this.deps.assignments.listActiveByVersion(version.id)
        }
        const byTask = new Map(active.map((assignment) => [assignment.taskKey, assignment]))
        const missing = version.plan.tasks
          .filter((task) => !byTask.has(task.key))
          .map((task) => task.key)
        if (missing.length > 0) {
          throw new PlanStartError(
            'PLAN_NOT_READY',
            `plan ${plan.id} has unassigned tasks: ${missing.join(', ')}`,
          )
        }
        const agentIds = [...new Set(active.map((assignment) => assignment.agentId))]
        const roles = this.deps.workAssignments.previewPlanRoles(current.workId as string, agentIds)
        const snapshot: SnapshotAssignment[] = version.plan.tasks.map((task) => {
          const assignment = byTask.get(task.key)
          if (!assignment) {
            throw new PlanStartError('PLAN_NOT_READY', `task ${task.key} is not assigned`)
          }
          if (assignment.teamId !== task.teamId) {
            throw new PlanStartError(
              'ASSIGNMENT_CONFLICT',
              `task ${task.key} assignment team does not match plan task`,
            )
          }
          const workRole = roles.get(assignment.agentId)
          if (!workRole) {
            throw new PlanStartError(
              'ASSIGNMENT_CONFLICT',
              `agent ${assignment.agentId} has no workRole`,
            )
          }
          return {
            taskKey: task.key,
            teamId: task.teamId,
            agentId: assignment.agentId,
            source: assignment.source,
            reason: assignment.reason,
            workRole,
          }
        })
        const record: PlanStartAttemptRecord = {
          id: newId('psa'),
          planId: plan.id,
          planVersionId: version.id,
          requestId,
          status: 'preparing',
          assignmentSnapshotJson: JSON.stringify(snapshot),
          planChecksum: version.checksum,
          workflowVersionId: null,
          workflowRunId: null,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        }
        this.deps.startAttempts.insert(record)
        return record
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PlanStartError('START_IN_PROGRESS', `plan ${plan.id} is already starting`)
      }
      throw error
    }
  }

  private async retryExistingRun(plan: PlanRecord): Promise<{
    plan: PlanRecord
    run: WorkflowRun
    schedulingError: string | null
  }> {
    if (!plan.workflowRunId) {
      throw new PlanStartError('RUN_CREATE_FAILED', `plan ${plan.id} has no workflow run`)
    }
    const run = this.deps.runs.get(plan.workflowRunId)
    if (!run) {
      throw new PlanStartError('RUN_CREATE_FAILED', `run ${plan.workflowRunId} not found`)
    }
    const attempts = this.deps.startAttempts.listByPlan(plan.id)
    const latest = attempts[0]
    let schedulingError: string | null = null
    try {
      await this.deps.engine.kick(run.id, true)
    } catch {
      schedulingError = '调度未完成；Run 已保存，请按相同请求重试或查看运行状态。'
    }
    if (latest && (latest.status === 'preparing' || latest.status === 'starting')) {
      this.deps.startAttempts.markRunning(latest.id, this.now())
    }
    return { plan: this.requirePlan(plan.id), run, schedulingError }
  }

  private systemComment(planId: string, content: string, now: string, runId: string): void {
    for (const thread of this.deps.threads.listByPlan(planId)) {
      this.deps.comments.create({
        id: newId('pcm'),
        threadId: thread.id,
        authorType: 'system',
        authorId: 'agentra',
        content,
        createdAt: now,
        runId,
      })
    }
  }

  private requirePlan(planId: string): PlanRecord {
    const plan = this.deps.plans.get(planId)
    if (!plan) throw new PlanStartError('PLAN_NOT_FOUND', `plan ${planId} not found`)
    return plan
  }

  private audit(planId: string, action: string, details: Record<string, unknown>): void {
    this.deps.audit?.append({
      actorType: 'user',
      actorId: 'local-user',
      action,
      targetType: 'plan',
      targetId: planId,
      details,
      now: this.now(),
    })
  }
}
