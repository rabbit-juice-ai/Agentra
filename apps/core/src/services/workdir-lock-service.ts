import path from 'node:path'
import { RpcMethodError } from '@agentra/protocol'
import type { Database } from '../db/database'

export type WorkdirLockRecord = {
  workdir: string
  executionId: string
  workId: string | null
  holderPid: number
  acquiredAt: string
}

type LockRow = {
  workdir: string
  execution_id: string
  work_id: string | null
  holder_pid: number
  acquired_at: string
}

function toRecord(row: LockRow): WorkdirLockRecord {
  return {
    workdir: row.workdir,
    executionId: row.execution_id,
    workId: row.work_id,
    holderPid: row.holder_pid,
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
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly holderPid: number = process.pid,
  ) {}

  acquire(workdirInput: string, executionId: string, workId: string | null): WorkdirLockRecord {
    const workdir = path.resolve(workdirInput)

    demoteStale(this.db, workdir)

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
          `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, acquired_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(workdir, executionId, workId, this.holderPid, this.now())
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

  /** 回收 holder_pid 已死的锁；返回回收条数。Core 启动时调用一次。 */
  purgeStale(): number {
    const rows = this.db.prepare('SELECT * FROM workdir_locks').all() as LockRow[]
    const stale = rows.filter((row) => !isProcessAlive(row.holder_pid))
    const del = this.db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND holder_pid = ?')
    let removed = 0
    for (const row of stale) {
      removed += Number(del.run(row.workdir, row.holder_pid).changes)
    }
    return removed
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

/** 单条锁的陈旧判定：持锁者已死则删掉，让本次获取继续。 */
function demoteStale(db: Database, workdir: string): void {
  const row = db.prepare('SELECT * FROM workdir_locks WHERE workdir = ?').get(workdir) as
    | LockRow
    | undefined
  if (row && !isProcessAlive(row.holder_pid)) {
    db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND holder_pid = ?').run(
      workdir,
      row.holder_pid,
    )
  }
}
