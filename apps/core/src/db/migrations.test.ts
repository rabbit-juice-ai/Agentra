import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, transaction } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const dirs: string[] = []

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-db-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tableNames(file: string): string[] {
  const db = openDatabase(file)
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

describe('migrate', () => {
  it('creates the phase 1 schema on a fresh database', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      expect(currentUserVersion(db)).toBe(0)
      const result = migrate(db)
      expect(result).toEqual({
        from: 0,
        to: 12,
        applied: [
          'phase1_agent_runtime',
          'phase1_tool_permissions_and_provider_auth',
          'phase2_team_work_assignment',
          'phase2_worktree_and_workdir_locks',
          'phase2_workdir_lock_boot_id',
          'phase3_workflow_templates_and_versions',
          'phase3_execution_queue_index',
          'phase2_workdir_lock_boot_uuid',
          'phase4_workflow_runtime',
          'phase4_execution_node_run_fk',
          'phase4_approvals',
          'phase4_rework_requests',
        ],
      })
      expect(currentUserVersion(db)).toBe(12)
    } finally {
      db.close()
    }
    expect(tableNames(file)).toEqual(
      expect.arrayContaining([
        'agent_profiles',
        'agent_runtime_bindings',
        'agent_sessions',
        'assignments',
        'audit_logs',
        'execution_logs',
        'executions',
        'runtime_providers',
        'team_members',
        'teams',
        'work_teams',
        'works',
        'workflow_templates',
        'workflow_versions',
      ]),
    )
  })

  it('is idempotent when run repeatedly', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db)
      const second = migrate(db)
      expect(second).toEqual({ from: 12, to: 12, applied: [] })
      const third = migrate(db, MIGRATIONS)
      expect(third.applied).toEqual([])
      expect(currentUserVersion(db)).toBe(12)
    } finally {
      db.close()
    }
  })

  it('persists user_version across reopen (WAL)', () => {
    const file = tempDb()
    const first = openDatabase(file)
    migrate(first)
    first.close()

    const second = openDatabase(file)
    try {
      expect(currentUserVersion(second)).toBe(12)
      const journal = second.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(journal.journal_mode).toBe('wal')
      const fk = second.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
      expect(fk.foreign_keys).toBe(1)
      const busy = second.prepare('PRAGMA busy_timeout').get() as { timeout: number }
      expect(busy.timeout).toBe(5000)
    } finally {
      second.close()
    }
  })

  it('adds tool permissions and provider auth columns with empty-allow defaults (v2)', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db)
      const agentColumns = db
        .prepare("SELECT name, dflt_value FROM pragma_table_info('agent_profiles')")
        .all() as { name: string; dflt_value: string | null }[]
      const toolColumn = agentColumns.find((column) => column.name === 'tool_permissions_json')
      expect(toolColumn).toBeDefined()
      // 既有行不写回填：默认值必须是空 allow，按 U3 即「未配置、拒绝执行」
      expect(JSON.parse(toolColumn?.dflt_value?.replace(/^'|'$/g, '') ?? 'null')).toEqual({
        version: 1,
        allow: [],
        deny: [],
      })

      const providerColumns = (
        db.prepare("SELECT name FROM pragma_table_info('runtime_providers')").all() as {
          name: string
        }[]
      ).map((column) => column.name)
      expect(providerColumns).toContain('auth_method')
      expect(providerColumns).toContain('health_detail')
    } finally {
      db.close()
    }
  })

  it('upgrades a v2 database to v3 without losing existing rows', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      // 先升到 v2，写入阶段 1 数据
      migrate(db, MIGRATIONS.slice(0, 2))
      expect(currentUserVersion(db)).toBe(2)
      db.prepare(
        `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
         VALUES ('claude-code', 'cli', 'Claude Code', '{}', 'healthy', 't0', 't0')`,
      ).run()
      db.prepare(
        `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at)
         VALUES ('agt-1', 'A', 'engineer', '', '', '[]', NULL, 1, 'active', 't0', 't0', NULL)`,
      ).run()
      db.prepare(
        `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
         VALUES ('ses-1', NULL, 'claude-code', 'ext-1', 'agt-1', 'active', 't0', 't0', NULL)`,
      ).run()
      db.prepare(
        `INSERT INTO executions (id, session_id, provider_id, status, working_directory, capabilities_snapshot_json, created_at, updated_at)
         VALUES ('exe-1', 'ses-1', 'claude-code', 'succeeded', '/tmp', '{}', 't0', 't0')`,
      ).run()

      const result = migrate(db)
      expect(result).toEqual({
        from: 2,
        to: 12,
        applied: [
          'phase2_team_work_assignment',
          'phase2_worktree_and_workdir_locks',
          'phase2_workdir_lock_boot_id',
          'phase3_workflow_templates_and_versions',
          'phase3_execution_queue_index',
          'phase2_workdir_lock_boot_uuid',
          'phase4_workflow_runtime',
          'phase4_execution_node_run_fk',
          'phase4_approvals',
          'phase4_rework_requests',
        ],
      })

      // 阶段 1 数据一条不少
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_profiles').get()).toEqual({ c: 1 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get()).toEqual({ c: 1 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toEqual({ c: 1 })
      expect(db.prepare('SELECT id, assignment_id FROM agent_sessions').get()).toEqual({
        id: 'ses-1',
        assignment_id: null,
      })
      expect(db.prepare('SELECT id, session_id FROM executions').get()).toEqual({
        id: 'exe-1',
        session_id: 'ses-1',
      })

      // 外键确实加上了，且全库无违约
      const fks = db.prepare("PRAGMA foreign_key_list('agent_sessions')").all() as {
        from: string
        table: string
      }[]
      expect(fks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'assignment_id', table: 'assignments' }),
        ]),
      )
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      // 重建后开关必须恢复
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })

  it('clears orphan assignment bindings to NULL and writes an audit log (U6)', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db, MIGRATIONS.slice(0, 2))
      db.prepare(
        `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
         VALUES ('claude-code', 'cli', 'Claude Code', '{}', 'healthy', 't0', 't0')`,
      ).run()
      // v2 没有外键，能写进指向不存在 assignment 的孤儿引用
      db.prepare(
        `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
         VALUES ('ses-orphan', 'asg-missing', 'claude-code', NULL, 'agt-1', 'active', 't0', 't0', NULL)`,
      ).run()

      migrate(db)

      expect(
        db.prepare('SELECT assignment_id FROM agent_sessions WHERE id = ?').get('ses-orphan'),
      ).toEqual({ assignment_id: null })
      const audit = db
        .prepare("SELECT * FROM audit_logs WHERE action = 'agent_session.assignment_orphaned'")
        .all() as {
        actor_type: string
        target_type: string
        target_id: string
        details_json: string
      }[]
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        actor_type: 'system',
        target_type: 'agent_session',
        target_id: 'ses-orphan',
      })
      expect(JSON.parse(audit[0]?.details_json ?? '{}')).toEqual({
        previousAssignmentId: 'asg-missing',
      })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rolls back the table-rebuild migration on failure and restores foreign_keys', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db, MIGRATIONS.slice(0, 2))
      db.prepare(
        `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
         VALUES ('claude-code', 'cli', 'Claude Code', '{}', 'healthy', 't0', 't0')`,
      ).run()
      db.prepare(
        `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
         VALUES ('ses-1', NULL, 'claude-code', NULL, 'agt-1', 'active', 't0', 't0', NULL)`,
      ).run()

      const phase2 = MIGRATIONS[2]
      expect(phase2).toBeDefined()
      const broken = [
        ...MIGRATIONS.slice(0, 2),
        {
          version: 3,
          name: 'phase2_broken',
          rebuildsTables: true,
          up: (handle: typeof db) => {
            phase2?.up(handle)
            throw new Error('boom after rebuild')
          },
        },
      ]
      expect(() => migrate(db, broken)).toThrow('boom after rebuild')

      // 版本没前进
      expect(currentUserVersion(db)).toBe(2)
      // 新表全部回滚
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((row) => row.name)
      for (const table of [
        'teams',
        'team_members',
        'works',
        'work_teams',
        'assignments',
        'audit_logs',
      ]) {
        expect(tables).not.toContain(table)
      }
      // 原表与数据完好，外键仍是 v2 形态
      expect(db.prepare('SELECT id FROM agent_sessions').get()).toEqual({ id: 'ses-1' })
      const fks = db.prepare("PRAGMA foreign_key_list('agent_sessions')").all() as {
        from: string
      }[]
      expect(fks.map((fk) => fk.from)).not.toContain('assignment_id')
      // 失败后外键开关必须恢复
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })

  it('rolls back a failing migration and leaves user_version unchanged', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      const broken = [
        {
          version: 1,
          name: 'broken',
          up: (handle: typeof db) => {
            handle.exec('CREATE TABLE half_done (id TEXT PRIMARY KEY)')
            throw new Error('boom')
          },
        },
      ]
      expect(() => migrate(db, broken)).toThrow('boom')
      expect(currentUserVersion(db)).toBe(0)
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half_done'")
        .all()
      expect(rows).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})

describe('transaction', () => {
  it('commits on success and rolls back on failure', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      db.exec('CREATE TABLE txn_probe (id TEXT PRIMARY KEY)')
      transaction(db, () => {
        db.prepare('INSERT INTO txn_probe (id) VALUES (?)').run('a')
      })
      expect(db.prepare('SELECT COUNT(*) AS c FROM txn_probe').get()).toEqual({ c: 1 })

      expect(() =>
        transaction(db, () => {
          db.prepare('INSERT INTO txn_probe (id) VALUES (?)').run('b')
          throw new Error('rollback me')
        }),
      ).toThrow('rollback me')
      expect(db.prepare('SELECT COUNT(*) AS c FROM txn_probe').get()).toEqual({ c: 1 })
    } finally {
      db.close()
    }
  })
})

describe('migration v8 · workdir lock boot uuid', () => {
  it('adds boot_uuid and preserves existing lock rows', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 7),
      )
      expect(currentUserVersion(db)).toBe(7)
      db.prepare(
        `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, boot_id, acquired_at)
         VALUES ('/tmp/legacy-workdir', 'exe-legacy', NULL, 1, 1793441153, 't0')`,
      ).run()

      const result = migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 8),
      )
      expect(result).toEqual({
        from: 7,
        to: 8,
        applied: ['phase2_workdir_lock_boot_uuid'],
      })

      const columns = (
        db.prepare('PRAGMA table_info(workdir_locks)').all() as { name: string }[]
      ).map((column) => column.name)
      expect(columns).toContain('boot_uuid')

      expect(
        db
          .prepare(
            `SELECT workdir, execution_id, boot_id, boot_uuid
             FROM workdir_locks WHERE workdir = '/tmp/legacy-workdir'`,
          )
          .get(),
      ).toEqual({
        workdir: '/tmp/legacy-workdir',
        execution_id: 'exe-legacy',
        boot_id: 1793441153,
        boot_uuid: null,
      })
    } finally {
      db.close()
    }
  })
})
