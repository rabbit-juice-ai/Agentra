import {
  type PlanAssignment,
  type PlanComment,
  type PlanDraft,
  PlanDraft as PlanDraftSchema,
  type PlanRecord,
  type PlanStatus,
  type PlanThread,
  type PlanValidationResult,
  PlanValidationResult as PlanValidationResultSchema,
  type PlanVersion,
} from '@agentra/protocol'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

const AssignmentsSchema = z.array(
  z.object({
    taskKey: z.string(),
    agentId: z.string().nullable(),
    agentName: z.string().nullable(),
  }),
)

type PlanRow = {
  id: string
  work_id: string | null
  goal: string
  status: string
  current_version: number
  workflow_version_id: string | null
  workflow_run_id: string | null
  created_at: string
  updated_at: string
  approved_at: string | null
  approved_by: string | null
}

type PlanVersionRow = {
  id: string
  plan_id: string
  version: number
  plan_json: string
  validation_json: string
  assignments_json: string
  checksum: string
  status: string
  source: string
  fallback_reason: string | null
  created_at: string
  approved_at: string | null
  approved_by: string | null
}

type ThreadRow = {
  id: string
  plan_id: string
  task_key: string
  created_at: string
}

type CommentRow = {
  id: string
  thread_id: string
  author_type: string
  author_id: string
  content: string
  created_at: string
  run_id: string | null
}

function toPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    workId: row.work_id,
    goal: row.goal,
    status: row.status as PlanStatus,
    currentVersion: row.current_version,
    workflowVersionId: row.workflow_version_id,
    workflowRunId: row.workflow_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  }
}

function toVersion(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    plan: parseJsonColumn(
      PlanDraftSchema,
      row.plan_json,
      `plan_versions.plan_json(${row.id})`,
    ) as PlanDraft,
    validation: parseJsonColumn(
      PlanValidationResultSchema,
      row.validation_json,
      `plan_versions.validation_json(${row.id})`,
    ) as PlanValidationResult,
    assignments: parseJsonColumn(
      AssignmentsSchema,
      row.assignments_json,
      `plan_versions.assignments_json(${row.id})`,
    ) as PlanAssignment[],
    checksum: row.checksum,
    status: row.status as PlanStatus,
    source: row.source as PlanVersion['source'],
    fallbackReason: row.fallback_reason,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  }
}

function toThread(row: ThreadRow): PlanThread {
  return { id: row.id, planId: row.plan_id, taskKey: row.task_key, createdAt: row.created_at }
}

function toComment(row: CommentRow): PlanComment {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorType: row.author_type as PlanComment['authorType'],
    authorId: row.author_id,
    content: row.content,
    createdAt: row.created_at,
    runId: row.run_id,
  }
}

export class PlanRepository {
  constructor(private readonly db: Database) {}

  create(record: PlanRecord): void {
    this.db
      .prepare(
        `INSERT INTO plans (
          id, work_id, goal, status, current_version, workflow_version_id, workflow_run_id,
          created_at, updated_at, approved_at, approved_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.goal,
        record.status,
        record.currentVersion,
        record.workflowVersionId,
        record.workflowRunId,
        record.createdAt,
        record.updatedAt,
        record.approvedAt,
        record.approvedBy,
      )
  }

  get(id: string): PlanRecord | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
    return row ? toPlan(row) : null
  }

  listByWork(workId: string): PlanRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plans WHERE work_id = ? ORDER BY created_at DESC, id DESC')
      .all(workId) as PlanRow[]
    return rows.map(toPlan)
  }

  getByRun(workflowRunId: string): PlanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE workflow_run_id = ?')
      .get(workflowRunId) as PlanRow | undefined
    return row ? toPlan(row) : null
  }

  updateStatus(
    id: string,
    from: PlanStatus[],
    to: PlanStatus,
    now: string,
    patch: { approvedAt?: string | null; approvedBy?: string | null } = {},
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE plans SET status = ?, updated_at = ?, approved_at = COALESCE(?, approved_at),
          approved_by = COALESCE(?, approved_by) WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now, patch.approvedAt ?? null, patch.approvedBy ?? null, id, ...from)
    return result.changes > 0
  }

  setWork(id: string, workId: string, now: string): boolean {
    const result = this.db
      .prepare('UPDATE plans SET work_id = ?, updated_at = ? WHERE id = ? AND work_id IS NULL')
      .run(workId, now, id)
    return result.changes > 0
  }

  listRecent(limit = 20): PlanRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plans ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as PlanRow[]
    return rows.map(toPlan)
  }

  setRun(id: string, workflowVersionId: string, workflowRunId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plans SET status = 'running', workflow_version_id = ?, workflow_run_id = ?,
          updated_at = ? WHERE id = ? AND status = 'approved'`,
      )
      .run(workflowVersionId, workflowRunId, now, id)
    return result.changes > 0
  }
}

export class PlanVersionRepository {
  constructor(private readonly db: Database) {}

  create(record: PlanVersion): void {
    this.db
      .prepare(
        `INSERT INTO plan_versions (
          id, plan_id, version, plan_json, validation_json, assignments_json, checksum, status,
          source, fallback_reason, created_at, approved_at, approved_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.planId,
        record.version,
        serializeJsonColumn(PlanDraftSchema, record.plan, 'planVersion.plan'),
        serializeJsonColumn(
          PlanValidationResultSchema,
          record.validation,
          'planVersion.validation',
        ),
        serializeJsonColumn(AssignmentsSchema, record.assignments, 'planVersion.assignments'),
        record.checksum,
        record.status,
        record.source,
        record.fallbackReason,
        record.createdAt,
        record.approvedAt,
        record.approvedBy,
      )
  }

  get(id: string): PlanVersion | null {
    const row = this.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id) as
      | PlanVersionRow
      | undefined
    return row ? toVersion(row) : null
  }

  latestByPlan(planId: string): PlanVersion | null {
    const row = this.db
      .prepare('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version DESC LIMIT 1')
      .get(planId) as PlanVersionRow | undefined
    return row ? toVersion(row) : null
  }

  listByPlan(planId: string): PlanVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version ASC')
      .all(planId) as PlanVersionRow[]
    return rows.map(toVersion)
  }

  updateStatus(
    id: string,
    from: PlanStatus[],
    to: PlanStatus,
    now: string,
    patch: { approvedAt?: string | null; approvedBy?: string | null } = {},
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE plan_versions SET status = ?, approved_at = COALESCE(?, approved_at),
          approved_by = COALESCE(?, approved_by) WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, patch.approvedAt ?? null, patch.approvedBy ?? null, id, ...from)
    void now
    return result.changes > 0
  }
}

export class PlanThreadRepository {
  constructor(private readonly db: Database) {}

  create(thread: PlanThread): void {
    this.db
      .prepare('INSERT INTO plan_threads (id, plan_id, task_key, created_at) VALUES (?, ?, ?, ?)')
      .run(thread.id, thread.planId, thread.taskKey, thread.createdAt)
  }

  getByPlanTask(planId: string, taskKey: string): PlanThread | null {
    const row = this.db
      .prepare('SELECT * FROM plan_threads WHERE plan_id = ? AND task_key = ?')
      .get(planId, taskKey) as ThreadRow | undefined
    return row ? toThread(row) : null
  }

  listByPlan(planId: string): PlanThread[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_threads WHERE plan_id = ? ORDER BY created_at ASC, task_key ASC')
      .all(planId) as ThreadRow[]
    return rows.map(toThread)
  }
}

export class PlanCommentRepository {
  constructor(private readonly db: Database) {}

  create(comment: PlanComment): void {
    this.db
      .prepare(
        `INSERT INTO plan_comments (
          id, thread_id, author_type, author_id, content, created_at, run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.id,
        comment.threadId,
        comment.authorType,
        comment.authorId,
        comment.content,
        comment.createdAt,
        comment.runId,
      )
  }

  listByThread(threadId: string): PlanComment[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_comments WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(threadId) as CommentRow[]
    return rows.map(toComment)
  }
}
