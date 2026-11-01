import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-exec-fk-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

function seedBase(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json,
       health_status, created_at, updated_at)
     VALUES ('prov-1', 'cli', 'claude', '{}', 'healthy', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
       context_ref, status, created_at, updated_at, last_active_at)
     VALUES ('ses-1', NULL, 'prov-1', NULL, 'agent-1', 'active', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES ('wft-1', 'T', '', '', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json,
       checksum, status, created_at, published_at)
     VALUES ('wfv-1', 'wft-1', 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'sum',
       'published', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, runtime_state_json,
       created_at, updated_at)
     VALUES ('run-1', 'work-1', 'wfv-1', 'running', '{}', ?, ?)`,
  ).run(NOW, NOW)
}

describe('migration v10 · executions.node_run_id 外键', () => {
  it('preserves every existing execution row across the table rebuild', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 9),
      )
      expect(currentUserVersion(db)).toBe(9)
      seedBase(db)
      db.prepare(
        `INSERT INTO executions (id, session_id, node_run_id, provider_id, external_execution_id,
           process_id, status, working_directory, started_at, ended_at, exit_code,
           capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
         VALUES ('exe-legacy', 'ses-1', NULL, 'prov-1', 'ext-1', 4242, 'succeeded', '/tmp/w',
           't1', 't2', 0, '{"streaming":"native"}', '{"queued":false}', ?, ?)`,
      ).run(NOW, NOW)

      const before = db.prepare("SELECT * FROM executions WHERE id = 'exe-legacy'").get()
      const result = migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 10),
      )
      expect(result).toEqual({
        from: 9,
        to: 10,
        applied: ['phase4_execution_node_run_fk'],
      })
      const after = db.prepare("SELECT * FROM executions WHERE id = 'exe-legacy'").get()
      expect(after).toEqual(before)

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_executions_status_updated_at',
          'idx_executions_session',
          'idx_executions_node_run',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('enforces the node_run_id foreign key and the one-execution-per-node unique index', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      seedBase(db)
      db.prepare(
        `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, status, attempt,
           input_snapshot_json, created_at, updated_at)
         VALUES ('nrn-1', 'run-1', 'task_1', 'running', 1, '{}', ?, ?)`,
      ).run(NOW, NOW)

      expect(() =>
        db
          .prepare(
            `INSERT INTO executions (id, session_id, node_run_id, provider_id, status,
               working_directory, capabilities_snapshot_json, created_at, updated_at)
             VALUES ('exe-orphan', 'ses-1', 'missing-node-run', 'prov-1', 'running', '/tmp/w', '{}', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/FOREIGN KEY constraint failed/)

      const insert = db.prepare(
        `INSERT INTO executions (id, session_id, node_run_id, provider_id, status,
           working_directory, capabilities_snapshot_json, created_at, updated_at)
         VALUES (?, 'ses-1', 'nrn-1', 'prov-1', 'running', '/tmp/w', '{}', ?, ?)`,
      )
      insert.run('exe-1', NOW, NOW)
      expect(() => insert.run('exe-2', NOW, NOW)).toThrow(/UNIQUE constraint failed/)
    } finally {
      db.close()
    }
  })
})
