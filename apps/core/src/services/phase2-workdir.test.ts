import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkdirLockService } from './workdir-lock-service'
import { WorktreeService } from './worktree-service'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

function tempDir(prefix = 'agentra-b3-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // 忽略
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
}

function openDb(): Database {
  const dir = tempDir()
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  return db
}

function seedWork(db: Database, id: string, rootPath: string, repositoryPath: string | null): void {
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES (?, ?, '', '', 'active', 'normal', ?, ?, '{}', ?, ?, NULL)`,
  ).run(id, id, rootPath, repositoryPath, NOW, NOW)
}

describe('WorkdirLockService（键 = 实际工作目录绝对路径）', () => {
  it('blocks a second execution on the same directory and releases on demand', () => {
    const db = openDb()
    const locks = new WorkdirLockService(db, () => NOW, process.pid)
    const dir = tempDir()

    const first = locks.acquire(dir, 'exe-1', 'work-1')
    expect(first.workdir).toBe(path.resolve(dir))

    expect(() => locks.acquire(dir, 'exe-2', 'work-2')).toThrow(
      expect.objectContaining({ code: 'WORKDIR_LOCKED' }),
    )

    // 同一执行重复获取是幂等的，不会自锁
    expect(locks.acquire(dir, 'exe-1', 'work-1').executionId).toBe('exe-1')

    expect(locks.releaseByExecution('exe-1')).toBe(1)
    expect(locks.acquire(dir, 'exe-2', 'work-2').executionId).toBe('exe-2')
    db.close()
  })

  it('treats the lock as stale when the holder pid is dead and reclaims it', () => {
    const db = openDb()
    const dir = tempDir()
    // 模拟上一次 Core 被 kill -9 后留下的行：holder_pid 是个必然不存在的进程
    db.prepare(
      `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, acquired_at)
       VALUES (?, 'exe-dead', 'work-1', 999999, ?)`,
    ).run(path.resolve(dir), NOW)

    const locks = new WorkdirLockService(db, () => NOW, process.pid)
    const record = locks.acquire(dir, 'exe-new', 'work-1')
    expect(record.executionId).toBe('exe-new')

    db.close()
  })

  it('purgeStale removes only dead-holder rows', () => {
    const db = openDb()
    const alive = tempDir()
    const dead = tempDir()
    db.prepare(
      `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, acquired_at)
       VALUES (?, 'exe-alive', NULL, ?, ?)`,
    ).run(path.resolve(alive), process.pid, NOW)
    db.prepare(
      `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, acquired_at)
       VALUES (?, 'exe-dead', NULL, 999999, ?)`,
    ).run(path.resolve(dead), NOW)

    const locks = new WorkdirLockService(db, () => NOW, process.pid)
    expect(locks.purgeStale()).toBe(1)
    expect(locks.get(alive)?.executionId).toBe('exe-alive')
    expect(locks.get(dead)).toBeNull()
    db.close()
  })
})

describe('WorktreeService', () => {
  it('creates, lists and removes a worktree (remove requires confirmation)', () => {
    const db = openDb()
    const repo = tempDir('agentra-repo-')
    makeGitRepo(repo)
    seedWork(db, 'work-1', tempDir('agentra-root-'), repo)
    const worktreesRoot = tempDir('agentra-wt-')
    const service = new WorktreeService(db, new WorkRepository(db), worktreesRoot, () => NOW)

    const created = service.create({ workId: 'work-1', branchName: 'agentra/w1' })
    expect(created).toMatchObject({ workId: 'work-1', branchName: 'agentra/w1', status: 'active' })
    expect(fs.existsSync(created.worktreePath)).toBe(true)
    expect(created.baseCommit).toMatch(/^[0-9a-f]{40}$/)

    expect(service.list('work-1').map((item) => item.id)).toEqual([created.id])

    // 未确认：直接拒绝，且不产生任何副作用
    expect(() => service.remove(created.id, false)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    expect(fs.existsSync(created.worktreePath)).toBe(true)
    expect(service.get(created.id)?.status).toBe('active')

    const removed = service.remove(created.id, true)
    expect(removed.status).toBe('removed')
    expect(removed.removedAt).toBe(NOW)
    expect(fs.existsSync(created.worktreePath)).toBe(false)
    expect(service.list('work-1')).toHaveLength(0)
    db.close()
  })

  it('rejects a duplicate active branch and reports git errors', () => {
    const db = openDb()
    const repo = tempDir('agentra-repo-')
    makeGitRepo(repo)
    seedWork(db, 'work-1', tempDir('agentra-root-'), repo)
    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      tempDir('agentra-wt-'),
      () => NOW,
    )

    service.create({ workId: 'work-1', branchName: 'agentra/dup' })
    expect(() => service.create({ workId: 'work-1', branchName: 'agentra/dup' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    db.close()
  })

  it('reports the three error paths: no repository_path / missing path / not a git repo', () => {
    const db = openDb()
    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      tempDir('agentra-wt-'),
      () => NOW,
    )

    // 1) Work 没有 repository_path
    seedWork(db, 'work-norepo', tempDir('agentra-root-'), null)
    expect(() => service.create({ workId: 'work-norepo', branchName: 'b' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    // 2) 路径不存在
    seedWork(db, 'work-missing', tempDir('agentra-root-'), path.join(tempDir(), 'nope'))
    expect(() => service.create({ workId: 'work-missing', branchName: 'b' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    // 3) 存在但不是 git 仓库
    const plain = tempDir('agentra-plain-')
    seedWork(db, 'work-plain', tempDir('agentra-root-'), plain)
    expect(() => service.create({ workId: 'work-plain', branchName: 'b' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    db.close()
  })

  it('reports a write-permission failure instead of throwing raw fs errors', () => {
    const db = openDb()
    const repo = tempDir('agentra-repo-')
    makeGitRepo(repo)
    seedWork(db, 'work-1', tempDir('agentra-root-'), repo)
    const readOnlyRoot = tempDir('agentra-wt-ro-')
    fs.chmodSync(readOnlyRoot, 0o500)
    const service = new WorktreeService(db, new WorkRepository(db), readOnlyRoot, () => NOW)

    expect(() => service.create({ workId: 'work-1', branchName: 'agentra/denied' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    fs.chmodSync(readOnlyRoot, 0o700)
    db.close()
  })
})
