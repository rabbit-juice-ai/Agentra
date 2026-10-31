import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from './database'
import { migrate } from './migrations'
import { ExecutionRepository } from './repositories/execution-repository'

const dirs: string[] = []

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-queue-db-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CAPABILITIES = JSON.stringify({
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'unsupported',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
})

type Row = { id: string; recoveryState: string | null; createdAt: string }

/**
 * D-3 真实库用例：普通 / 空格变体 / 嵌套误命中 / NULL 与垃圾值。
 * 生产库由 JSON.stringify 写入（无空格），但手工修库、外部工具与未来版本都可能产出空格形态。
 */
const ROWS: Row[] = [
  { id: 'exe-compact', recoveryState: '{"queued":true}', createdAt: '2026-01-01T00:00:01Z' },
  { id: 'exe-spaced', recoveryState: '{"queued": true}', createdAt: '2026-01-01T00:00:02Z' },
  {
    id: 'exe-nested',
    recoveryState: '{"outer":{"queued":true}}',
    createdAt: '2026-01-01T00:00:03Z',
  },
  { id: 'exe-null', recoveryState: null, createdAt: '2026-01-01T00:00:04Z' },
  { id: 'exe-garbage', recoveryState: 'not-json', createdAt: '2026-01-01T00:00:05Z' },
  { id: 'exe-false', recoveryState: '{"queued":false}', createdAt: '2026-01-01T00:00:06Z' },
]

function seed(): { db: Database; repo: ExecutionRepository } {
  const db = openDatabase(tempDb())
  migrate(db)
  db.prepare(
    `INSERT INTO runtime_providers (
       id, provider_type, provider_name, executable_path, version, capabilities_json,
       health_status, auth_method, health_detail, last_discovered_at, created_at, updated_at
     ) VALUES ('prov-1', 'cli', 'claude', NULL, NULL, '{}', 'healthy', NULL, NULL, NULL, 't0', 't0')`,
  ).run()
  db.prepare(
    `INSERT INTO agent_sessions (
       id, assignment_id, provider_id, external_session_id, context_ref, status,
       created_at, updated_at, last_active_at
     ) VALUES ('ses-1', NULL, 'prov-1', NULL, 'agent-1', 'active', 't0', 't0', NULL)`,
  ).run()

  const insert = db.prepare(
    `INSERT INTO executions (
       id, session_id, provider_id, status, working_directory,
       capabilities_snapshot_json, recovery_state_json, created_at, updated_at
     ) VALUES (?, 'ses-1', 'prov-1', 'pending', '/tmp', ?, ?, ?, ?)`,
  )
  for (const row of ROWS) {
    insert.run(row.id, CAPABILITIES, row.recoveryState, row.createdAt, row.createdAt)
  }

  return { db, repo: new ExecutionRepository(db) }
}

describe('D-3 · 队列判定（真实 SQLite）', () => {
  it('listQueued matches only real queued flags', () => {
    const { db, repo } = seed()
    try {
      expect(repo.listQueued().map((execution) => execution.id)).toEqual([
        'exe-compact',
        'exe-spaced',
      ])
    } finally {
      db.close()
    }
  })

  it('listQueuedByAgent applies the same JSON semantics', () => {
    const { db, repo } = seed()
    try {
      expect(repo.listQueuedByAgent('agent-1').map((execution) => execution.id)).toEqual([
        'exe-compact',
        'exe-spaced',
      ])
      expect(repo.listQueuedByAgent('agent-2')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('countActiveByAgent excludes queued rows and survives NULL / garbage', () => {
    const { db, repo } = seed()
    try {
      expect(repo.countActiveByAgent('agent-1')).toBe(4)
    } finally {
      db.close()
    }
  })

  it('uses the v7 partial index in the execution plan', () => {
    const { db } = seed()
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT e.id FROM executions e
           WHERE e.status = 'pending'
             AND (CASE
               WHEN e.recovery_state_json IS NULL THEN 0
               WHEN json_valid(e.recovery_state_json) = 0 THEN 0
               WHEN json_extract(e.recovery_state_json, '$.queued') = 1 THEN 1
               ELSE 0 END) = 1
           ORDER BY e.created_at ASC, e.id ASC`,
        )
        .all() as { detail: string }[]
      const detail = plan.map((row) => row.detail).join(' | ')
      expect(detail).toContain('idx_executions_pending_created')
    } finally {
      db.close()
    }
  })
})
