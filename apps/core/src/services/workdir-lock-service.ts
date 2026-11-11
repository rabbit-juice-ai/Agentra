import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { RpcMethodError } from '@agentra/protocol'
import type { Database } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'

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
  holderStartedAt: string | null
  holderKind: 'core' | 'cli' | null
  bootUuid: string | null
  acquiredAt: string
}

export type WorkdirLockRow = {
  workdir: string
  execution_id: string
  work_id: string | null
  holder_pid: number
  holder_started_at: string | null
  holder_kind: string | null
  boot_uuid: string | null
  acquired_at: string
}

function toRecord(row: WorkdirLockRow): WorkdirLockRecord {
  return {
    workdir: row.workdir,
    executionId: row.execution_id,
    workId: row.work_id,
    holderPid: row.holder_pid,
    holderStartedAt: row.holder_started_at,
    holderKind: row.holder_kind === 'core' || row.holder_kind === 'cli' ? row.holder_kind : null,
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
type ExecutionProbe = { status: string; processId: number | null }

function readExecutionProbe(db: Database, executionId: string): ExecutionProbe | null {
  const row = db
    .prepare('SELECT status, process_id FROM executions WHERE id = ?')
    .get(executionId) as { status: string; process_id: number | null } | undefined
  return row ? { status: row.status, processId: row.process_id } : null
}

function isTerminalExecution(status: string): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'crashed'
  )
}

/** macOS 进程启动标识；读取失败返回 null，调用方必须 fail closed。 */
export function processStartedAt(
  pid: number,
  run: (args: string[]) => string = (args) =>
    execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 2000 }).trim(),
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const text = run(['-o', 'lstart=', '-p', String(pid)]).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

type LockDecision =
  | { action: 'reclaim'; reason: string }
  | { action: 'retain'; reason: string }
  | { action: 'manual_review'; reason: string }

/**
 * P0：purgeStale 的判定顺序固定为 Execution → CLI 身份 → Boot UUID 辅助。
 * Boot UUID 不能单独证明锁可回收；CLI 仍存活或身份不可确认时必须保留。
 */
export function decideLockReclaim(
  db: Database,
  row: WorkdirLockRow,
  options: {
    identity: BootIdentity
    isAlive?: (pid: number) => boolean
    startedAt?: (pid: number) => string | null
  },
): LockDecision {
  const execution = readExecutionProbe(db, row.execution_id)
  if (!execution) {
    return { action: 'manual_review', reason: 'EXECUTION_MISSING' }
  }

  const isAlive = options.isAlive ?? isProcessAlive
  const startedAt = options.startedAt ?? processStartedAt
  const recordedStart = row.holder_started_at
  const cliPid = execution.processId ?? row.holder_pid
  const alive = isAlive(cliPid)
  const currentStart = alive ? startedAt(cliPid) : null

  // 有启动标识时，PID 相同但标识不同 => PID 被复用，不是原进程。
  const identityMismatch =
    alive && recordedStart !== null && currentStart !== null && recordedStart !== currentStart
  const identityUnknown = alive && recordedStart === null
  const processGone = !alive || identityMismatch

  if (!processGone) {
    if (identityUnknown) {
      return { action: 'manual_review', reason: 'PROCESS_IDENTITY_UNKNOWN' }
    }
    return { action: 'retain', reason: 'CLI_ALIVE' }
  }

  if (!isTerminalExecution(execution.status)) {
    // CLI 已退出但 Execution 尚未终态：先交给 Execution 对账，不能回收。
    return { action: 'retain', reason: 'EXECUTION_NOT_TERMINAL' }
  }

  if (recordedStart === null && row.holder_kind !== 'core') {
    return { action: 'manual_review', reason: 'PROCESS_IDENTITY_UNKNOWN' }
  }

  // Boot UUID 只作为附加证据；到这里已确认进程退出且 Execution 终态。
  return { action: 'reclaim', reason: 'CLI_EXITED_EXECUTION_TERMINAL' }
}

function resolveLockKey(workdirInput: string): string {
  const absolute = path.resolve(workdirInput)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    // 目录尚未创建（普通执行在锁之后才 mkdir）：规范化父目录，保持 key 稳定。
    try {
      return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

/**
 * 工作目录锁（DATABASE 之外运行态，落在 workdir_locks）。
 *
 * 键是规范化后的真实路径；普通执行目录尚不存在时退化为绝对路径。
 * 回收策略：先看 Execution 状态，再看 CLI/Core 进程身份，Boot UUID 只作辅助证据。
 */
export class WorkdirLockService {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly holderPid: number = process.pid,
    readonly identity: BootIdentity = currentBootUuid(),
    private readonly audit?: Pick<AuditRepository, 'append'>,
  ) {}

  private record(
    action: string,
    workdir: string,
    executionId: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.audit?.append({
        actorType: 'system',
        actorId: 'agentra',
        action,
        targetType: 'workdir_lock',
        targetId: workdir,
        details: { executionId, ...details },
        now: this.now(),
      })
    } catch {
      // 审计失败不改变锁语义。
    }
  }

  private get bootUuid(): string | null {
    return this.identity.status === 'known' ? this.identity.uuid : null
  }

  acquire(
    workdirInput: string,
    executionId: string,
    workId: string | null,
    holder: { pid?: number; startedAt?: string | null; kind?: 'core' | 'cli' } = {},
  ): WorkdirLockRecord {
    const workdir = resolveLockKey(workdirInput)

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

    const holderPid = holder.pid ?? this.holderPid
    const holderStartedAt =
      holder.startedAt === undefined ? processStartedAt(holderPid) : holder.startedAt
    const holderKind = holder.kind ?? 'core'

    try {
      this.db
        .prepare(
          `INSERT INTO workdir_locks (
             workdir, execution_id, work_id, holder_pid, holder_started_at, holder_kind,
             boot_uuid, acquired_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workdir,
          executionId,
          workId,
          holderPid,
          holderStartedAt,
          holderKind,
          this.bootUuid,
          this.now(),
        )
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
    this.record('workdir.lock_acquired', workdir, executionId, {
      holderPid: created.holderPid,
      holderStartedAt: created.holderStartedAt,
      holderKind: created.holderKind,
    })
    return created
  }

  /** spawn 后把锁 holder 从 Core 转移到 CLI；只更新同一执行的行。 */
  updateHolderPid(
    workdirInput: string,
    executionId: string,
    cliPid: number,
    cliStartedAt: string | null = processStartedAt(cliPid),
  ): boolean {
    const workdir = resolveLockKey(workdirInput)
    const result = this.db
      .prepare(
        `UPDATE workdir_locks
         SET holder_pid = ?, holder_started_at = ?, holder_kind = 'cli'
         WHERE workdir = ? AND execution_id = ?`,
      )
      .run(cliPid, cliStartedAt, workdir, executionId)
    const changed = Number(result.changes) > 0
    if (changed) {
      this.record('workdir.lock_holder_transferred', workdir, executionId, {
        holderPid: cliPid,
        holderStartedAt: cliStartedAt,
      })
    }
    return changed
  }

  /** 释放该执行持有的全部锁（一个执行只持有一把，按 execution 删更稳）。 */
  releaseByExecution(executionId: string): number {
    const locks = this.list().filter((lock) => lock.executionId === executionId)
    const result = this.db
      .prepare('DELETE FROM workdir_locks WHERE execution_id = ?')
      .run(executionId)
    const changes = Number(result.changes)
    if (changes > 0) {
      for (const lock of locks) this.record('workdir.lock_released', lock.workdir, executionId, {})
    }
    return changes
  }

  /** S55-2B-1B：该执行当前持有的锁数量（终态补偿 S4 验证用）。 */
  countByExecution(executionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM workdir_locks WHERE execution_id = ?')
      .get(executionId) as { c: number }
    return row.c
  }

  release(workdirInput: string, executionId: string): boolean {
    const workdir = resolveLockKey(workdirInput)
    const result = this.db
      .prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
      .run(workdir, executionId)
    return Number(result.changes) > 0
  }

  /** 回收陈旧锁；Core 启动时调用一次。Boot UUID 不再单独决定回收。 */
  purgeStale(): PurgeResult {
    const rows = this.db.prepare('SELECT * FROM workdir_locks').all() as WorkdirLockRow[]
    const del = this.db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?')
    let reclaimed = 0
    for (const row of rows) {
      const decision = decideLockReclaim(this.db, row, { identity: this.identity })
      if (decision.action === 'reclaim') {
        const changes = Number(del.run(row.workdir, row.execution_id).changes)
        reclaimed += changes
        if (changes > 0)
          this.record('workdir.lock_reclaimed', row.workdir, row.execution_id, {
            reason: decision.reason,
          })
        continue
      }
      this.record(
        decision.action === 'manual_review'
          ? 'workdir.lock_manual_review'
          : 'workdir.lock_retained_alive',
        row.workdir,
        row.execution_id,
        { reason: decision.reason },
      )
    }
    return { reclaimed, retained: rows.length - reclaimed, identity: this.identity }
  }

  /** 单条锁是否可按陈旧回收（PurgeResult 同一规则）。 */
  isStale(row: WorkdirLockRow): boolean {
    return decideLockReclaim(this.db, row, { identity: this.identity }).action === 'reclaim'
  }

  get(workdirInput: string): WorkdirLockRecord | null {
    const workdir = resolveLockKey(workdirInput)
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
  if (decideLockReclaim(db, row, { identity }).action === 'reclaim') {
    db.prepare('DELETE FROM workdir_locks WHERE workdir = ? AND execution_id = ?').run(
      workdir,
      row.execution_id,
    )
  }
}
