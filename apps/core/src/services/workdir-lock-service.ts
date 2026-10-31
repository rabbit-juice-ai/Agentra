import os from 'node:os'
import path from 'node:path'
import { RpcMethodError } from '@agentra/protocol'
import type { Database } from '../db/database'

export type WorkdirLockRecord = {
  workdir: string
  executionId: string
  workId: string | null
  holderPid: number
  bootId: number | null
  acquiredAt: string
}

type LockRow = {
  workdir: string
  execution_id: string
  work_id: string | null
  holder_pid: number
  boot_id: number | null
  acquired_at: string
}

/**
 * 开机身份：当前时刻减去系统运行时长，取整到秒。
 * 跨重启一定不同（重启后 uptime 归零），用来识别「上一次开机的锁」——
 * 只靠 pid 判活会被 pid 复用骗过，导致目录永久锁死。
 */
export function currentBootId(nowMs: number = Date.now(), uptimeSeconds = os.uptime()): number {
  return Math.round((nowMs - uptimeSeconds * 1000) / 1000)
}

function toRecord(row: LockRow): WorkdirLockRecord {
  return {
    workdir: row.workdir,
    executionId: row.execution_id,
    workId: row.work_id,
    holderPid: row.holder_pid,
    bootId: row.boot_id,
    acquiredAt: row.acquired_at,
  }
}

/** pid 是否存活；EPERM 表示存在但无权限发信号，按存活处理。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 工作目录锁（DATABASE 之外运行态，落在 workdir_locks）。
 *
 * 键是**实际工作目录的绝对路径**而不是 Work id —— 验收口径是「两个 Work 指向同一非 Worktree
 * 目录」，按 Work 上锁根本测不出这条。Worktree 是独立目录，路径不同自然不冲突。
 *
 * 回收策略：持锁者是 Core 进程，行里记 holder_pid。
 * - 正常路径：执行终结时 release（按 execution_id 删）。
 * - 异常路径：Core 被 kill -9 后行还在，但 holder_pid 已死 → 下一次 acquire 或启动时 purgeStale 回收。
 */
export class WorkdirLockService {
  private readonly bootId: number

  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly holderPid: number = process.pid,
    bootId: number = currentBootId(),
  ) {
    this.bootId = bootId
  }

  acquire(workdirInput: string, executionId: string, workId: string | null): WorkdirLockRecord {
    const workdir = path.resolve(workdirInput)

    demoteStale(this.db, workdir, this.bootId)

    const existing = this.get(workdir)
    if (existing) {
      // 同一执行重复获取：幂等
      if (existing.executionId === executionId) return existing
      throw new RpcMethodError(
        'WORKDIR_LOCKED',
        `工作目录已被执行 ${existing.executionId} 占用：${workdir}`,
      )
    }

    try {
      this.db
        .prepare(
          `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, boot_id, acquired_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(workdir, executionId, workId, this.holderPid, this.bootId, this.now())
    } catch (error) {
      // 并发写入撞主键：按「已被占用」处理，不静默覆盖。
      const code = (error as { code?: string }).code
      if (code === 'ERR_SQLITE_ERROR') {
        throw new RpcMethodError('WORKDIR_LOCKED', `工作目录已被占用：${workdir}`)
      }
      throw error
    }
    const created = this.get(workdir)
    if (!created) throw new Error(`workdir lock insert failed: ${workdir}`)
    return created
  }

  /** 释放该执行持有的全部锁（一个执行只持有一把，按 execution 删更稳）。 */
  releaseByExecution(executionId: string): number {
    const result = this.db
      .prepare('DELETE FROM workdir_locks WHERE execution_id = ?')
      .run(executionId)
    return Number(result.changes)
  }

  release(workdirInput: string, executionId: string): boolean {
    const workdir = path.resolve(workdirInput)
    const result = this.db
      .prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
      .run(workdir, executionId)
    return Number(result.changes) > 0
  }

  /** 回收陈旧锁；返回回收条数。Core 启动时调用一次。 */
  purgeStale(): number {
    const rows = this.db.prepare('SELECT * FROM workdir_locks').all() as LockRow[]
    const stale = rows.filter((row) => this.isStale(row))
    const del = this.db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
    let removed = 0
    for (const row of stale) {
      removed += Number(del.run(row.workdir, row.execution_id).changes)
    }
    return removed
  }

  /**
   * 陈旧判定：
   * 1. 跨开机（boot_id 不同或缺失）→ 无条件回收，**不看 pid**（pid 会被复用）；
   * 2. 同一次开机内 → 持锁进程已死才算陈旧。
   */
  isStale(row: LockRow): boolean {
    if (row.boot_id === null || row.boot_id !== this.bootId) return true
    return !isProcessAlive(row.holder_pid)
  }

  get(workdirInput: string): WorkdirLockRecord | null {
    const workdir = path.resolve(workdirInput)
    const row = this.db.prepare('SELECT * FROM workdir_locks WHERE workdir = ?').get(workdir) as
      | LockRow
      | undefined
    return row ? toRecord(row) : null
  }

  list(): WorkdirLockRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workdir_locks ORDER BY acquired_at ASC')
      .all() as LockRow[]
    return rows.map(toRecord)
  }
}

/** 单条锁的陈旧判定：跨开机或持锁者已死则删掉，让本次获取继续。 */
function demoteStale(db: Database, workdir: string, bootId: number): void {
  const row = db.prepare('SELECT * FROM workdir_locks WHERE workdir = ?').get(workdir) as
    | LockRow
    | undefined
  if (!row) return
  const stale = row.boot_id === null || row.boot_id !== bootId || !isProcessAlive(row.holder_pid)
  if (stale) {
    db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?').run(
      workdir,
      row.execution_id,
    )
  }
}
