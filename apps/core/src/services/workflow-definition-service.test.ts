import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowDefinitionError, WorkflowDefinitionService } from './workflow-definition-service'

const dirs: string[] = []

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-workflow-svc-'))
  dirs.push(dir)
  return path.join(dir, 'agentra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function definition(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      nodes: [
        { key: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          key: 'task',
          type: 'agent_task',
          position: { x: 0, y: 1 },
          config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'do it' },
        },
        { key: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'task' },
        { key: 'e2', source: 'task', target: 'end' },
      ],
    }),
  ) as Record<string, unknown>
}

function nodeAt(definition: Record<string, unknown>, index: number): Record<string, unknown> {
  const nodes = definition.nodes as Record<string, unknown>[]
  const node = nodes[index]
  if (!node) throw new Error(`missing node at ${index}`)
  return node
}

function setup(): {
  db: Database
  repo: WorkflowRepository
  service: WorkflowDefinitionService
} {
  const db = openDatabase(tempDb())
  migrate(db)
  const repo = new WorkflowRepository(db)
  let tick = 0
  const service = new WorkflowDefinitionService(
    db,
    repo,
    () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  )
  return { db, repo, service }
}

function expectError(fn: () => unknown, code: string): WorkflowDefinitionError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDefinitionError)
    const typed = error as WorkflowDefinitionError
    expect(typed.code).toBe(code)
    return typed
  }
  throw new Error(`expected WorkflowDefinitionError(${code})`)
}

describe('WorkflowDefinitionService · 模板与 draft', () => {
  it('creates a template and a draft with a canonical checksum', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: '研发流程', description: 'demo' })
    const draft = service.createDraft(template.id, definition())

    expect(draft.version).toBe(1)
    expect(draft.status).toBe('draft')
    expect(draft.publishedAt).toBeNull()
    expect(draft.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(draft.schemaVersion).toBe(1)
  })

  it('increments version numbers and keeps checksums stable across array order', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const first = service.createDraft(template.id, definition())

    const reordered = definition()
    reordered.nodes = [...(reordered.nodes as unknown[])].reverse()
    reordered.edges = [...(reordered.edges as unknown[])].reverse()
    const second = service.createDraft(template.id, reordered)

    expect(second.version).toBe(2)
    expect(second.checksum).toBe(first.checksum)
  })

  it('rejects an invalid definition with violations', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const invalid = definition()
    invalid.nodes = (invalid.nodes as Record<string, unknown>[]).filter(
      (node) => node.type !== 'start',
    )

    const error = expectError(() => service.createDraft(template.id, invalid), 'INVALID_DEFINITION')
    expect(error.violations.map((item) => item.violation)).toContain('start_invalid')
    expect(error.violations.length).toBeGreaterThan(0)
  })

  it('returns UNKNOWN_NODE_TYPE as an error code without violations', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const invalid = definition()
    nodeAt(invalid, 1).type = 'retry_loop'

    const error = expectError(() => service.createDraft(template.id, invalid), 'UNKNOWN_NODE_TYPE')
    expect(error.violations).toEqual([])
  })

  it('maps a unique-version collision to VERSION_CONFLICT (替身仓库)', () => {
    const { db, repo, service } = setup()
    const template = service.createTemplate({ name: 't' })

    const conflicting = Object.create(repo) as WorkflowRepository
    conflicting.insertVersion = () => {
      const error = new Error(
        'UNIQUE constraint failed: workflow_versions.template_id, workflow_versions.version',
      ) as Error & { errcode?: number }
      error.errcode = 2067
      throw error
    }
    const serviceWithConflict = new WorkflowDefinitionService(db, conflicting)

    const error = expectError(
      () => serviceWithConflict.createDraft(template.id, definition()),
      'VERSION_CONFLICT',
    )
    expect(error.violations[0]?.violation).toBe('version_conflict')
    expect(repo.listVersions(template.id).versions).toHaveLength(0)
  })

  it('preserves fractional node positions exactly through save and read-back (F-1)', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const def = definition()
    const nodes = def.nodes as Record<string, unknown>[]
    const task = nodes[1]
    if (!task) throw new Error('missing task node')
    task.position = { x: 10.4, y: -3.25 }

    const draft = service.createDraft(template.id, def)
    const loaded = service.getVersion(draft.id)
    const loadedNodes = (loaded.definition as { nodes: { position: { x: number; y: number } }[] })
      .nodes
    expect(loadedNodes[1]?.position).toEqual({ x: 10.4, y: -3.25 })
  })

  it('skips unreadable version rows instead of failing the whole list (F-3)', () => {
    const { db, repo, service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())

    db.prepare(
      `INSERT INTO workflow_versions (
         id, template_id, version, schema_version, definition_json, checksum, status,
         created_at, published_at
       ) VALUES ('wfv-bad', ?, 2, 0, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'x', 'draft', 't0', NULL)`,
    ).run(template.id)

    const result = repo.listVersions(template.id)
    expect(result.versions.map((version) => version.id)).toEqual([draft.id])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.id).toBe('wfv-bad')
    expect(result.skipped[0]?.reason).toContain('schema_version')
  })

  it('enforces unique(template_id, version) at the database level', () => {
    const { repo, service } = setup()
    const template = service.createTemplate({ name: 't' })
    repo.insertVersion(
      {
        id: 'wfv-manual',
        templateId: template.id,
        version: 1,
        schemaVersion: 1,
        definitionJson: JSON.stringify(definition()),
        checksum: 'x',
      },
      't0',
    )
    expect(() =>
      repo.insertVersion(
        {
          id: 'wfv-duplicate',
          templateId: template.id,
          version: 1,
          schemaVersion: 1,
          definitionJson: JSON.stringify(definition()),
          checksum: 'x',
        },
        't0',
      ),
    ).toThrow(/UNIQUE constraint failed/)
  })
})

describe('WorkflowDefinitionService · 发布', () => {
  it('publishes a draft and sets published_at', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    const published = service.publish(draft.id)

    expect(published.status).toBe('published')
    expect(published.publishedAt).not.toBeNull()
  })

  it('fails a second publish with cas_failed', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    service.publish(draft.id)

    const error = expectError(() => service.publish(draft.id), 'CAS_FAILED')
    expect(error.violations[0]?.violation).toBe('cas_failed')
  })

  it('rejects a tampered definition (checksum mismatch)', () => {
    const { db, service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())

    const tampered = definition()
    ;(nodeAt(tampered, 1).config as Record<string, unknown>).taskPrompt = 'tampered'
    db.prepare('UPDATE workflow_versions SET definition_json = ? WHERE id = ?').run(
      JSON.stringify(tampered),
      draft.id,
    )

    expectError(() => service.publish(draft.id), 'INVALID_DEFINITION')
  })

  it('re-validates the stored definition inside publish (violations surface)', () => {
    const { db, service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())

    const invalid = definition()
    invalid.nodes = (invalid.nodes as Record<string, unknown>[]).filter(
      (node) => node.type !== 'end',
    )
    db.prepare('UPDATE workflow_versions SET definition_json = ? WHERE id = ?').run(
      JSON.stringify(invalid),
      draft.id,
    )

    const error = expectError(() => service.publish(draft.id), 'INVALID_DEFINITION')
    expect(error.violations.map((item) => item.violation)).toContain('end_invalid')
  })

  it('publishes immutable rows and refuses later mutation', () => {
    const { db, service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    service.publish(draft.id)

    expect(() =>
      db.prepare("UPDATE workflow_versions SET checksum = 'other' WHERE id = ?").run(draft.id),
    ).toThrow(/immutable/)
  })

  it('deprecates a published version', () => {
    const { service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    service.publish(draft.id)
    const deprecated = service.deprecate(draft.id)
    expect(deprecated.status).toBe('deprecated')
  })
})

describe('阶段 3 边界', () => {
  it('definition operations never create workflow run rows (阶段 4 v9 只建表)', () => {
    const { db, service } = setup()
    const template = service.createTemplate({ name: 't' })
    const draft = service.createDraft(template.id, definition())
    service.publish(draft.id)
    service.deprecate(draft.id)

    // 阶段 4 的 v9/v11 会建运行表与审批表；但定义层操作不得写入任何运行记录。
    for (const table of ['workflow_runs', 'branch_runs', 'node_runs', 'approvals']) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      expect(row.count).toBe(0)
    }
  })
})
