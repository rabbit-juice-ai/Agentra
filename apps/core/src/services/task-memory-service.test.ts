import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { currentUserVersion, MIGRATIONS, migrate } from '../db/migrations'
import { AuditRepository } from '../db/repositories/audit-repository'
import { ProjectRepository } from '../db/repositories/project-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { TaskMemoryService } from './task-memory-service'
import { WorkService } from './work-service'

const NOW = '2026-11-08T10:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-task-memory-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const workRepository = new WorkRepository(db)
  const audit = new AuditRepository(db)
  const projects = new ProjectRepository(db)
  const memories = new TaskMemoryRepository(db)
  const taskMemoryService = new TaskMemoryService({
    db,
    memories,
    audit,
    now: () => NOW,
  })
  const workService = new WorkService(
    db,
    workRepository,
    new TeamRepository(db),
    audit,
    () => NOW,
    undefined,
    projects,
    taskMemoryService,
  )
  return { db, workRepository, audit, projects, memories, taskMemoryService, workService }
}

describe('Phase 1A task memory and acceptance criteria', () => {
  it('persists Work acceptance criteria and seeds Task Memory', () => {
    const h = harness()
    const work = h.workService.create({
      name: '实现备份',
      objective: '最小闭环',
      rootPath: '/tmp/agentra-phase1a',
      acceptanceCriteria: ['备份成功', '恢复预检通过'],
    })
    expect(work.acceptanceCriteria).toEqual(['备份成功', '恢复预检通过'])
    expect(work.acceptanceCriteriaVersion).toBe(1)
    expect(work.acceptanceCriteriaUpdatedAt).toBe(NOW)
    expect(work.projectId).toBe('prj-default')

    const memory = h.taskMemoryService.get(work.id)
    expect(memory?.acceptanceCriteria.workVersion).toBe(1)
    expect(memory?.acceptanceCriteria.items.map((item) => item.statement)).toEqual([
      '备份成功',
      '恢复预检通过',
    ])
    expect(memory?.acceptanceCriteria.items.every((item) => item.verification === 'verified')).toBe(
      true,
    )
  })

  it('increments the version, refreshes the snapshot, and audits only real changes', () => {
    const h = harness()
    const work = h.workService.create({
      name: '版本测试',
      rootPath: '/tmp/agentra-phase1a-version',
      acceptanceCriteria: ['旧标准'],
    })
    const updated = h.workService.updateAcceptanceCriteria(work.id, ['新标准', '补充标准'], {
      actorType: 'user',
      actorId: 'local-user',
      source: 'test',
    })
    expect(updated.acceptanceCriteriaVersion).toBe(2)
    expect(updated.acceptanceCriteria).toEqual(['新标准', '补充标准'])
    expect(h.taskMemoryService.get(work.id)?.acceptanceCriteria.workVersion).toBe(2)
    expect(
      h.taskMemoryService.get(work.id)?.acceptanceCriteria.items.map((item) => item.statement),
    ).toEqual(['新标准', '补充标准'])

    const auditRows = h.db
      .prepare(
        "SELECT action, details_json FROM audit_logs WHERE action = 'work.acceptance_criteria_changed'",
      )
      .all() as { action: string; details_json: string }[]
    expect(auditRows).toHaveLength(1)
    expect(JSON.parse(auditRows[0]?.details_json ?? '{}')).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      source: 'test',
      at: NOW,
      toCriteria: ['新标准', '补充标准'],
    })

    const unchanged = h.workService.updateAcceptanceCriteria(work.id, ['新标准', '补充标准'])
    expect(unchanged.acceptanceCriteriaVersion).toBe(2)
    const auditCount = h.db
      .prepare(
        "SELECT count(*) AS c FROM audit_logs WHERE action = 'work.acceptance_criteria_changed'",
      )
      .get() as { c: number }
    expect(auditCount.c).toBe(1)
  })

  it('refreshes stale Task Memory before an execution and preserves newer snapshots', () => {
    const h = harness()
    const work = h.workService.create({
      name: '刷新测试',
      rootPath: '/tmp/agentra-phase1a-refresh',
      acceptanceCriteria: ['v1'],
    })
    const nextVersion = work.acceptanceCriteriaVersion + 1
    expect(
      h.workRepository.updateAcceptanceCriteria(
        work.id,
        work.acceptanceCriteriaVersion,
        ['v2'],
        nextVersion,
        NOW,
        NOW,
      ),
    ).toBe(true)
    const refreshed = h.taskMemoryService.refreshForWork(
      h.workService.get(work.id),
      'execution_start',
    )
    expect(refreshed.acceptanceCriteria.workVersion).toBe(2)
    expect(refreshed.acceptanceCriteria.items[0]?.statement).toBe('v2')
    const refreshAudit = h.db
      .prepare(
        "SELECT details_json FROM audit_logs WHERE action = 'task_memory.acceptance_snapshot_refreshed'",
      )
      .get() as { details_json: string } | undefined
    expect(JSON.parse(refreshAudit?.details_json ?? '{}')).toMatchObject({
      fromWorkVersion: 1,
      toWorkVersion: 2,
      source: 'execution_start',
    })

    const staleRecord = {
      workId: work.id,
      version: 99,
      memoryJson: JSON.stringify(refreshed),
      acceptanceCriteriaSnapshotJson: JSON.stringify(['v2']),
      acceptanceCriteriaWorkVersion: 2,
      acceptanceCriteriaWorkUpdatedAt: NOW,
      summary: '',
      createdAt: NOW,
      updatedAt: NOW,
    }
    expect(h.memories.updateAcceptanceSnapshot(staleRecord)).toBe(false)
  })

  it('keeps Task Memory isolated by Work and Project', () => {
    const h = harness()
    h.projects.create({
      id: 'prj-alpha',
      name: 'Alpha',
      description: '',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const workA = h.workService.create({
      name: 'A',
      rootPath: '/tmp/agentra-a',
      projectId: 'prj-alpha',
      acceptanceCriteria: ['A 标准'],
    })
    const workB = h.workService.create({
      name: 'B',
      rootPath: '/tmp/agentra-b',
      acceptanceCriteria: ['B 标准'],
    })
    expect(workA.projectId).toBe('prj-alpha')
    expect(workB.projectId).toBe('prj-default')
    expect(h.taskMemoryService.get(workA.id)?.acceptanceCriteria.items[0]?.statement).toBe('A 标准')
    expect(h.taskMemoryService.get(workB.id)?.acceptanceCriteria.items[0]?.statement).toBe('B 标准')
  })

  it('rejects invalid Project IDs and does not fabricate old Work criteria', () => {
    const h = harness()
    expect(() =>
      h.workService.create({
        name: 'invalid',
        rootPath: '/tmp/agentra-invalid',
        projectId: 'prj-missing',
      }),
    ).toThrow(/project not found/)
    const work = h.workService.create({ name: 'old', rootPath: '/tmp/agentra-old' })
    expect(work.acceptanceCriteria).toEqual([])
    expect(h.taskMemoryService.get(work.id)?.acceptanceCriteria.items).toEqual([])
  })

  it('rejects concurrent acceptance criteria updates with a stale version', () => {
    const h = harness()
    const work = h.workService.create({
      name: '并发',
      rootPath: '/tmp/agentra-concurrent',
      acceptanceCriteria: ['v1'],
    })
    expect(
      h.workRepository.updateAcceptanceCriteria(
        work.id,
        work.acceptanceCriteriaVersion,
        ['v2'],
        2,
        NOW,
        NOW,
      ),
    ).toBe(true)
    expect(h.workRepository.updateAcceptanceCriteria(work.id, 1, ['stale'], 2, NOW, NOW)).toBe(
      false,
    )
    expect(h.workService.get(work.id).acceptanceCriteria).toEqual(['v2'])
  })

  it('rolls back the Work update when Task Memory refresh fails in the same transaction', () => {
    const h = harness()
    const work = h.workService.create({
      name: '事务',
      rootPath: '/tmp/agentra-transaction',
      acceptanceCriteria: ['v1'],
    })
    const failing = new WorkService(
      h.db,
      h.workRepository,
      new TeamRepository(h.db),
      h.audit,
      () => NOW,
      undefined,
      h.projects,
      {
        ensureForWorkInTransaction: () => {
          throw new Error('not used')
        },
        refreshForWorkInTransaction: () => {
          throw new Error('task memory refresh failed')
        },
      },
    )
    expect(() => failing.updateAcceptanceCriteria(work.id, ['v2'])).toThrow(
      'task memory refresh failed',
    )
    const stored = h.workRepository.get(work.id)
    expect(stored?.acceptanceCriteria).toEqual(['v1'])
    expect(stored?.acceptanceCriteriaVersion).toBe(1)
    const auditCount = h.db
      .prepare(
        "SELECT count(*) AS c FROM audit_logs WHERE action = 'work.acceptance_criteria_changed'",
      )
      .get() as { c: number }
    expect(auditCount.c).toBe(0)
  })

  it('preserves pre-migration Work rows without fabricating criteria', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-task-memory-migrate-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 30),
    )
    expect(currentUserVersion(db)).toBe(30)
    db.prepare(
      `INSERT INTO works (id, name, root_path, created_at, updated_at)
       VALUES ('work-old', '旧任务', '/tmp/agentra-old-work', ?, ?)`,
    ).run(NOW, NOW)
    migrate(db)
    expect(currentUserVersion(db)).toBe(34)
    const row = db
      .prepare(
        `SELECT name, root_path, acceptance_criteria_json, acceptance_criteria_version,
                acceptance_criteria_updated_at
         FROM works WHERE id = 'work-old'`,
      )
      .get() as {
      name: string
      root_path: string
      acceptance_criteria_json: string
      acceptance_criteria_version: number
      acceptance_criteria_updated_at: string | null
    }
    expect(row).toMatchObject({
      name: '旧任务',
      root_path: '/tmp/agentra-old-work',
      acceptance_criteria_json: '[]',
      acceptance_criteria_version: 1,
      acceptance_criteria_updated_at: null,
    })
    const work = new WorkRepository(db).get('work-old')
    expect(work?.acceptanceCriteria).toEqual([])
    if (!work) throw new Error('old work not found after migration')
    const service = new TaskMemoryService({
      db,
      memories: new TaskMemoryRepository(db),
      now: () => NOW,
    })
    const memory = service.ensureForWorkInTransaction(work)
    expect(memory.acceptanceCriteria.workVersion).toBe(1)
    expect(memory.acceptanceCriteria.items).toEqual([])
  })
})
