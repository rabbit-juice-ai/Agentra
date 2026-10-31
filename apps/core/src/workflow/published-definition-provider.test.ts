import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import {
  PublishedDefinitionProvider,
  WorkflowDefinitionLoadError,
} from './published-definition-provider'

const dirs: string[] = []

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

function setup(): {
  db: ReturnType<typeof openDatabase>
  repo: WorkflowRepository
  service: WorkflowDefinitionService
  provider: PublishedDefinitionProvider
  templateId: string
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-def-provider-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const repo = new WorkflowRepository(db)
  const service = new WorkflowDefinitionService(db, repo, () => '2026-11-01T00:00:00.000Z')
  const provider = new PublishedDefinitionProvider(repo)
  const template = service.createTemplate({ name: 't' })
  return { db, repo, service, provider, templateId: template.id, close: () => db.close() }
}

describe('PublishedDefinitionProvider', () => {
  it('loads a published version and caches by versionId', () => {
    const { service, provider, templateId, close } = setup()
    try {
      const draft = service.createDraft(templateId, definition())
      const published = service.publish(draft.id)

      const loaded = provider.get(published.id)
      expect(loaded.status).toBe('published')
      expect(loaded.version).toBe(1)
      expect(loaded.schemaVersion).toBe(1)
      expect(loaded.checksum).toBe(published.checksum)
      expect(loaded.definition.nodes.map((node) => node.key)).toEqual(['start', 'task', 'end'])

      // 定义不可变 ⇒ 缓存返回同一对象
      expect(provider.get(published.id)).toBe(loaded)
    } finally {
      close()
    }
  })

  it('still reads a deprecated version (historical runs must keep working)', () => {
    const { service, provider, templateId, close } = setup()
    try {
      const draft = service.createDraft(templateId, definition())
      service.publish(draft.id)
      service.deprecate(draft.id)

      const loaded = provider.get(draft.id)
      expect(loaded.status).toBe('deprecated')
    } finally {
      close()
    }
  })

  it('refuses a draft version with VERSION_NOT_READABLE', () => {
    const { service, provider, templateId, close } = setup()
    try {
      const draft = service.createDraft(templateId, definition())
      expect(() => provider.get(draft.id)).toThrow(WorkflowDefinitionLoadError)
      try {
        provider.get(draft.id)
      } catch (error) {
        expect((error as WorkflowDefinitionLoadError).code).toBe('VERSION_NOT_READABLE')
      }
    } finally {
      close()
    }
  })

  it('refuses a missing version with VERSION_NOT_FOUND', () => {
    const { provider, close } = setup()
    try {
      try {
        provider.get('wfv-missing')
        throw new Error('expected a load error')
      } catch (error) {
        expect((error as WorkflowDefinitionLoadError).code).toBe('VERSION_NOT_FOUND')
      }
    } finally {
      close()
    }
  })

  it('refuses a published version whose stored checksum does not match (negative case)', () => {
    const { db, provider, templateId, close } = setup()
    try {
      db.prepare(
        `INSERT INTO workflow_versions (
           id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at
         ) VALUES ('wfv-tampered', ?, 7, 1, ?, 'deadbeef', 'published', 't0', 't0')`,
      ).run(templateId, JSON.stringify(definition()))

      try {
        provider.get('wfv-tampered')
        throw new Error('expected a checksum error')
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowDefinitionLoadError)
        expect((error as WorkflowDefinitionLoadError).code).toBe('CHECKSUM_MISMATCH')
      }
    } finally {
      close()
    }
  })

  it('refuses a published row whose definition no longer parses', () => {
    const { db, provider, templateId, close } = setup()
    try {
      db.prepare(
        `INSERT INTO workflow_versions (
           id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at
         ) VALUES ('wfv-broken', ?, 8, 1, '{"schemaVersion":1}', 'x', 'published', 't0', 't0')`,
      ).run(templateId)

      try {
        provider.get('wfv-broken')
        throw new Error('expected a definition error')
      } catch (error) {
        expect((error as WorkflowDefinitionLoadError).code).toBe('DEFINITION_INVALID')
      }
    } finally {
      close()
    }
  })
})
