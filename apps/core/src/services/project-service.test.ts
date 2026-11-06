import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ProjectRepository } from '../db/repositories/project-repository'
import { ProjectService } from './project-service'

const NOW = '2026-11-06T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-project-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const service = new ProjectService(new ProjectRepository(db), undefined, () => NOW)
  return { db, service }
}

describe('ProjectService', () => {
  it('creates, lists and updates projects', () => {
    const h = harness()
    try {
      const created = h.service.create({ name: 'Agentra MVP', description: 'local agents' })
      expect(created).toMatchObject({ name: 'Agentra MVP', status: 'active' })
      const listed = h.service.list().projects
      expect(listed.map((project) => project.name)).toEqual(
        expect.arrayContaining(['默认项目', 'Agentra MVP']),
      )
      const updated = h.service.update({ id: created.id, status: 'completed' })
      expect(updated.status).toBe('completed')
      expect(h.service.get(created.id).status).toBe('completed')
    } finally {
      h.db.close()
    }
  })

  it('rejects blank names and unknown projects', () => {
    const h = harness()
    try {
      expect(() => h.service.create({ name: '   ' })).toThrow(/must not be blank/)
      expect(() => h.service.get('prj-missing')).toThrow(/not found/)
    } finally {
      h.db.close()
    }
  })
})
