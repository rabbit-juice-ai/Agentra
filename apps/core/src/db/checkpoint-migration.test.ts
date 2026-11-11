import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const NOW = '2026-11-09T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-checkpoint-migration-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

describe('v32 task_checkpoints migration', () => {
  it('preserves v31 Work/TaskMemory data and enforces immutable references', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 31),
      )
      expect(currentUserVersion(db)).toBe(31)
      db.prepare(
        `INSERT INTO works (id, name, root_path, created_at, updated_at)
         VALUES ('work-old', 'Old Work', '/tmp/old', ?, ?)`,
      ).run(NOW, NOW)
      db.prepare(
        `INSERT INTO task_memories (
          work_id, version, memory_json, acceptance_criteria_snapshot_json,
          acceptance_criteria_work_version, acceptance_criteria_work_updated_at,
          summary, created_at, updated_at
        ) VALUES ('work-old', 2, '{"schemaVersion":1}', '["old criterion"]', 2, ?, '', ?, ?)`,
      ).run(NOW, NOW, NOW)

      const result = migrate(db)
      expect(result).toEqual({
        from: 31,
        to: 34,
        applied: ['task_checkpoints', 'task_recovery_attempts', 'workflow_node_recovery'],
      })
      expect(currentUserVersion(db)).toBe(34)
      expect(
        db
          .prepare(
            `SELECT name, root_path, acceptance_criteria_json, acceptance_criteria_version
             FROM works WHERE id = 'work-old'`,
          )
          .get(),
      ).toEqual({
        name: 'Old Work',
        root_path: '/tmp/old',
        acceptance_criteria_json: '[]',
        acceptance_criteria_version: 1,
      })
      expect(
        db
          .prepare(
            `SELECT version, memory_json, acceptance_criteria_snapshot_json
             FROM task_memories WHERE work_id = 'work-old'`,
          )
          .get(),
      ).toEqual({
        version: 2,
        memory_json: '{"schemaVersion":1}',
        acceptance_criteria_snapshot_json: '["old criterion"]',
      })

      const columns = db
        .prepare('PRAGMA table_info(task_checkpoints)')
        .all()
        .map((row) => (row as { name: string }).name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'state',
          'base_dedupe_key',
          'dedupe_key',
          'attempt_no',
          'verification_json',
          'content_hash',
        ]),
      )

      db.prepare(
        `INSERT INTO task_checkpoints (
          id, work_id, seq, base_dedupe_key, dedupe_key, attempt_no, state, kind, stage,
          acceptance_criteria_work_version, task_memory_version, risk_level, evidence_status,
          side_effect_completeness, checkpoint_json, evidence_json, verification_json,
          content_hash, created_at
        ) VALUES (
          'chk-old', 'work-old', 1, 'execution:exe-old:stage_complete',
          'execution:exe-old:stage_complete', 1, 'valid', 'stage_complete', 'node',
          2, 2, 'low', 'verified', 'not_tracked', '{}', '{}', '{}', 'hash-old', ?
        )`,
      ).run(NOW)

      expect(() =>
        db.prepare("UPDATE task_checkpoints SET state = 'failed' WHERE id = 'chk-old'").run(),
      ).toThrow(/immutable/)
      expect(() => db.prepare("DELETE FROM task_checkpoints WHERE id = 'chk-old'").run()).toThrow(
        /immutable/,
      )
      expect(() => db.prepare("DELETE FROM works WHERE id = 'work-old'").run()).toThrow()
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('enforces recovery attempt active, idempotency, attempt and foreign-key constraints', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db)
      db.prepare(
        `INSERT INTO works (id, name, root_path, created_at, updated_at)
         VALUES ('work-rec', 'Recovery Work', '/tmp/rec', ?, ?)`,
      ).run(NOW, NOW)
      db.prepare(
        `INSERT INTO task_checkpoints (
          id, work_id, seq, base_dedupe_key, dedupe_key, attempt_no, state, kind, stage,
          acceptance_criteria_work_version, task_memory_version, risk_level, evidence_status,
          side_effect_completeness, checkpoint_json, evidence_json, verification_json,
          content_hash, created_at
        ) VALUES (
          'chk-rec', 'work-rec', 1, 'execution:exe-rec:stage_complete',
          'execution:exe-rec:stage_complete', 1, 'valid', 'stage_complete', 'node',
          1, 1, 'low', 'verified', 'not_tracked', '{}', '{}', '{}', 'hash-rec', ?
        )`,
      ).run(NOW)
      const insertAttempt = (
        id: string,
        idempotency: string,
        attemptNo: number,
        status = 'starting',
      ) =>
        db
          .prepare(
            `INSERT INTO task_recovery_attempts (
              id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key,
              idempotency_key, attempt_no, status, risk_level, eligibility_status,
              plan_hash, context_manifest_json, created_at, updated_at
            ) VALUES (?, 'work-rec', 'chk-rec', 'generic', 'recovery:work-rec:chk-rec',
              ?, ?, ?, ?, 'low', 'eligible', 'plan-hash', '{}', ?, ?)`,
          )
          .run(
            id,
            `recovery:work-rec:chk-rec#attempt-${attemptNo}`,
            idempotency,
            attemptNo,
            status,
            NOW,
            NOW,
          )

      insertAttempt('rec-1', 'idem-1', 1)
      expect(() => insertAttempt('rec-2', 'idem-2', 2)).toThrow()
      db.prepare("UPDATE task_recovery_attempts SET status = 'failed' WHERE id = 'rec-1'").run()
      insertAttempt('rec-2', 'idem-2', 2)
      expect(() => insertAttempt('rec-3', 'idem-1', 3)).toThrow()
      expect(() => insertAttempt('rec-3', 'idem-3', 2)).toThrow()
      expect(() =>
        db
          .prepare(
            `INSERT INTO task_recovery_attempts (
              id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key,
              idempotency_key, attempt_no, status, risk_level, eligibility_status,
              plan_hash, context_manifest_json, created_at, updated_at
            ) VALUES ('rec-bad', 'work-rec', 'chk-rec', 'generic', 'bad', 'bad',
              'idem-bad', 9, 'invalid-status', 'low', 'eligible', 'h', '{}', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow()
      expect(() => db.prepare("DELETE FROM works WHERE id = 'work-rec'").run()).toThrow()
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })
})
