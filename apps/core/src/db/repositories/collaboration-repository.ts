import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

const JsonObject = z.record(z.string(), z.unknown())

export const PLANNER_MESSAGE_AUTHOR_TYPES = ['user', 'planner', 'system'] as const
export type PlannerMessageAuthorType = (typeof PLANNER_MESSAGE_AUTHOR_TYPES)[number]

export const PLANNER_ACTION_STATUSES = ['proposed', 'applied', 'rejected'] as const
export type PlannerActionStatus = (typeof PLANNER_ACTION_STATUSES)[number]

export type PlannerMessageRecord = {
  id: string
  authorType: PlannerMessageAuthorType
  authorId: string
  content: string
  action: Record<string, unknown> | null
  actionStatus: PlannerActionStatus | null
  executionId: string | null
  relatedWorkId: string | null
  createdAt: string
}

type PlannerMessageRow = {
  id: string
  author_type: string
  author_id: string
  content: string
  action_json: string | null
  action_status: string | null
  execution_id: string | null
  related_work_id: string | null
  created_at: string
}

function toPlannerMessage(row: PlannerMessageRow): PlannerMessageRecord {
  if (!(PLANNER_MESSAGE_AUTHOR_TYPES as readonly string[]).includes(row.author_type)) {
    throw new Error(`unexpected planner_messages.author_type: ${row.author_type}`)
  }
  if (
    row.action_status !== null &&
    !(PLANNER_ACTION_STATUSES as readonly string[]).includes(row.action_status)
  ) {
    throw new Error(`unexpected planner_messages.action_status: ${row.action_status}`)
  }
  return {
    id: row.id,
    authorType: row.author_type as PlannerMessageAuthorType,
    authorId: row.author_id,
    content: row.content,
    action: row.action_json
      ? parseJsonColumn(JsonObject, row.action_json, `planner_messages.action_json(${row.id})`)
      : null,
    actionStatus: row.action_status as PlannerActionStatus | null,
    executionId: row.execution_id,
    relatedWorkId: row.related_work_id,
    createdAt: row.created_at,
  }
}

export class PlannerMessageRepository {
  constructor(private readonly db: Database) {}

  insert(record: PlannerMessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO planner_messages (
          id, author_type, author_id, content, action_json, action_status, execution_id,
          related_work_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.authorType,
        record.authorId,
        record.content,
        record.action ? serializeJsonColumn(JsonObject, record.action, 'planner.action') : null,
        record.actionStatus,
        record.executionId,
        record.relatedWorkId,
        record.createdAt,
      )
  }

  get(id: string): PlannerMessageRecord | null {
    const row = this.db.prepare('SELECT * FROM planner_messages WHERE id = ?').get(id) as
      | PlannerMessageRow
      | undefined
    return row ? toPlannerMessage(row) : null
  }

  list(limit = 200): PlannerMessageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM planner_messages ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(limit) as PlannerMessageRow[]
    return rows.map(toPlannerMessage)
  }

  listRecent(limit = 40): PlannerMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM planner_messages ORDER BY created_at DESC, rowid DESC LIMIT ?
        ) ORDER BY created_at ASC`,
      )
      .all(limit) as PlannerMessageRow[]
    return rows.map(toPlannerMessage)
  }

  updateActionStatus(
    id: string,
    from: readonly PlannerActionStatus[],
    to: PlannerActionStatus,
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE planner_messages SET action_status = ?
         WHERE id = ? AND action_status IN (${placeholders})`,
      )
      .run(to, id, ...from)
    return result.changes > 0
  }
}

export const TEAM_MESSAGE_AUTHOR_TYPES = ['user', 'leader', 'member', 'planner', 'system'] as const
export type TeamMessageAuthorType = (typeof TEAM_MESSAGE_AUTHOR_TYPES)[number]

export const TEAM_MESSAGE_KINDS = ['message', 'decision', 'escalation', 'run', 'status'] as const
export type TeamMessageKind = (typeof TEAM_MESSAGE_KINDS)[number]

export type TeamTaskMessageRecord = {
  id: string
  workId: string
  authorType: TeamMessageAuthorType
  authorId: string
  content: string
  kind: TeamMessageKind
  metadata: Record<string, unknown>
  executionId: string | null
  createdAt: string
}

type TeamTaskMessageRow = {
  id: string
  work_id: string
  author_type: string
  author_id: string
  content: string
  kind: string
  metadata_json: string
  execution_id: string | null
  created_at: string
}

function toTeamTaskMessage(row: TeamTaskMessageRow): TeamTaskMessageRecord {
  if (!(TEAM_MESSAGE_AUTHOR_TYPES as readonly string[]).includes(row.author_type)) {
    throw new Error(`unexpected team_task_messages.author_type: ${row.author_type}`)
  }
  if (!(TEAM_MESSAGE_KINDS as readonly string[]).includes(row.kind)) {
    throw new Error(`unexpected team_task_messages.kind: ${row.kind}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    authorType: row.author_type as TeamMessageAuthorType,
    authorId: row.author_id,
    content: row.content,
    kind: row.kind as TeamMessageKind,
    metadata: parseJsonColumn(
      JsonObject,
      row.metadata_json,
      `team_task_messages.metadata_json(${row.id})`,
    ),
    executionId: row.execution_id,
    createdAt: row.created_at,
  }
}

export class TeamTaskMessageRepository {
  constructor(private readonly db: Database) {}

  insert(record: TeamTaskMessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_task_messages (
          id, work_id, author_type, author_id, content, kind, metadata_json, execution_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.authorType,
        record.authorId,
        record.content,
        record.kind,
        serializeJsonColumn(JsonObject, record.metadata, 'teamTaskMessage.metadata'),
        record.executionId,
        record.createdAt,
      )
  }

  get(id: string): TeamTaskMessageRecord | null {
    const row = this.db.prepare('SELECT * FROM team_task_messages WHERE id = ?').get(id) as
      | TeamTaskMessageRow
      | undefined
    return row ? toTeamTaskMessage(row) : null
  }

  listByWork(workId: string, limit = 200): TeamTaskMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_task_messages WHERE work_id = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(workId, limit) as TeamTaskMessageRow[]
    return rows.map(toTeamTaskMessage)
  }

  listRecent(workId: string, limit = 30): TeamTaskMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM team_task_messages WHERE work_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        ) ORDER BY created_at ASC`,
      )
      .all(workId, limit) as TeamTaskMessageRow[]
    return rows.map(toTeamTaskMessage)
  }

  listMemberMessagesByContent(content: string, limit = 50): TeamTaskMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_task_messages
         WHERE author_type = 'member' AND content = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(content, limit) as TeamTaskMessageRow[]
    return rows.map(toTeamTaskMessage)
  }

  updateContent(id: string, content: string): void {
    this.db.prepare('UPDATE team_task_messages SET content = ? WHERE id = ?').run(content, id)
  }
}

export const TEAM_SUBTASK_STATUSES = ['pending', 'running', 'review', 'done', 'blocked'] as const
export type TeamSubtaskStatus = (typeof TEAM_SUBTASK_STATUSES)[number]

export type TeamTaskSubtaskRecord = {
  id: string
  workId: string
  title: string
  description: string
  assigneeAgentId: string | null
  status: TeamSubtaskStatus
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

type TeamTaskSubtaskRow = {
  id: string
  work_id: string
  title: string
  description: string
  assignee_agent_id: string | null
  status: string
  created_at: string
  updated_at: string
  completed_at: string | null
}

function toTeamSubtask(row: TeamTaskSubtaskRow): TeamTaskSubtaskRecord {
  if (!(TEAM_SUBTASK_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected team_task_subtasks.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    title: row.title,
    description: row.description,
    assigneeAgentId: row.assignee_agent_id,
    status: row.status as TeamSubtaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export class TeamTaskSubtaskRepository {
  constructor(private readonly db: Database) {}

  insert(record: TeamTaskSubtaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_task_subtasks (
          id, work_id, title, description, assignee_agent_id, status, created_at, updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.title,
        record.description,
        record.assigneeAgentId,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.completedAt,
      )
  }

  get(id: string): TeamTaskSubtaskRecord | null {
    const row = this.db.prepare('SELECT * FROM team_task_subtasks WHERE id = ?').get(id) as
      | TeamTaskSubtaskRow
      | undefined
    return row ? toTeamSubtask(row) : null
  }

  listByWork(workId: string): TeamTaskSubtaskRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM team_task_subtasks WHERE work_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(workId) as TeamTaskSubtaskRow[]
    return rows.map(toTeamSubtask)
  }

  updateStatus(
    id: string,
    from: readonly TeamSubtaskStatus[],
    to: TeamSubtaskStatus,
    now: string,
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE team_task_subtasks
         SET status = ?, updated_at = ?, completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now, to, now, id, ...from)
    return result.changes > 0
  }

  nextPending(workId: string): TeamTaskSubtaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM team_task_subtasks
         WHERE work_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(workId) as TeamTaskSubtaskRow | undefined
    return row ? toTeamSubtask(row) : null
  }
}

export const TEAM_RUN_ROLES = ['leader', 'member'] as const
export type TeamRunRole = (typeof TEAM_RUN_ROLES)[number]

export const TEAM_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number]

export type TeamTaskRunRecord = {
  id: string
  workId: string
  agentId: string | null
  role: TeamRunRole
  triggerMessageId: string | null
  subtaskId: string | null
  status: TeamRunStatus
  executionId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
}

type TeamTaskRunRow = {
  id: string
  work_id: string
  agent_id: string | null
  role: string
  trigger_message_id: string | null
  subtask_id: string | null
  status: string
  execution_id: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  ended_at: string | null
}

function toTeamRun(row: TeamTaskRunRow): TeamTaskRunRecord {
  if (!(TEAM_RUN_ROLES as readonly string[]).includes(row.role)) {
    throw new Error(`unexpected team_task_runs.role: ${row.role}`)
  }
  if (!(TEAM_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected team_task_runs.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    agentId: row.agent_id,
    role: row.role as TeamRunRole,
    triggerMessageId: row.trigger_message_id,
    subtaskId: row.subtask_id,
    status: row.status as TeamRunStatus,
    executionId: row.execution_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export class TeamTaskRunRepository {
  constructor(private readonly db: Database) {}

  insert(record: TeamTaskRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_task_runs (
          id, work_id, agent_id, role, trigger_message_id, subtask_id, status, execution_id,
          error_code, error_message, created_at, updated_at, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.agentId,
        record.role,
        record.triggerMessageId,
        record.subtaskId,
        record.status,
        record.executionId,
        record.errorCode,
        record.errorMessage,
        record.createdAt,
        record.updatedAt,
        record.startedAt,
        record.endedAt,
      )
  }

  get(id: string): TeamTaskRunRecord | null {
    const row = this.db.prepare('SELECT * FROM team_task_runs WHERE id = ?').get(id) as
      | TeamTaskRunRow
      | undefined
    return row ? toTeamRun(row) : null
  }

  getActiveByWork(workId: string): TeamTaskRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM team_task_runs WHERE work_id = ? AND status IN ('queued', 'running')
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(workId) as TeamTaskRunRow | undefined
    return row ? toTeamRun(row) : null
  }

  getQueuedByWork(workId: string): TeamTaskRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM team_task_runs WHERE work_id = ? AND status = 'queued'
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(workId) as TeamTaskRunRow | undefined
    return row ? toTeamRun(row) : null
  }

  getByExecutionId(executionId: string): TeamTaskRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_task_runs WHERE execution_id = ?')
      .get(executionId) as TeamTaskRunRow | undefined
    return row ? toTeamRun(row) : null
  }

  listByWork(workId: string, limit = 100): TeamTaskRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_task_runs WHERE work_id = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(workId, limit) as TeamTaskRunRow[]
    return rows.map(toTeamRun)
  }

  listUnfinished(): TeamTaskRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_task_runs WHERE status IN ('queued', 'running')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as TeamTaskRunRow[]
    return rows.map(toTeamRun)
  }

  listMemberRunsWithoutSteps(limit = 50): TeamTaskRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM team_task_runs r
         WHERE r.role = 'member' AND r.execution_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM team_task_run_steps s WHERE s.run_id = r.id)
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as TeamTaskRunRow[]
    return rows.map(toTeamRun)
  }

  updateQueuedTrigger(id: string, triggerMessageId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE team_task_runs SET trigger_message_id = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(triggerMessageId, now, id)
    return result.changes > 0
  }

  updateQueuedTarget(
    id: string,
    target: {
      agentId: string
      role: TeamRunRole
      subtaskId: string | null
      triggerMessageId: string | null
    },
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE team_task_runs
         SET agent_id = ?, role = ?, subtask_id = ?, trigger_message_id = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(target.agentId, target.role, target.subtaskId, target.triggerMessageId, now, id)
    return result.changes > 0
  }

  markRunning(id: string, executionId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE team_task_runs
         SET status = 'running', execution_id = ?, started_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(executionId, now, now, id)
    return result.changes > 0
  }

  finish(
    id: string,
    status: Extract<TeamRunStatus, 'succeeded' | 'failed' | 'cancelled'>,
    errorCode: string | null,
    errorMessage: string | null,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE team_task_runs
         SET status = ?, error_code = ?, error_message = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(status, errorCode, errorMessage, now, now, id)
    return result.changes > 0
  }

  cancelActive(workId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE team_task_runs SET status = 'cancelled', ended_at = ?, updated_at = ?
         WHERE work_id = ? AND status IN ('queued', 'running')`,
      )
      .run(now, now, workId)
    return Number(result.changes)
  }

  newId(): string {
    return newId('trun')
  }
}

export type TeamTaskRunStepRecord = {
  id: string
  workId: string
  runId: string
  stepKey: string
  name: string
  summary: string
  createdAt: string
}

type TeamTaskRunStepRow = {
  id: string
  work_id: string
  run_id: string
  step_key: string
  name: string
  summary: string
  created_at: string
}

function toTeamRunStep(row: TeamTaskRunStepRow): TeamTaskRunStepRecord {
  return {
    id: row.id,
    workId: row.work_id,
    runId: row.run_id,
    stepKey: row.step_key,
    name: row.name,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

/** 执行记录：把每次工具调用（尤其是 Bash）持久化，线程可回看。 */
export class TeamTaskRunStepRepository {
  constructor(private readonly db: Database) {}

  insert(record: TeamTaskRunStepRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO team_task_run_steps (
          id, work_id, run_id, step_key, name, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.runId,
        record.stepKey,
        record.name,
        record.summary,
        record.createdAt,
      )
  }

  listByWork(workId: string, limit = 200): TeamTaskRunStepRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM team_task_run_steps WHERE work_id = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(workId, limit) as TeamTaskRunStepRow[]
    return rows.map(toTeamRunStep)
  }

  listByRun(runId: string): TeamTaskRunStepRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM team_task_run_steps WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(runId) as TeamTaskRunStepRow[]
    return rows.map(toTeamRunStep)
  }
}
