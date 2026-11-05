import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

/**
 * S55-2B-1B：Core 单实例 boot lock（macOS O_EXLOCK / BSD flock）。
 *
 * 唯一性由内核保证：同一 inode 至多一个 open file description 持有 LOCK_EX。
 * - 获取线性化点：open(2) 携带 O_EXLOCK 的原子加锁；
 * - 进程崩溃（含 SIGKILL）：内核关闭全部 fd，锁自动释放，不存在陈旧锁；
 * - 所有权与 pid / 文件内容无关：pid 仅作诊断字段，不存在 PID 复用误判；
 * - 释放：close(fd) 只释放自己持有的锁；**文件永不 unlink**（unlink+重建会让
 *   新旧 inode 分属两个锁域，产生分裂脑）。
 *
 * 平台约束：O_EXLOCK 是 Darwin 常量（sys/fcntl.h: 0x00000020），Node 的
 * fs.constants 未导出，故以数值 flags 直通 open(2)；非 darwin 或文件系统不支持
 * flock（ENOTSUP/EOPNOTSUPP/ENOLCK）时 fail closed，绝不静默降级。
 */

const O_EXLOCK_DARWIN = 0x20

export type BootLockOwner = {
  pid: number
  startedAt: string
  ownerToken: string
  bootUuid: string | null
  protocolVersion: string
}

export type BootLockFailureCode = 'BOOT_LOCK_HELD' | 'BOOT_LOCK_UNSUPPORTED' | 'BOOT_LOCK_IO'

export class BootLockError extends Error {
  constructor(
    readonly code: BootLockFailureCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BootLockError'
  }
}

export class BootLock {
  private fd: number | null = null
  private ownerValue: BootLockOwner | null = null

  constructor(private readonly lockPath: string) {}

  get held(): boolean {
    return this.fd !== null
  }

  get owner(): BootLockOwner | null {
    return this.ownerValue
  }

  /**
   * 获取锁。已被活进程持有时抛 BOOT_LOCK_HELD（携带对方诊断信息）。
   * 成功后文件内容被覆写为本进程的诊断信息；文件本身永不删除。
   */
  acquire(input: {
    startedAt: string
    bootUuid?: string | null
    protocolVersion: string
  }): BootLockOwner {
    if (process.platform !== 'darwin') {
      throw new BootLockError(
        'BOOT_LOCK_UNSUPPORTED',
        `O_EXLOCK boot lock is only supported on darwin (current: ${process.platform})`,
      )
    }
    if (this.fd !== null) {
      throw new BootLockError('BOOT_LOCK_IO', 'boot lock already held by this process')
    }

    const flags =
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_NONBLOCK |
      fs.constants.O_NOFOLLOW |
      O_EXLOCK_DARWIN

    let fd: number
    try {
      fd = fs.openSync(this.lockPath, flags, 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        // 诊断读取：对方可能正在写内容，解析失败只降级为 null，不影响拒绝启动。
        const existing = this.readOwner()
        throw new BootLockError('BOOT_LOCK_HELD', `another Core holds the boot lock: ${code}`, {
          lockPath: this.lockPath,
          existingOwner: existing,
        })
      }
      if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOLCK') {
        throw new BootLockError(
          'BOOT_LOCK_UNSUPPORTED',
          `filesystem does not support flock (${code}): ${this.lockPath}`,
          { code },
        )
      }
      throw new BootLockError('BOOT_LOCK_IO', `boot lock open failed: ${code}`, { code })
    }

    const owner: BootLockOwner = {
      pid: process.pid,
      startedAt: input.startedAt,
      ownerToken: randomUUID(),
      bootUuid: input.bootUuid ?? null,
      protocolVersion: input.protocolVersion,
    }
    try {
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, JSON.stringify(owner))
    } catch (error) {
      // 写入诊断内容失败不影响锁本身；关闭 fd 释放锁后按 IO 错误失败（fail closed）。
      try {
        fs.closeSync(fd)
      } catch {
        // 关闭失败不掩盖原始错误。
      }
      throw new BootLockError('BOOT_LOCK_IO', `boot lock write failed: ${String(error)}`)
    }
    this.fd = fd
    this.ownerValue = owner
    return owner
  }

  /** 读取当前锁文件内容（诊断用；损坏/缺失返回 null）。 */
  readOwner(): BootLockOwner | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<BootLockOwner>
      if (typeof parsed.pid !== 'number' || typeof parsed.ownerToken !== 'string') return null
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
        ownerToken: parsed.ownerToken,
        bootUuid: typeof parsed.bootUuid === 'string' ? parsed.bootUuid : null,
        protocolVersion:
          typeof parsed.protocolVersion === 'string' ? parsed.protocolVersion : 'unknown',
      }
    } catch {
      return null
    }
  }

  /** 释放锁：只 close 自己的 fd；绝不 unlink 锁文件。幂等。 */
  release(): void {
    if (this.fd === null) return
    const fd = this.fd
    this.fd = null
    this.ownerValue = null
    fs.closeSync(fd)
  }
}
