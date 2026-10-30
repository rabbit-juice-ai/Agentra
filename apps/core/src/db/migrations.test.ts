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
        to: 2,
        applied: ['phase1_agent_runtime', 'phase1_tool_permissions_and_provider_auth'],
      })
      expect(currentUserVersion(db)).toBe(2)
    } finally {
      db.close()
    }
    expect(tableNames(file)).toEqual(
      expect.arrayContaining([
        'agent_profiles',
        'agent_runtime_bindings',
        'agent_sessions',
        'execution_logs',
        'executions',
        'runtime_providers',
      ]),
    )
  })

  it('is idempotent when run repeatedly', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      migrate(db)
      const second = migrate(db)
      expect(second).toEqual({ from: 2, to: 2, applied: [] })
      const third = migrate(db, MIGRATIONS)
      expect(third.applied).toEqual([])
      expect(currentUserVersion(db)).toBe(2)
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
      expect(currentUserVersion(second)).toBe(2)
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
