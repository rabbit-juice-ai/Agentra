import type { Database } from '../database'

export type SessionStatus = 'active' | 'ended'

export type SessionRecord = {
  id: string
  assignmentId: string | null
  providerId: string
  externalSessionId: string | null
  /** 阶段 1 无 Assignment：存放 agentId，阶段 2 迁移到 assignment_id。 */
  contextRef: string | null
  status: SessionStatus
  createdAt: string
  updatedAt: string
  lastActiveAt: string | null
}

type SessionRow = {
  id: string
  assignment_id: string | null
  provider_id: string
  external_session_id: string | null
  context_ref: string | null
  status: string
  created_at: string
  updated_at: string
  last_active_at: string | null
}

function toSession(row: SessionRow): SessionRecord {
  if (row.status !== 'active' && row.status !== 'ended') {
    throw new Error(`unexpected agent_sessions.status: ${row.status}`)
  }
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    providerId: row.provider_id,
    externalSessionId: row.external_session_id,
    contextRef: row.context_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  }
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  create(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (
          id, assignment_id, provider_id, external_session_id, context_ref, status,
          created_at, updated_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.assignmentId,
        session.providerId,
        session.externalSessionId,
        session.contextRef,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.lastActiveAt,
      )
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return row ? toSession(row) : null
  }

  end(id: string, now: string): void {
    this.db
      .prepare(
        "UPDATE agent_sessions SET status = 'ended', updated_at = ?, last_active_at = ? WHERE id = ?",
      )
      .run(now, now, id)
  }
}
