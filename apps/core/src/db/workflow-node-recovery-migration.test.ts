import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const dirs: string[] = []
const NOW = '2026-11-10T00:00:00.000Z'

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function seed(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO task_checkpoints (
       id, work_id, seq, base_dedupe_key, dedupe_key, attempt_no, state, kind, stage,
       execution_id, session_id, node_run_id, team_run_id, parent_checkpoint_id,
       acceptance_criteria_work_version, task_memory_version, risk_level, evidence_status,
       side_effect_completeness, checkpoint_json, evidence_json, verification_json,
       error_json, content_hash, created_at
     ) VALUES ('chk-1', 'work-1', 1, 'base', 'dedupe', 1, 'valid', 'stage_complete', '',
       NULL, NULL, NULL, NULL, NULL, 1, NULL, 'low', 'verified', 'not_tracked',
       '{}', '{}', '{}', NULL, 'hash', ?)`,
  ).run(NOW)
  db.prepare(
    `INSERT INTO task_recovery_attempts (
       id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
       attempt_no, status, risk_level, eligibility_status, original_work_status,
       reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
       execution_id, session_id, team_run_id, node_run_id, error_json, created_at,
       updated_at, started_at, ended_at
     ) VALUES ('rec-old', 'work-1', 'chk-1', 'generic', 'base', 'dedupe', 'idem-old',
       1, 'failed', 'low', 'eligible', NULL, NULL, '{}', 'hash', '{}',
       NULL, NULL, NULL, NULL, '{"reason":"old"}', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW)
}

describe('v34 workflow node recovery migration', () => {
  it('preserves v33 recovery rows and adds workflow columns/indexes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-v34-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 33),
      )
      expect(currentUserVersion(db)).toBe(33)
      seed(db)

      const result = migrate(db)
      expect(result.to).toBe(34)
      expect(currentUserVersion(db)).toBe(34)

      const old = db
        .prepare("SELECT * FROM task_recovery_attempts WHERE id = 'rec-old'")
        .get() as Record<string, unknown>
      expect(old.kind).toBe('generic')
      expect(old.workflow_run_id).toBeNull()
      expect(old.recovered_node_run_id).toBeNull()
      expect(old.chain_attempt_no).toBeNull()
      expect(old.error_json).toBe('{"reason":"old"}')

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_task_recovery_attempts_chain_attempt',
          'idx_task_recovery_attempts_active_chain',
          'idx_worktrees_work_branch_active',
          'idx_node_runs_run_key_attempt',
        ]),
      )
      const lockColumns = (
        db.prepare('PRAGMA table_info(workdir_locks)').all() as { name: string }[]
      ).map((row) => row.name)
      expect(lockColumns).toEqual(expect.arrayContaining(['holder_started_at', 'holder_kind']))
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })
})
