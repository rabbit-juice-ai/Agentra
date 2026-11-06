import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { currentUserVersion, MIGRATIONS, migrate } from './migrations'

const dirs: string[] = []

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-workflow-db-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function insertTemplate(db: ReturnType<typeof openDatabase>, id = 'wft-1'): void {
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES (?, 'Template', '', '', 't0', 't0', NULL)`,
  ).run(id)
}

function insertVersion(
  db: ReturnType<typeof openDatabase>,
  input: { id: string; templateId?: string; version: number; status?: string },
): void {
  db.prepare(
    `INSERT INTO workflow_versions (
       id, template_id, version, schema_version, definition_json, checksum,
       status, created_at, published_at
     ) VALUES (?, ?, ?, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'checksum', ?, 't0', NULL)`,
  ).run(input.id, input.templateId ?? 'wft-1', input.version, input.status ?? 'draft')
}

describe('migration v6 · workflow templates and versions', () => {
  it('creates the tables, indexes and triggers', () => {
    const file = tempDb()
    const db = openDatabase(file)
    try {
      const result = migrate(db)
      expect(result.to).toBe(22)
      expect(currentUserVersion(db)).toBe(22)

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(tables).toEqual(expect.arrayContaining(['workflow_templates', 'workflow_versions']))

      const triggers = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(triggers).toEqual(
        expect.arrayContaining([
          'trg_workflow_versions_immutable',
          'trg_workflow_versions_no_delete',
        ]),
      )

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_workflow_versions_template_status',
          'idx_workflow_versions_checksum',
          'idx_executions_pending_created',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('enforces unique(template_id, version)', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-1', version: 1 })
      expect(() => insertVersion(db, { id: 'wfv-1b', version: 1 })).toThrow(
        /UNIQUE constraint failed/,
      )
      insertVersion(db, { id: 'wfv-2', version: 2, templateId: 'wft-1' })
    } finally {
      db.close()
    }
  })

  it('rejects updates to a published version definition / checksum / schema_version', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-1', version: 1, status: 'published' })

      expect(() =>
        db.prepare("UPDATE workflow_versions SET definition_json = '{}' WHERE id = 'wfv-1'").run(),
      ).toThrow(/immutable/)
      expect(() =>
        db.prepare("UPDATE workflow_versions SET checksum = 'other' WHERE id = 'wfv-1'").run(),
      ).toThrow(/immutable/)
      expect(() =>
        db.prepare("UPDATE workflow_versions SET schema_version = 2 WHERE id = 'wfv-1'").run(),
      ).toThrow(/immutable/)

      // status 迁移不受触发器保护，仍可 published → deprecated
      expect(() =>
        db.prepare("UPDATE workflow_versions SET status = 'deprecated' WHERE id = 'wfv-1'").run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('allows editing draft rows', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-1', version: 1 })
      expect(() =>
        db.prepare("UPDATE workflow_versions SET checksum = 'other' WHERE id = 'wfv-1'").run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('protects deprecated rows from mutation and deletion', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-dep', version: 1, status: 'deprecated' })

      expect(() =>
        db
          .prepare(
            "UPDATE workflow_versions SET definition_json = '{\"X\":9}' WHERE id = 'wfv-dep'",
          )
          .run(),
      ).toThrow(/immutable/)
      expect(() =>
        db.prepare("UPDATE workflow_versions SET checksum = 'other' WHERE id = 'wfv-dep'").run(),
      ).toThrow(/immutable/)
      expect(() =>
        db.prepare("UPDATE workflow_versions SET schema_version = 2 WHERE id = 'wfv-dep'").run(),
      ).toThrow(/immutable/)
      expect(() => db.prepare("DELETE FROM workflow_versions WHERE id = 'wfv-dep'").run()).toThrow(
        /cannot be deleted/,
      )

      const row = db
        .prepare("SELECT definition_json, checksum FROM workflow_versions WHERE id = 'wfv-dep'")
        .get() as { definition_json: string; checksum: string }
      expect(row.checksum).toBe('checksum')
      expect(row.definition_json).toBe('{"schemaVersion":1,"nodes":[],"edges":[]}')
    } finally {
      db.close()
    }
  })

  it('allows published → deprecated even though deprecated rows are immutable', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-pub', version: 1, status: 'published' })
      expect(() =>
        db.prepare("UPDATE workflow_versions SET status = 'deprecated' WHERE id = 'wfv-pub'").run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('refuses to delete a published version', () => {
    const db = openDatabase(tempDb())
    try {
      migrate(db)
      insertTemplate(db)
      insertVersion(db, { id: 'wfv-1', version: 1, status: 'published' })
      expect(() => db.prepare("DELETE FROM workflow_versions WHERE id = 'wfv-1'").run()).toThrow(
        /cannot be deleted/,
      )
    } finally {
      db.close()
    }
  })
})

describe('migration v7 · execution queue index', () => {
  it('upgrades a v5 database without losing data', () => {
    const db = openDatabase(tempDb())
    try {
      const upToV5 = MIGRATIONS.filter((migration) => migration.version <= 5)
      migrate(db, upToV5)
      expect(currentUserVersion(db)).toBe(5)

      db.prepare(
        `INSERT INTO works (id, name, description, objective, status, priority, root_path, repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', 't0', 't0', NULL)`,
      ).run()

      const result = migrate(db)
      expect(result).toEqual({
        from: 5,
        to: 22,
        applied: [
          'phase3_workflow_templates_and_versions',
          'phase3_execution_queue_index',
          'phase2_workdir_lock_boot_uuid',
          'phase4_workflow_runtime',
          'phase4_execution_node_run_fk',
          'phase4_approvals',
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
        ],
      })
      const works = db.prepare("SELECT id FROM works WHERE id = 'work-1'").all()
      expect(works).toHaveLength(1)

      const indexSql = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_executions_pending_created'",
        )
        .get() as { sql: string } | undefined
      expect(indexSql?.sql).toMatch(/WHERE status = 'pending'/)
    } finally {
      db.close()
    }
  })
})
