import type { Database } from '../database'

export const ASSIGNMENT_STATUSES = ['active', 'paused', 'completed', 'removed'] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

export type AssignmentRecord = {
  id: string
  workId: string
  agentId: string
  teamId: string | null
  workRole: string
  taskScope: string
  status: AssignmentStatus
  concurrencyLimit: number | null
  contextRef: string | null
  createdAt: string
  updatedAt: string
}

type AssignmentRow = {
  id: string
  work_id: string
  agent_id: string
  team_id: string | null
  work_role: string
  task_scope: string
  status: string
  concurrency_limit: number | null
  context_ref: string | null
  created_at: string
  updated_at: string
}

function toAssignment(row: AssignmentRow): AssignmentRecord {
  if (!(ASSIGNMENT_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`unexpected assignments.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    agentId: row.agent_id,
    teamId: row.team_id,
    workRole: row.work_role,
    taskScope: row.task_scope,
    status: row.status as AssignmentStatus,
    concurrencyLimit: row.concurrency_limit,
    contextRef: row.context_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** assignments 的唯一数据访问入口（Core 独占）。 */
export class AssignmentRepository {
  constructor(private readonly db: Database) {}

  insert(assignment: AssignmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO assignments (
          id, work_id, agent_id, team_id, work_role, task_scope, status,
          concurrency_limit, context_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assignment.id,
        assignment.workId,
        assignment.agentId,
        assignment.teamId,
        assignment.workRole,
        assignment.taskScope,
        assignment.status,
        assignment.concurrencyLimit,
        assignment.contextRef,
        assignment.createdAt,
        assignment.updatedAt,
      )
  }

  /** 状态迁移：带「当前状态」条件，避免并发覆盖。 */
  updateStatus(id: string, from: AssignmentStatus, to: AssignmentStatus, now: string): boolean {
    const result = this.db
      .prepare('UPDATE assignments SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, now, id, from)
    return result.changes > 0
  }

  get(id: string): AssignmentRecord | null {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      | AssignmentRow
      | undefined
    return row ? toAssignment(row) : null
  }

  findByWorkAndAgent(workId: string, agentId: string): AssignmentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM assignments WHERE work_id = ? AND agent_id = ?')
      .get(workId, agentId) as AssignmentRow | undefined
    return row ? toAssignment(row) : null
  }

  listByWork(workId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM assignments WHERE work_id = ? ORDER BY created_at ASC, id ASC')
      .all(workId) as AssignmentRow[]
    return rows.map(toAssignment)
  }

  listByAgent(agentId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM assignments WHERE agent_id = ? ORDER BY created_at ASC, id ASC')
      .all(agentId) as AssignmentRow[]
    return rows.map(toAssignment)
  }
}
