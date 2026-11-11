import type {
  PlanDispatchStatus,
  PlanStartAttemptStatus,
  PlanTaskAssignmentSource,
  PlanTaskAssignmentStatus,
} from '@agentra/protocol'
import type { Database } from '../database'

export type PlanTaskAssignmentRecord = {
  id: string
  planId: string
  planVersionId: string
  taskKey: string
  teamId: string | null
  agentId: string
  source: PlanTaskAssignmentSource
  assignedBy: string
  reason: string | null
  status: PlanTaskAssignmentStatus
  createdAt: string
  updatedAt: string
}

type PlanTaskAssignmentRow = {
  id: string
  plan_id: string
  plan_version_id: string
  task_key: string
  team_id: string | null
  agent_id: string
  source: string
  assigned_by: string
  reason: string | null
  status: string
  created_at: string
  updated_at: string
}

function toPlanTaskAssignment(row: PlanTaskAssignmentRow): PlanTaskAssignmentRecord {
  if (
    row.source !== 'planner' &&
    row.source !== 'leader' &&
    row.source !== 'user' &&
    row.source !== 'legacy'
  ) {
    throw new Error(`unexpected plan_task_assignments.source: ${row.source}`)
  }
  if (row.status !== 'active' && row.status !== 'superseded') {
    throw new Error(`unexpected plan_task_assignments.status: ${row.status}`)
  }
  return {
    id: row.id,
    planId: row.plan_id,
    planVersionId: row.plan_version_id,
    taskKey: row.task_key,
    teamId: row.team_id,
    agentId: row.agent_id,
    source: row.source,
    assignedBy: row.assigned_by,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** plan_task_assignments 的唯一数据访问入口；业务校验在 PlanAssignmentService。 */
export class PlanTaskAssignmentRepository {
  constructor(private readonly db: Database) {}

  insert(record: PlanTaskAssignmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO plan_task_assignments (
          id, plan_id, plan_version_id, task_key, team_id, agent_id, source, assigned_by,
          reason, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.planId,
        record.planVersionId,
        record.taskKey,
        record.teamId,
        record.agentId,
        record.source,
        record.assignedBy,
        record.reason,
        record.status,
        record.createdAt,
        record.updatedAt,
      )
  }

  getActive(planVersionId: string, taskKey: string): PlanTaskAssignmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plan_task_assignments
         WHERE plan_version_id = ? AND task_key = ? AND status = 'active'`,
      )
      .get(planVersionId, taskKey) as PlanTaskAssignmentRow | undefined
    return row ? toPlanTaskAssignment(row) : null
  }

  listByVersion(planVersionId: string): PlanTaskAssignmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plan_task_assignments WHERE plan_version_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(planVersionId) as PlanTaskAssignmentRow[]
    return rows.map(toPlanTaskAssignment)
  }

  listActiveByVersion(planVersionId: string): PlanTaskAssignmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plan_task_assignments
         WHERE plan_version_id = ? AND status = 'active'
         ORDER BY task_key ASC`,
      )
      .all(planVersionId) as PlanTaskAssignmentRow[]
    return rows.map(toPlanTaskAssignment)
  }

  listByPlan(planId: string): PlanTaskAssignmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plan_task_assignments WHERE plan_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(planId) as PlanTaskAssignmentRow[]
    return rows.map(toPlanTaskAssignment)
  }

  /** 把当前 active 行置为 superseded；返回是否命中。 */
  supersedeActive(planVersionId: string, taskKey: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_task_assignments SET status = 'superseded', updated_at = ?
         WHERE plan_version_id = ? AND task_key = ? AND status = 'active'`,
      )
      .run(now, planVersionId, taskKey)
    return result.changes > 0
  }
}

export type PlanDispatchRecord = {
  id: string
  planId: string
  planVersionId: string
  teamId: string
  leaderAgentId: string | null
  status: PlanDispatchStatus
  attempt: number
  executionId: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

type PlanDispatchRow = {
  id: string
  plan_id: string
  plan_version_id: string
  team_id: string
  leader_agent_id: string | null
  status: string
  attempt: number
  execution_id: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

function toPlanDispatch(row: PlanDispatchRow): PlanDispatchRecord {
  if (
    row.status !== 'pending' &&
    row.status !== 'running' &&
    row.status !== 'succeeded' &&
    row.status !== 'failed' &&
    row.status !== 'cancelled'
  ) {
    throw new Error(`unexpected plan_dispatches.status: ${row.status}`)
  }
  return {
    id: row.id,
    planId: row.plan_id,
    planVersionId: row.plan_version_id,
    teamId: row.team_id,
    leaderAgentId: row.leader_agent_id,
    status: row.status,
    attempt: row.attempt,
    executionId: row.execution_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PlanDispatchRepository {
  constructor(private readonly db: Database) {}

  insert(record: PlanDispatchRecord): void {
    this.db
      .prepare(
        `INSERT INTO plan_dispatches (
          id, plan_id, plan_version_id, team_id, leader_agent_id, status, attempt,
          execution_id, error_code, error_message, started_at, ended_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.planId,
        record.planVersionId,
        record.teamId,
        record.leaderAgentId,
        record.status,
        record.attempt,
        record.executionId,
        record.errorCode,
        record.errorMessage,
        record.startedAt,
        record.endedAt,
        record.createdAt,
        record.updatedAt,
      )
  }

  get(id: string): PlanDispatchRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_dispatches WHERE id = ?').get(id) as
      | PlanDispatchRow
      | undefined
    return row ? toPlanDispatch(row) : null
  }

  getByVersionTeam(planVersionId: string, teamId: string): PlanDispatchRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plan_dispatches WHERE plan_version_id = ? AND team_id = ?')
      .get(planVersionId, teamId) as PlanDispatchRow | undefined
    return row ? toPlanDispatch(row) : null
  }

  listByVersion(planVersionId: string): PlanDispatchRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM plan_dispatches WHERE plan_version_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(planVersionId) as PlanDispatchRow[]
    return rows.map(toPlanDispatch)
  }

  listByPlan(planId: string): PlanDispatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_dispatches WHERE plan_id = ? ORDER BY created_at ASC, id ASC')
      .all(planId) as PlanDispatchRow[]
    return rows.map(toPlanDispatch)
  }

  listByStatus(status: PlanDispatchStatus): PlanDispatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_dispatches WHERE status = ? ORDER BY created_at ASC, id ASC')
      .all(status) as PlanDispatchRow[]
    return rows.map(toPlanDispatch)
  }

  /** pending/failed → running；attempt++，清除上次错误。 */
  claim(id: string, leaderAgentId: string | null, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_dispatches
         SET status = 'running',
             attempt = CASE WHEN status = 'failed' THEN attempt + 1 ELSE attempt END,
             leader_agent_id = ?,
             execution_id = NULL, error_code = NULL, error_message = NULL,
             started_at = ?, ended_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
      )
      .run(leaderAgentId, now, now, id)
    return result.changes > 0
  }

  markSucceeded(id: string, executionId: string | null, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_dispatches
         SET status = 'succeeded', execution_id = COALESCE(?, execution_id),
             error_code = NULL, error_message = NULL, ended_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(executionId, now, now, id)
    return result.changes > 0
  }

  markFailed(id: string, code: string, message: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_dispatches
         SET status = 'failed', error_code = ?, error_message = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(code, message, now, now, id)
    return result.changes > 0
  }

  setExecutionId(id: string, executionId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE plan_dispatches SET execution_id = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(executionId, now, id)
  }

  cancelPendingForVersion(planVersionId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE plan_dispatches SET status = 'cancelled', ended_at = ?, updated_at = ?
         WHERE plan_version_id = ? AND status IN ('pending', 'failed')`,
      )
      .run(now, now, planVersionId)
    return Number(result.changes)
  }
}

export type PlanStartAttemptRecord = {
  id: string
  planId: string
  planVersionId: string
  requestId: string
  status: PlanStartAttemptStatus
  assignmentSnapshotJson: string
  planChecksum: string
  workflowVersionId: string | null
  workflowRunId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

type PlanStartAttemptRow = {
  id: string
  plan_id: string
  plan_version_id: string
  request_id: string
  status: string
  assignment_snapshot_json: string
  plan_checksum: string
  workflow_version_id: string | null
  workflow_run_id: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

function toPlanStartAttempt(row: PlanStartAttemptRow): PlanStartAttemptRecord {
  if (
    row.status !== 'preparing' &&
    row.status !== 'starting' &&
    row.status !== 'running' &&
    row.status !== 'failed' &&
    row.status !== 'cancelled'
  ) {
    throw new Error(`unexpected plan_start_attempts.status: ${row.status}`)
  }
  return {
    id: row.id,
    planId: row.plan_id,
    planVersionId: row.plan_version_id,
    requestId: row.request_id,
    status: row.status,
    assignmentSnapshotJson: row.assignment_snapshot_json,
    planChecksum: row.plan_checksum,
    workflowVersionId: row.workflow_version_id,
    workflowRunId: row.workflow_run_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PlanStartAttemptRepository {
  constructor(private readonly db: Database) {}

  insert(record: PlanStartAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO plan_start_attempts (
          id, plan_id, plan_version_id, request_id, status, assignment_snapshot_json,
          plan_checksum, workflow_version_id, workflow_run_id, error_code, error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.planId,
        record.planVersionId,
        record.requestId,
        record.status,
        record.assignmentSnapshotJson,
        record.planChecksum,
        record.workflowVersionId,
        record.workflowRunId,
        record.errorCode,
        record.errorMessage,
        record.createdAt,
        record.updatedAt,
      )
  }

  get(id: string): PlanStartAttemptRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_start_attempts WHERE id = ?').get(id) as
      | PlanStartAttemptRow
      | undefined
    return row ? toPlanStartAttempt(row) : null
  }

  getByRequestId(requestId: string): PlanStartAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plan_start_attempts WHERE request_id = ?')
      .get(requestId) as PlanStartAttemptRow | undefined
    return row ? toPlanStartAttempt(row) : null
  }

  getActiveByVersion(planVersionId: string): PlanStartAttemptRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plan_start_attempts
         WHERE plan_version_id = ? AND status IN ('preparing', 'starting')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(planVersionId) as PlanStartAttemptRow | undefined
    return row ? toPlanStartAttempt(row) : null
  }

  listByPlan(planId: string): PlanStartAttemptRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM plan_start_attempts WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(planId) as PlanStartAttemptRow[]
    return rows.map(toPlanStartAttempt)
  }

  listUnfinished(): PlanStartAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plan_start_attempts
         WHERE status IN ('preparing', 'starting')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as PlanStartAttemptRow[]
    return rows.map(toPlanStartAttempt)
  }

  markStarting(id: string, workflowVersionId: string, workflowRunId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_start_attempts
         SET status = 'starting', workflow_version_id = ?, workflow_run_id = ?,
             error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'preparing'`,
      )
      .run(workflowVersionId, workflowRunId, now, id)
    return result.changes > 0
  }

  markRunning(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_start_attempts SET status = 'running', updated_at = ?
         WHERE id = ? AND status IN ('preparing', 'starting')`,
      )
      .run(now, id)
    return result.changes > 0
  }

  markFailed(id: string, code: string, message: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_start_attempts
         SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN ('preparing', 'starting')`,
      )
      .run(code, message, now, id)
    return result.changes > 0
  }

  markCancelled(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE plan_start_attempts SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('preparing', 'starting')`,
      )
      .run(now, id)
    return result.changes > 0
  }
}
