import { newId } from '@agentra/shared'
import { z } from 'zod'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

/** 审计日志（DATABASE §2.9）。actor_type 用 user / agent / system。 */
export type AuditActorType = 'user' | 'agent' | 'system'

export type AuditLogRecord = {
  id: string
  actorType: AuditActorType
  actorId: string | null
  action: string
  targetType: string
  targetId: string
  details: Record<string, unknown>
  createdAt: string
}

const DetailsSchema = z.record(z.string(), z.unknown())

type AuditRow = {
  id: string
  actor_type: string
  actor_id: string | null
  action: string
  target_type: string
  target_id: string
  details_json: string
  created_at: string
}

const ACTOR_TYPES: readonly string[] = ['user', 'agent', 'system']

function toRecord(row: AuditRow): AuditLogRecord {
  if (!ACTOR_TYPES.includes(row.actor_type)) {
    throw new Error(`unexpected audit_logs.actor_type: ${row.actor_type}`)
  }
  return {
    id: row.id,
    actorType: row.actor_type as AuditActorType,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    details: parseJsonColumn(DetailsSchema, row.details_json, `audit_logs.details_json(${row.id})`),
    createdAt: row.created_at,
  }
}

export type AppendAuditInput = {
  actorType: AuditActorType
  actorId?: string | null
  action: string
  targetType: string
  targetId: string
  details?: Record<string, unknown>
  now: string
}

/** audit_logs 的唯一写入口；只追加，不更新、不删除。 */
export class AuditRepository {
  constructor(private readonly db: Database) {}

  append(input: AppendAuditInput): AuditLogRecord {
    const record: AuditLogRecord = {
      id: newId('aud'),
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      details: input.details ?? {},
      createdAt: input.now,
    }
    this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.actorType,
        record.actorId,
        record.action,
        record.targetType,
        record.targetId,
        serializeJsonColumn(DetailsSchema, record.details, 'audit.details'),
        record.createdAt,
      )
    return record
  }

  listByTarget(targetType: string, targetId: string): AuditLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(targetType, targetId) as AuditRow[]
    return rows.map(toRecord)
  }

  listByAction(action: string): AuditLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at ASC, id ASC')
      .all(action) as AuditRow[]
    return rows.map(toRecord)
  }
}
