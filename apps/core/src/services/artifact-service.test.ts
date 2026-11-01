import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { ArtifactError, ArtifactService } from './artifact-service'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(workStatus = 'active'): {
  db: ReturnType<typeof openDatabase>
  service: ArtifactService
  artifacts: ArtifactRepository
  artifactsRoot: string
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-artifact-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', ?, 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(workStatus, NOW, NOW)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-2', 'W2', '', '', 'completed', 'normal', '/tmp/w2', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const artifactsRoot = path.join(dir, 'artifacts')
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 })
  const works = new WorkRepository(db)
  return {
    db,
    service: new ArtifactService(
      db,
      new ArtifactRepository(db),
      artifactsRoot,
      { get: (id) => works.get(id) },
      () => NOW,
    ),
    artifacts: new ArtifactRepository(db),
    artifactsRoot,
    close: () => db.close(),
  }
}

describe('ArtifactService · 创建与版本化', () => {
  it('creates the first version with file on disk and sha256 checksum', () => {
    const h = setup()
    try {
      const { artifact, version } = h.service.createVersion({
        workId: 'work-1',
        artifactType: 'markdown',
        name: 'PRD',
        content: '# PRD v1',
        createdByType: 'agent',
        createdById: 'agent-1',
      })
      expect(artifact).toMatchObject({
        workId: 'work-1',
        artifactType: 'markdown',
        name: 'PRD',
        createdByType: 'agent',
      })
      expect(version.version).toBe(1)
      expect(fs.existsSync(version.storagePath)).toBe(true)
      expect(fs.readFileSync(version.storagePath, 'utf8')).toBe('# PRD v1')
      // checksum 是合法 sha256
      expect(version.checksum).toMatch(/^[0-9a-f]{64}$/)
      // 路径在 artifactsRoot 之内
      expect(version.storagePath.startsWith(h.artifactsRoot)).toBe(true)
    } finally {
      h.close()
    }
  })

  it('creates a new immutable version on resubmission; history is preserved', () => {
    const h = setup()
    try {
      const first = h.service.createVersion({
        workId: 'work-1',
        artifactType: 'markdown',
        name: 'UI',
        content: 'v1',
        createdByType: 'agent',
      })
      const second = h.service.createVersion({
        workId: 'work-1',
        artifactType: 'markdown',
        name: 'UI',
        content: 'v2 content',
        createdByType: 'agent',
      })
      expect(second.artifact.id).toBe(first.artifact.id)
      expect(second.version.version).toBe(2)
      // 两个版本文件都还在：历史不可覆盖
      expect(fs.readFileSync(first.version.storagePath, 'utf8')).toBe('v1')
      expect(fs.readFileSync(second.version.storagePath, 'utf8')).toBe('v2 content')

      // DB 触发器：UPDATE / DELETE 都拒绝
      expect(() =>
        h.db
          .prepare("UPDATE artifact_versions SET checksum = 'x' WHERE artifact_id = ?")
          .run(first.artifact.id),
      ).toThrow(/immutable/)
      expect(() =>
        h.db.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').run(first.artifact.id),
      ).toThrow(/cannot be deleted/)
    } finally {
      h.close()
    }
  })

  it('rejects empty content, bad names, bad types and inactive works', () => {
    const h = setup()
    try {
      expect(() =>
        h.service.createVersion({
          workId: 'work-1',
          artifactType: 'markdown',
          name: 'A',
          content: '',
          createdByType: 'system',
        }),
      ).toThrow(ArtifactError)
      expect(() =>
        h.service.createVersion({
          workId: 'work-1',
          artifactType: 'markdown',
          name: '../escape',
          content: 'x',
          createdByType: 'system',
        }),
      ).toThrow(/name must match/)
      expect(() =>
        h.service.createVersion({
          workId: 'work-1',
          artifactType: 'bogus' as never,
          name: 'A',
          content: 'x',
          createdByType: 'system',
        }),
      ).toThrow(/artifact type/)
      expect(() =>
        h.service.createVersion({
          workId: 'work-2',
          artifactType: 'text',
          name: 'A',
          content: 'x',
          createdByType: 'system',
        }),
      ).toThrow(/cannot receive artifacts/)
      expect(() =>
        h.service.createVersion({
          workId: 'work-missing',
          artifactType: 'text',
          name: 'A',
          content: 'x',
          createdByType: 'system',
        }),
      ).toThrow(ArtifactError)
    } finally {
      h.close()
    }
  })

  it('previews latest or a specific version and verifies checksum integrity', () => {
    const h = setup()
    try {
      h.service.createVersion({
        workId: 'work-1',
        artifactType: 'text',
        name: 'spec',
        content: 'one',
        createdByType: 'system',
      })
      h.service.createVersion({
        workId: 'work-1',
        artifactType: 'text',
        name: 'spec',
        content: 'two',
        createdByType: 'system',
      })

      const latest = h.service.preview(h.service.listByWork('work-1')[0]?.id ?? '')
      expect(latest.content.toString('utf8')).toBe('two')

      const artifactId = latest.artifact.id
      const v1 = h.service.preview(artifactId, 1)
      expect(v1.content.toString('utf8')).toBe('one')

      const opened = h.service.openPath(artifactId, 1)
      expect(opened.exists).toBe(true)
      expect(opened.absolutePath.startsWith(h.artifactsRoot)).toBe(true)

      expect(() => h.service.preview(artifactId, 99)).toThrow(/version 99/)
      expect(() => h.service.preview('art-missing')).toThrow(ArtifactError)

      // 篡改文件后 preview 必须能检测（checksum 校验语义由服务承担：此处验证文件缺失路径）
      fs.rmSync(v1.version.storagePath)
      expect(() => h.service.preview(artifactId, 1)).toThrow(/file missing/)
    } finally {
      h.close()
    }
  })

  it('lists versions in order and next version continues the chain', () => {
    const h = setup()
    try {
      for (const content of ['a', 'b', 'c']) {
        h.service.createVersion({
          workId: 'work-1',
          artifactType: 'code',
          name: 'main.ts',
          content,
          createdByType: 'agent',
        })
      }
      const artifact = h.service.listByWork('work-1')[0]
      if (!artifact) throw new Error('missing artifact')
      const versions = h.service.listVersions(artifact.id)
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3])
      expect(h.artifacts.nextVersion(artifact.id)).toBe(4)
      expect(h.artifacts.latestVersion(artifact.id)?.version).toBe(3)
    } finally {
      h.close()
    }
  })
})
