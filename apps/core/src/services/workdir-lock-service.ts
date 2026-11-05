import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { RpcMethodError } from '@agentra/protocol'
import type { Database } from '../db/database'

/**
 * 开机身份 = macOS Boot Session UUID（`kern.bootsessionuuid`）。
 *
 * 旧实现用「当前时刻减去系统运行时长」推算开机纪元并四舍五入到秒：两次独立采样之间
 * 存在 0.7 秒级的抖动，对带噪声的连续估计值做单点阈值判断，同一开机内会算出两个不同
 * 身份，进而把活锁当陈旧锁回收。新实现不再做任何推算。
 * Boot Session UUID 是内核维护的离散标识，同一开机会话内逐字不变；重启后必变。
 */
export type BootIdentity = { status: 'known'; uuid: string } | { status: 'unknown'; reason: string }

export type PurgeResult = {
  reclaimed: number
  retained: number
  identity: BootIdentity
}

export type SysctlReader = (args: string[]) => string

const BOOT_UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

function defaultSysctlReader(args: string[]): string {
  // 绝对路径：GUI 启动的 Core 不依赖 PATH。
  return execFileSync('/usr/sbin/sysctl', args, {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function describeReadError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; status?: unknown; message?: unknown }
    const parts: string[] = []
    if (typeof record.code === 'string') parts.push(`code=${record.code}`)
    if (typeof record.status === 'number') parts.push(`exit=${record.status}`)
    if (typeof record.message === 'string') parts.push(record.message)
    if (parts.length > 0) return parts.join(' ')
  }
  return String(error)
}

/**
 * 读取当前开机身份。读取失败返回 `unknown` —— 调用方必须 fail closed：
 * 不得依据不确定的开机身份回收任何锁，也不得回退到旧的 uptime 推算。
 */
export function currentBootUuid(read: SysctlReader = defaultSysctlReader): BootIdentity {
  try {
    const raw = read(['-n', 'kern.bootsessionuuid'])
    const uuid = raw.trim().toUpperCase()
    if (!BOOT_UUID_PATTERN.test(uuid)) {
      return {
        status: 'unknown',
        reason: `unexpected kern.bootsessionuuid: ${JSON.stringify(raw.trim().slice(0, 80))}`,
      }
    }
    return { status: 'known', uuid }
  } catch (error) {
    return { status: 'unknown', reason: describeReadError(error) }
  }
}

/** pid 是否存活：只有 ESRCH 表示进程不存在；EPERM 与其他错误一律按存活处理（fail closed）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type WorkdirLockRecord = {
  workdir: string
  executionId: string
  workId: string | null
  holderPid: number
  bootUuid: string | null
  acquiredAt: string
}

export type WorkdirLockRow = {
  workdir: string
  execution_id: string
  work_id: string | null
  holder_pid: number
  boot_uuid: string | null
  acquired_at: string
}

function toRecord(row: WorkdirLockRow): WorkdirLockRecord {
  return {
    workdir: row.workdir,
    executionId: row.execution_id,
    workId: row.work_id,
    holderPid: row.holder_pid,
    bootUuid: row.boot_uuid,
    acquiredAt: row.acquired_at,
  }
}

/**
 * 陈旧判定（fail closed）：
 * - 身份已知且行内 UUID 明确不同 → 真跨开机，回收（即使 pid 存活，可能是复用）；
 * - 其余情况（身份未知 / 历史行 UUID 为 NULL / UUID 相同）→ 只依据「holder_pid 已死」
 *   这一确定事实回收，绝不依据不确定的身份回收。
 */
function shouldReclaim(row: WorkdirLockRow, identity: BootIdentity): boolean {
  if (identity.status === 'known' && row.boot_uuid !== null && row.boot_uuid !== identity.uuid) {
    return true
  }
  return !isProcessAlive(row.holder_pid)
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
 * - 身份不可读（sysctl 失败）：降级为「只按 pid 死亡回收」，并在日志里标明 degraded。
 */
export class WorkdirLockService {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly holderPid: number = process.pid,
    readonly identity: BootIdentity = currentBootUuid(),
  ) {}

  private get bootUuid(): string | null {
    return this.identity.status === 'known' ? this.identity.uuid : null
  }

  acquire(workdirInput: string, executionId: string, workId: string | null): WorkdirLockRecord {
    const workdir = path.resolve(workdirInput)

    demoteStale(this.db, workdir, this.identity)

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
          `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, boot_uuid, acquired_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(workdir, executionId, workId, this.holderPid, this.bootUuid, this.now())
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

  /** S55-2B-1B：该执行当前持有的锁数量（终态补偿 S4 验证用）。 */
  countByExecution(executionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM workdir_locks WHERE execution_id = ?')
      .get(executionId) as { c: number }
    return row.c
  }

  release(workdirInput: string, executionId: string): boolean {
    const workdir = path.resolve(workdirInput)
    const result = this.db
      .prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
      .run(workdir, executionId)
    return Number(result.changes) > 0
  }

  /** 回收陈旧锁；Core 启动时调用一次。身份不可读时只做 pid 死亡回收。 */
  purgeStale(): PurgeResult {
    const rows = this.db.prepare('SELECT * FROM workdir_locks').all() as WorkdirLockRow[]
    const del = this.db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
    let reclaimed = 0
    for (const row of rows) {
      if (!shouldReclaim(row, this.identity)) continue
      reclaimed += Number(del.run(row.workdir, row.execution_id).changes)
    }
    return { reclaimed, retained: rows.length - reclaimed, identity: this.identity }
  }

  /** 单条锁是否应按陈旧回收（规则见 shouldReclaim）。 */
  isStale(row: WorkdirLockRow): boolean {
    return shouldReclaim(row, this.identity)
  }

  get(workdirInput: string): WorkdirLockRecord | null {
    const workdir = path.resolve(workdirInput)
    const row = this.db.prepare('SELECT * FROM workdir_locks WHERE workdir = ?').get(workdir) as
      | WorkdirLockRow
      | undefined
    return row ? toRecord(row) : null
  }

  list(): WorkdirLockRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workdir_locks ORDER BY acquired_at ASC')
      .all() as WorkdirLockRow[]
    return rows.map(toRecord)
  }
}

/** 单条锁的陈旧判定与回收：规则与 purgeStale 完全一致。 */
function demoteStale(db: Database, workdir: string, identity: BootIdentity): void {
  const row = db.prepare('SELECT * FROM workdir_locks WHERE workdir = ?').get(workdir) as
    | WorkdirLockRow
    | undefined
  if (!row) return
  if (shouldReclaim(row, identity)) {
    db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?').run(
      workdir,
      row.execution_id,
    )
  }
}
