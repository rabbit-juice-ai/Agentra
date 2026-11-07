import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkWorkflowConsistency } from '../workflow/consistency'
import { openDatabase, transaction } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-wf-runtime-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function openMigrated(): ReturnType<typeof openDatabase> {
  const db = openDatabase(tempDb())
  migrate(db)
  return db
}

function insertTemplateAndVersion(db: ReturnType<typeof openDatabase>): string {
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES ('wft-1', 'T', '', '', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_versions (
       id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at
     ) VALUES ('wfv-1', 'wft-1', 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'sum', 'published', ?, ?)`,
  ).run(NOW, NOW)
  return 'wfv-1'
}

function insertWork(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
}

describe('migration v9 · workflow runtime tables', () => {
  it('creates workflow_runs / branch_runs / node_runs with indexes', () => {
    const db = openMigrated()
    try {
      expect(currentUserVersion(db)).toBe(26)
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(tables).toEqual(expect.arrayContaining(['workflow_runs', 'branch_runs', 'node_runs']))

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_workflow_runs_work_status',
          'idx_branch_runs_run_status',
          'idx_node_runs_run_status',
          'idx_node_runs_run_key_attempt',
        ]),
      )

      const nodeColumns = (
        db.prepare('PRAGMA table_info(node_runs)').all() as { name: string }[]
      ).map((column) => column.name)
      expect(nodeColumns).toEqual(
        expect.arrayContaining([
          'workflow_run_id',
          'workflow_node_key',
          'branch_run_id',
          'status',
          'attempt',
          'error_json',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('enforces unique(workflow_run_id, branch_key)', () => {
    const db = openMigrated()
    try {
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      db.prepare(
        `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, runtime_state_json, created_at, updated_at)
         VALUES ('run-1', 'work-1', ?, 'pending', '{}', ?, ?)`,
      ).run(versionId, NOW, NOW)
      const insert = db.prepare(
        `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
         VALUES (?, 'run-1', 'ui', 'active', ?, ?)`,
      )
      insert.run('br-1', NOW, NOW)
      expect(() => insert.run('br-2', NOW, NOW)).toThrow(/UNIQUE constraint failed/)
    } finally {
      db.close()
    }
  })

  it('rejects unknown statuses and orphan foreign keys', () => {
    const db = openMigrated()
    try {
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, runtime_state_json, created_at, updated_at)
             VALUES ('run-bad', 'work-1', ?, 'nope', '{}', ?, ?)`,
          )
          .run(versionId, NOW, NOW),
      ).toThrow(/CHECK constraint failed/)

      expect(() =>
        db
          .prepare(
            `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
             VALUES ('br-orphan', 'missing-run', 'ui', 'active', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/FOREIGN KEY constraint failed/)
    } finally {
      db.close()
    }
  })

  it('is repeatable: running the full migration list twice is a no-op', () => {
    const db = openMigrated()
    try {
      const second = migrate(db)
      expect(second).toEqual({ from: 26, to: 26, applied: [] })

      // v9 自身的 SQL 也必须幂等（CREATE … IF NOT EXISTS），重放一次再回滚
      const v9 = MIGRATIONS.find((migration) => migration.version === 9)
      if (!v9) throw new Error('missing migration v9')
      expect(() => {
        db.exec('BEGIN IMMEDIATE')
        v9.up(db)
        db.exec('ROLLBACK')
      }).not.toThrow()
    } finally {
      db.close()
    }
  })
})

describe('migration v11 · approvals', () => {
  it('creates the approvals table with decision columns and unique(node_run_id, round)', () => {
    const db = openMigrated()
    try {
      const columns = (db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(
        (column) => column.name,
      )
      expect(columns).toEqual(
        expect.arrayContaining([
          'workflow_run_id',
          'node_run_id',
          'target_node_run_id',
          'approval_type',
          'status',
          'requested_by',
          'decided_by',
          'decided_at',
          'decision_comment',
          'round',
        ]),
      )

      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      db.prepare(
        `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-1', 'work-1', ?, 'running', ?, '{}', ?, ?)`,
      ).run(versionId, NOW, NOW, NOW)
      db.prepare(
        `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, status, attempt, input_snapshot_json, created_at, updated_at)
         VALUES ('node-1', 'run-1', 'approval', 'waiting_approval', 1, '{}', ?, ?)`,
      ).run(NOW, NOW)

      const insert = db.prepare(
        `INSERT INTO approvals (id, workflow_run_id, node_run_id, target_node_run_id, approval_type,
           status, requested_by, round, requested_at)
         VALUES (?, 'run-1', 'node-1', NULL, 'before_execute', 'pending', 'system', ?, ?)`,
      )
      insert.run('apv-1', 1, NOW)
      expect(() => insert.run('apv-2', 1, NOW)).toThrow(/UNIQUE constraint failed/)
      insert.run('apv-2', 2, NOW)

      expect(() =>
        db
          .prepare(
            `INSERT INTO approvals (id, workflow_run_id, node_run_id, approval_type, status, requested_by, round, requested_at)
             VALUES ('apv-orphan', 'run-1', 'node-missing', 'before_execute', 'pending', 'system', 1, ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY constraint failed/)

      expect(() =>
        db
          .prepare(
            `INSERT INTO approvals (id, workflow_run_id, node_run_id, approval_type, status, requested_by, round, requested_at)
             VALUES ('apv-bad', 'run-1', 'node-1', 'before_execute', 'nope', 'system', 3, ?)`,
          )
          .run(NOW),
      ).toThrow(/CHECK constraint failed/)
    } finally {
      db.close()
    }
  })
})

describe('migration v12/v13 · rework_requests + workflow_events', () => {
  it('rebuilds approvals with a rework FK and creates the idempotent rework table', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 11),
      )
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      db.prepare(
        `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-1', 'work-1', ?, 'running', ?, '{}', ?, ?)`,
      ).run(versionId, NOW, NOW, NOW)
      db.prepare(
        `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, status, attempt, input_snapshot_json, created_at, updated_at)
         VALUES ('node-approval', 'run-1', 'approval', 'waiting_approval', 1, '{}', ?, ?),
                ('node-task', 'run-1', 'task_1', 'succeeded', 1, '{}', ?, ?)`,
      ).run(NOW, NOW, NOW, NOW)
      db.prepare(
        `INSERT INTO approvals (id, workflow_run_id, node_run_id, target_node_run_id, approval_type,
           status, requested_by, round, requested_at)
         VALUES ('apv-1', 'run-1', 'node-approval', 'node-task', 'after_execute', 'changes_requested',
                 'system', 1, ?)`,
      ).run(NOW)

      const result = migrate(db)
      expect(result).toEqual({
        from: 11,
        to: 26,
        applied: [
          'phase4_rework_requests',
          'phase4_workflow_events',
          'phase5_artifacts',
          'phase5_5_backups',
          'planner_agent_capabilities',
          'agent_model',
          'plan_approval',
          'plan_version_source',
          'node_assignment_overrides',
          'projects',
          'plans_nullable_work',
          'agent_access_skills',
          'agent_system_agents',
          'team_members_drop_role',
          'team_instructions',
        ],
      })

      // 重建后 approvals 行逐列保留
      const approval = db.prepare("SELECT * FROM approvals WHERE id = 'apv-1'").get() as Record<
        string,
        unknown
      >
      expect(approval.target_node_run_id).toBe('node-task')
      expect(approval.status).toBe('changes_requested')
      expect(approval.rework_request_id).toBeNull()

      const columns = (
        db.prepare('PRAGMA table_info(rework_requests)').all() as { name: string }[]
      ).map((column) => column.name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'workflow_run_id',
          'branch_run_id',
          'target_node_run_id',
          'trigger_type',
          'trigger_approval_id',
          'test_report_json',
          'round',
          'max_rounds',
          'status',
          'rework_node_run_id',
          'created_by',
        ]),
      )

      const insert = db.prepare(
        `INSERT INTO rework_requests (id, workflow_run_id, target_node_run_id, trigger_type,
           trigger_approval_id, round, max_rounds, status, created_by, created_at, updated_at)
         VALUES (?, 'run-1', 'node-task', 'request_changes', 'apv-1', ?, 2, 'requested', 'approval', ?, ?)`,
      )
      insert.run('rw-1', 1, NOW, NOW)
      expect(() => insert.run('rw-2', 1, NOW, NOW)).toThrow(/UNIQUE constraint failed/)
      insert.run('rw-2', 2, NOW, NOW)

      expect(() =>
        db
          .prepare(
            `INSERT INTO rework_requests (id, workflow_run_id, target_node_run_id, trigger_type,
               round, max_rounds, status, created_by, created_at, updated_at)
             VALUES ('rw-orphan', 'run-1', 'node-missing', 'test_failure', 1, 2, 'requested', 'system', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/FOREIGN KEY constraint failed/)

      expect(() =>
        db
          .prepare(
            `INSERT INTO rework_requests (id, workflow_run_id, target_node_run_id, trigger_type,
               round, max_rounds, status, created_by, created_at, updated_at)
             VALUES ('rw-bad', 'run-1', 'node-task', 'nope', 3, 2, 'requested', 'system', ?, ?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/CHECK constraint failed/)

      // v14：artifacts + artifact_versions（版本不可覆盖）
      const artifactColumns = (
        db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]
      ).map((column) => column.name)
      expect(artifactColumns).toEqual(
        expect.arrayContaining([
          'work_id',
          'node_run_id',
          'assignment_id',
          'artifact_type',
          'name',
          'storage_path',
          'mime_type',
          'created_by_type',
        ]),
      )
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, work_id, artifact_type, name, storage_path, created_by_type, created_at)
             VALUES ('art-x', 'work-1', 'markdown', 'PRD', '/tmp/a', 'system', ?)`,
          )
          .run(NOW),
      ).not.toThrow()
      db.prepare(
        `INSERT INTO artifact_versions (id, artifact_id, version, storage_path, checksum, created_at)
         VALUES ('artv-x', 'art-x', 1, '/tmp/a', 'sum', ?)`,
      ).run(NOW)
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifact_versions (id, artifact_id, version, storage_path, checksum, created_at)
             VALUES ('artv-x2', 'art-x', 1, '/tmp/a2', 'sum', ?)`,
          )
          .run(NOW),
      ).toThrow(/UNIQUE constraint failed/)
      expect(() =>
        db.prepare("UPDATE artifact_versions SET checksum = 'x' WHERE id = 'artv-x'").run(),
      ).toThrow(/immutable/)
      expect(() => db.prepare("DELETE FROM artifact_versions WHERE id = 'artv-x'").run()).toThrow(
        /cannot be deleted/,
      )

      // v15：backups 表（失败态必须可表达）
      const backupColumns = (
        db.prepare('PRAGMA table_info(backups)').all() as { name: string }[]
      ).map((column) => column.name)
      expect(backupColumns).toEqual(
        expect.arrayContaining([
          'type',
          'manifest_version',
          'db_sha256',
          'artifact_files_json',
          'file_count',
          'status',
          'storage_path',
          'error_json',
          'created_at',
          'completed_at',
          'verified_at',
        ]),
      )
      expect(() =>
        db
          .prepare(
            `INSERT INTO backups (id, type, status, storage_path, created_at)
             VALUES ('bak-x', 'manual', 'failed', '/tmp/b', ?)`,
          )
          .run(NOW),
      ).not.toThrow()
      expect(() =>
        db
          .prepare(
            `INSERT INTO backups (id, type, status, storage_path, created_at)
             VALUES ('bak-bad', 'manual', 'nope', '/tmp/b', ?)`,
          )
          .run(NOW),
      ).toThrow(/CHECK constraint failed/)

      // v13：workflow_events 的 event_id 唯一 + FK
      db.prepare(
        `INSERT INTO workflow_events (id, event_id, workflow_run_id, event_type, payload_json, occurred_at)
         VALUES ('evt-1', 'run-1:workflow.completed', 'run-1', 'workflow.completed', '{}', ?)`,
      ).run(NOW)
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_events (id, event_id, workflow_run_id, event_type, payload_json, occurred_at)
             VALUES ('evt-2', 'run-1:workflow.completed', 'run-1', 'workflow.completed', '{}', ?)`,
          )
          .run(NOW),
      ).toThrow(/UNIQUE constraint failed/)
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_events (id, event_id, workflow_run_id, event_type, payload_json, occurred_at)
             VALUES ('evt-orphan', 'orphan', 'missing-run', 'workflow.completed', '{}', ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY constraint failed/)

      // v12 的核心：approvals.rework_request_id 现在真的受 FK 约束
      expect(() =>
        db
          .prepare("UPDATE approvals SET rework_request_id = 'rw-missing' WHERE id = 'apv-1'")
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/)
      expect(() =>
        db.prepare("UPDATE approvals SET rework_request_id = 'rw-1' WHERE id = 'apv-1'").run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })
})

describe('一致性断言只能在一致性边界调用', () => {
  it('passes after a committed, complete write', () => {
    const db = openMigrated()
    try {
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      transaction(db, () => {
        db.prepare(
          `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
           VALUES ('run-1', 'work-1', ?, 'running', ?, '{}', ?, ?)`,
        ).run(versionId, NOW, NOW, NOW)
      })
      expect(checkWorkflowConsistency(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('sees half-written data inside a transaction — which is exactly why it must not be called there', () => {
    const db = openMigrated()
    try {
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      let sawIssueInsideTransaction = false

      expect(() =>
        transaction(db, () => {
          // 事务中间态：run 已写成 running，但 started_at 还没写
          db.prepare(
            `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
             VALUES ('run-mid', 'work-1', ?, 'running', NULL, '{}', ?, ?)`,
          ).run(versionId, NOW, NOW)
          const issues = checkWorkflowConsistency(db)
          sawIssueInsideTransaction = issues.some(
            (issue) => issue.code === 'run_running_without_started_at',
          )
          throw new Error('rollback on purpose')
        }),
      ).toThrow('rollback on purpose')

      expect(sawIssueInsideTransaction).toBe(true)
      // 回滚后库是干净的：边界之外调用会误报，所以调用点必须受约束
      expect(checkWorkflowConsistency(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('reports a terminal run that still has a non-terminal node', () => {
    const db = openMigrated()
    try {
      insertWork(db)
      const versionId = insertTemplateAndVersion(db)
      db.prepare(
        `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, ended_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-done', 'work-1', ?, 'completed', ?, ?, '{}', ?, ?)`,
      ).run(versionId, NOW, NOW, NOW, NOW)
      db.prepare(
        `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, status, attempt, input_snapshot_json, created_at, updated_at)
         VALUES ('node-open', 'run-done', 'task_1', 'running', 1, '{}', ?, ?)`,
      ).run(NOW, NOW)

      const codes = checkWorkflowConsistency(db).map((issue) => issue.code)
      expect(codes).toContain('terminal_run_with_open_node')
    } finally {
      db.close()
    }
  })
})
