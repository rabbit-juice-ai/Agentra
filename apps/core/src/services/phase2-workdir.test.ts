import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import {
  type BootIdentity,
  currentBootUuid,
  isProcessAlive,
  processStartedAt,
  WorkdirLockService,
} from './workdir-lock-service'
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

const BOOT_A: BootIdentity = {
  status: 'known',
  uuid: '11111111-1111-4111-8111-111111111111',
}
const BOOT_B: BootIdentity = {
  status: 'known',
  uuid: '22222222-2222-4222-8222-222222222222',
}
const BOOT_UNKNOWN: BootIdentity = { status: 'unknown', reason: 'sysctl failed (ENOENT)' }

function insertExecution(
  db: Database,
  executionId: string,
  status = 'running',
  processId: number | null = process.pid,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO runtime_providers (
       id, provider_type, provider_name, executable_path, version, capabilities_json,
       health_status, last_discovered_at, created_at, updated_at
     ) VALUES ('prov-test', 'cli', 'test', NULL, NULL, '{}', 'healthy', NULL, ?, ?)`,
  ).run(NOW, NOW)
  const sessionId = `ses-${executionId}`
  db.prepare(
    `INSERT OR IGNORE INTO agent_sessions (
       id, assignment_id, provider_id, external_session_id, context_ref, status,
       created_at, updated_at, last_active_at
     ) VALUES (?, NULL, 'prov-test', NULL, NULL, 'active', ?, ?, ?)`,
  ).run(sessionId, NOW, NOW, NOW)
  db.prepare(
    `INSERT OR IGNORE INTO executions (
       id, session_id, node_run_id, provider_id, external_execution_id, process_id, status,
       working_directory, started_at, ended_at, exit_code, capabilities_snapshot_json,
       recovery_state_json, created_at, updated_at
     ) VALUES (?, ?, NULL, 'prov-test', NULL, ?, ?, ?, ?, NULL, NULL, '{}', NULL, ?, ?)`,
  ).run(
    executionId,
    sessionId,
    processId,
    status,
    path.resolve('/tmp/agentra-lock-test'),
    status === 'running' ? NOW : null,
    NOW,
    NOW,
  )
}

function insertLock(
  db: Database,
  workdir: string,
  input: {
    executionId: string
    holderPid: number
    bootUuid: string | null
    executionStatus?: string
    executionProcessId?: number | null
    holderStartedAt?: string | null
    holderKind?: 'core' | 'cli' | null
  },
): void {
  insertExecution(
    db,
    input.executionId,
    input.executionStatus ?? 'running',
    input.executionProcessId === undefined ? input.holderPid : input.executionProcessId,
  )
  db.prepare(
    `INSERT INTO workdir_locks (
       workdir, execution_id, work_id, holder_pid, holder_started_at, holder_kind,
       boot_uuid, acquired_at
     ) VALUES (?, ?, 'work-1', ?, ?, ?, ?, ?)`,
  ).run(
    fs.realpathSync.native(workdir),
    input.executionId,
    input.holderPid,
    input.holderStartedAt ?? null,
    input.holderKind ?? null,
    input.bootUuid,
    NOW,
  )
}

describe('WorkdirLockService（键 = 实际工作目录绝对路径）', () => {
  it('blocks a second execution on the same directory and releases on demand', () => {
    const db = openDb()
    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    const dir = tempDir()

    const first = locks.acquire(dir, 'exe-1', 'work-1')
    expect(first.workdir).toBe(fs.realpathSync.native(dir))
    expect(first.bootUuid).toBe(BOOT_A.status === 'known' ? BOOT_A.uuid : null)
    // 运行期断言：新行只写 boot_uuid，boot_id 保持 NULL（新代码不读不写旧列）
    expect(
      db
        .prepare('SELECT boot_id, boot_uuid FROM workdir_locks WHERE workdir = ?')
        .get(fs.realpathSync.native(dir)),
    ).toEqual({ boot_id: null, boot_uuid: BOOT_A.status === 'known' ? BOOT_A.uuid : null })

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
    insertLock(db, dir, {
      executionId: 'exe-dead',
      holderPid: 999999,
      bootUuid: null,
      executionStatus: 'failed',
      holderStartedAt: 'legacy-start',
      holderKind: 'cli',
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    const record = locks.acquire(dir, 'exe-new', 'work-1')
    expect(record.executionId).toBe('exe-new')
    db.close()
  })

  it('reclaims a lock whose boot uuid differs even when the pid is still alive (跨重启 pid 复用)', () => {
    const db = openDb()
    const dir = tempDir()
    // 关键构造：holder_pid 是「活着的」当前进程，但 boot_uuid 属于上一次开机 ——
    // 只按 pid 判活会误判成有效锁，导致目录永久锁死。
    insertLock(db, dir, {
      executionId: 'exe-previous-boot',
      holderPid: process.pid,
      bootUuid: BOOT_B.status === 'known' ? BOOT_B.uuid : null,
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    expect(() => locks.acquire(dir, 'exe-new', 'work-1')).toThrow(
      expect.objectContaining({ code: 'WORKDIR_LOCKED' }),
    )
    expect(locks.get(dir)?.executionId).toBe('exe-previous-boot')
    db.close()
  })

  it('purgeStale removes only dead-holder rows on the same boot', () => {
    const db = openDb()
    const alive = tempDir()
    const dead = tempDir()
    insertLock(db, alive, {
      executionId: 'exe-alive',
      holderPid: process.pid,
      bootUuid: BOOT_A.status === 'known' ? BOOT_A.uuid : null,
    })
    insertLock(db, dead, {
      executionId: 'exe-dead',
      holderPid: 999999,
      bootUuid: BOOT_A.status === 'known' ? BOOT_A.uuid : null,
      executionStatus: 'failed',
      holderStartedAt: 'legacy-start',
      holderKind: 'cli',
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    const purged = locks.purgeStale()
    expect(purged.reclaimed).toBe(1)
    expect(purged.retained).toBe(1)
    expect(purged.identity).toEqual(BOOT_A)
    expect(locks.get(alive)?.executionId).toBe('exe-alive')
    expect(locks.get(dead)).toBeNull()
    db.close()
  })
})

describe('开机身份（Boot Session UUID）', () => {
  it('reads the UUID, trims and normalizes case', () => {
    const identity = currentBootUuid(() => '  4c98d50e-2d38-4d4d-8035-139e55e3c44d\n')
    expect(identity).toEqual({
      status: 'known',
      uuid: '4C98D50E-2D38-4D4D-8035-139E55E3C44D',
    })
  })

  it('is stable across repeated samples in the same boot', () => {
    const values = Array.from({ length: 20 }, () =>
      currentBootUuid(() => '4C98D50E-2D38-4D4D-8035-139E55E3C44D\n'),
    )
    expect(new Set(values.map((item) => JSON.stringify(item))).size).toBe(1)
  })

  it('fails closed on malformed output', () => {
    const identity = currentBootUuid(() => 'not-a-uuid\n')
    expect(identity.status).toBe('unknown')
    if (identity.status === 'unknown') expect(identity.reason).toContain('unexpected')
  })

  it('fails closed when the reader throws', () => {
    const identity = currentBootUuid(() => {
      const error = new Error('spawn sysctl ENOENT') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    })
    expect(identity.status).toBe('unknown')
    if (identity.status === 'unknown') expect(identity.reason).toContain('ENOENT')
  })

  it('treats EPERM as alive and ESRCH as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    // pid 1 是 launchd：存在但无权限发信号 → EPERM → 视为存活
    expect(isProcessAlive(1)).toBe(true)
    // 高 pid 不存在 → ESRCH → 死亡
    expect(isProcessAlive(999999)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

describe('锁回收的 fail-closed 规则（真实 SQLite）', () => {
  it('never reclaims a live lock on the same boot', () => {
    const db = openDb()
    const dir = tempDir()
    insertLock(db, dir, {
      executionId: 'exe-alive',
      holderPid: process.pid,
      bootUuid: BOOT_A.status === 'known' ? BOOT_A.uuid : null,
    })
    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)

    const row = db.prepare('SELECT * FROM workdir_locks').get() as Parameters<
      WorkdirLockService['isStale']
    >[0]
    expect(locks.isStale(row)).toBe(false)
    expect(locks.purgeStale().reclaimed).toBe(0)
    expect(() => locks.acquire(dir, 'exe-other', null)).toThrow(
      expect.objectContaining({ code: 'WORKDIR_LOCKED' }),
    )
    expect(locks.get(dir)?.executionId).toBe('exe-alive')
    db.close()
  })

  it('reclaims a legacy NULL boot_uuid only when the holder is dead', () => {
    const db = openDb()
    const alive = tempDir()
    const dead = tempDir()
    insertLock(db, alive, {
      executionId: 'exe-legacy-alive',
      holderPid: process.pid,
      bootUuid: null,
    })
    insertLock(db, dead, {
      executionId: 'exe-legacy-dead',
      holderPid: 999999,
      bootUuid: null,
      executionStatus: 'failed',
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    const purged = locks.purgeStale()
    expect(purged.reclaimed).toBe(0)
    expect(purged.retained).toBe(2)
    expect(locks.get(alive)?.executionId).toBe('exe-legacy-alive')
    expect(locks.get(dead)?.executionId).toBe('exe-legacy-dead')
    db.close()
  })

  it('degrades to pid-only reclaim when the boot identity is unknown', () => {
    const db = openDb()
    const alive = tempDir()
    const dead = tempDir()
    // 即使行里带着「另一个」UUID，身份未知时也不能据此回收
    insertLock(db, alive, { executionId: 'exe-alive', holderPid: process.pid, bootUuid: 'OTHER' })
    insertLock(db, dead, {
      executionId: 'exe-dead',
      holderPid: 999999,
      bootUuid: 'OTHER',
      executionStatus: 'failed',
      holderStartedAt: 'legacy-start',
      holderKind: 'cli',
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_UNKNOWN)
    const purged = locks.purgeStale()
    expect(purged.reclaimed).toBe(1)
    expect(purged.retained).toBe(1)
    expect(purged.identity.status).toBe('unknown')
    expect(locks.get(alive)?.executionId).toBe('exe-alive')
    expect(locks.get(dead)).toBeNull()

    // 新锁在身份未知时仍可获取，但写入的 boot_uuid 为 NULL
    const other = tempDir()
    const created = locks.acquire(other, 'exe-new', null)
    expect(created.bootUuid).toBeNull()
    db.close()
  })

  it('keeps an identity-unverifiable live lock but reclaims a dead one on acquire', () => {
    const db = openDb()
    const alive = tempDir()
    const dead = tempDir()
    insertLock(db, alive, { executionId: 'exe-alive', holderPid: process.pid, bootUuid: 'OTHER' })
    insertLock(db, dead, {
      executionId: 'exe-dead',
      holderPid: 999999,
      bootUuid: 'OTHER',
      executionStatus: 'failed',
      holderStartedAt: 'legacy-start',
      holderKind: 'cli',
    })

    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_UNKNOWN)
    expect(() => locks.acquire(alive, 'exe-new', null)).toThrow(
      expect.objectContaining({ code: 'WORKDIR_LOCKED' }),
    )
    expect(locks.acquire(dead, 'exe-new-2', null).executionId).toBe('exe-new-2')
    db.close()
  })
})

describe('WorkdirLockService · Phase 1B-2B 回收规则', () => {
  it('keeps a live CLI lock even when Boot UUID changed', () => {
    const db = openDb()
    const dir = tempDir()
    const started = processStartedAt(process.pid)
    insertLock(db, dir, {
      executionId: 'exe-cli-live',
      holderPid: process.pid,
      bootUuid: BOOT_B.status === 'known' ? BOOT_B.uuid : null,
      executionStatus: 'running',
      holderStartedAt: started,
      holderKind: 'cli',
    })
    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    expect(locks.purgeStale().reclaimed).toBe(0)
    expect(locks.get(dir)?.executionId).toBe('exe-cli-live')
    db.close()
  })

  it('keeps a lock whose Execution record is missing (manual review)', () => {
    const db = openDb()
    const dir = tempDir()
    db.prepare(
      `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, boot_uuid, acquired_at)
       VALUES (?, 'exe-missing', 'work-1', ?, ?, ?)`,
    ).run(fs.realpathSync.native(dir), process.pid, BOOT_A.uuid, NOW)
    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    expect(locks.purgeStale().reclaimed).toBe(0)
    expect(locks.get(dir)?.executionId).toBe('exe-missing')
    db.close()
  })

  it('moves holder from core pid to CLI pid after spawn', () => {
    const db = openDb()
    const dir = tempDir()
    const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT_A)
    locks.acquire(dir, 'exe-1', 'work-1')
    expect(locks.updateHolderPid(dir, 'exe-1', process.pid, 'cli-start')).toBe(true)
    expect(locks.get(dir)).toMatchObject({
      holderPid: process.pid,
      holderStartedAt: 'cli-start',
      holderKind: 'cli',
    })
    expect(locks.updateHolderPid(dir, 'exe-other', process.pid, 'x')).toBe(false)
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
    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      new AssignmentRepository(db),
      worktreesRoot,
      () => NOW,
    )

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
      new AssignmentRepository(db),
      tempDir('agentra-wt-'),
      () => NOW,
    )

    service.create({ workId: 'work-1', branchName: 'agentra/dup' })
    expect(() => service.create({ workId: 'work-1', branchName: 'agentra/dup' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    db.close()
  })

  it('assignmentId 必须属于该 Work，否则拒绝', () => {
    const db = openDb()
    const repo = tempDir('agentra-repo-')
    makeGitRepo(repo)
    seedWork(db, 'work-1', tempDir('agentra-root-'), repo)
    seedWork(db, 'work-2', tempDir('agentra-root-'), repo)
    db.prepare(
      `INSERT INTO agent_profiles (id, name, avatar, description, system_prompt, skill_ids_json,
         access_mode, system_kind, tool_permissions_json, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at)
       VALUES ('agt-1', 'A', '🤖', '', '', '[]', 'edit', NULL, '{"version":1,"allow":["Read"],"deny":[]}', NULL, 1, 'active', ?, ?, NULL)`,
    ).run(NOW, NOW)
    db.prepare(
      `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
         concurrency_limit, context_ref, created_at, updated_at)
       VALUES ('asg-2', 'work-2', 'agt-1', NULL, 'engineer', '', 'active', NULL, NULL, ?, ?)`,
    ).run(NOW, NOW)

    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      new AssignmentRepository(db),
      tempDir('agentra-wt-'),
      () => NOW,
    )
    // assignment 属于 work-2，却挂到 work-1 上 → 拒绝
    expect(() =>
      service.create({ workId: 'work-1', assignmentId: 'asg-2', branchName: 'agentra/x' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    db.close()
  })

  it('reports the three error paths: no repository_path / missing path / not a git repo', () => {
    const db = openDb()
    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      new AssignmentRepository(db),
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
    const service = new WorktreeService(
      db,
      new WorkRepository(db),
      new AssignmentRepository(db),
      readOnlyRoot,
      () => NOW,
    )

    expect(() => service.create({ workId: 'work-1', branchName: 'agentra/denied' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    fs.chmodSync(readOnlyRoot, 0o700)
    db.close()
  })
})
