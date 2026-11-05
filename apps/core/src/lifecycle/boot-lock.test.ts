import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BootLock, BootLockError } from './boot-lock'

const MODULE_URL = new URL('./boot-lock.ts', import.meta.url).href
const dirs: string[] = []
const children: ChildProcess[] = []

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-bootlock-'))
  dirs.push(dir)
  return path.join(dir, 'core.lock')
}

function cleanup(): void {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出。
      }
    }
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

afterEach(cleanup)

const CHILD_SCRIPT = `
const { BootLock } = await import(process.env.BOOT_LOCK_MODULE)
const lock = new BootLock(process.env.BOOT_LOCK_PATH)
try {
  const owner = lock.acquire({
    startedAt: new Date().toISOString(),
    protocolVersion: '1',
  })
  process.stdout.write(JSON.stringify({ ok: true, pid: owner.pid, token: owner.ownerToken }) + '\\n')
  const holdMs = Number(process.env.HOLD_MS || '0')
  if (holdMs > 0) setTimeout(() => process.exit(0), holdMs)
  else process.exit(0)
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\\n')
  process.exit(0)
}
`

function spawnLocker(
  lockPath: string,
  options: { holdMs?: number } = {},
): Promise<{ ok: boolean; code?: string; pid?: number; token?: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', CHILD_SCRIPT],
    {
      env: {
        ...process.env,
        BOOT_LOCK_MODULE: MODULE_URL,
        BOOT_LOCK_PATH: lockPath,
        HOLD_MS: String(options.holdMs ?? 0),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('child lock attempt timed out')), 15_000)
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      const line = buffer.split('\n')[0]
      if (!line) return
      clearTimeout(timer)
      resolve({ ...(JSON.parse(line) as { ok: boolean }), child })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('BootLock (O_EXLOCK)', () => {
  it('acquires, releases by close, and never unlinks the lock file', () => {
    const lockPath = tempLockPath()
    const lock = new BootLock(lockPath)
    const owner = lock.acquire({ startedAt: '2026-11-03T00:00:00.000Z', protocolVersion: '1' })
    expect(lock.held).toBe(true)
    expect(owner.pid).toBe(process.pid)
    expect(fs.existsSync(lockPath)).toBe(true)

    lock.release()
    expect(lock.held).toBe(false)
    // 锁文件永久存在（不 unlink），内容保留诊断信息。
    expect(fs.existsSync(lockPath)).toBe(true)

    const again = new BootLock(lockPath)
    again.acquire({ startedAt: '2026-11-03T00:00:01.000Z', protocolVersion: '1' })
    again.release()
  })

  it('refuses a second acquisition in the same process with diagnostics', () => {
    const lockPath = tempLockPath()
    const first = new BootLock(lockPath)
    const owner = first.acquire({ startedAt: '2026-11-03T00:00:00.000Z', protocolVersion: '1' })

    const second = new BootLock(lockPath)
    let caught: unknown
    try {
      second.acquire({ startedAt: '2026-11-03T00:00:01.000Z', protocolVersion: '1' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BootLockError)
    expect((caught as BootLockError).code).toBe('BOOT_LOCK_HELD')
    const detail = (caught as BootLockError).detail as { existingOwner?: { pid: number } }
    expect(detail.existingOwner?.pid).toBe(owner.pid)
    first.release()
  })

  it('refuses while another real process holds the lock; acquires after SIGKILL', async () => {
    const lockPath = tempLockPath()
    const child = await spawnLocker(lockPath, { holdMs: 60_000 })
    expect(child.ok).toBe(true)

    const lock = new BootLock(lockPath)
    expect(() =>
      lock.acquire({ startedAt: '2026-11-03T00:00:00.000Z', protocolVersion: '1' }),
    ).toThrow(BootLockError)

    // 失败获取方不得修改/删除锁（文件内容仍是子进程的 token）。
    const before = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { ownerToken: string }
    expect(before.ownerToken).toBe(child.token)

    child.child.kill('SIGKILL')
    await new Promise((resolve) => child.child.once('exit', resolve))

    // 内核在进程死亡时自动释放 flock：立即可获取（无陈旧锁接管逻辑）。
    lock.acquire({ startedAt: '2026-11-03T00:00:02.000Z', protocolVersion: '1' })
    expect(lock.held).toBe(true)
    lock.release()
  })

  it('lets exactly one of two racing processes win', async () => {
    const lockPath = tempLockPath()
    const [a, b] = await Promise.all([
      spawnLocker(lockPath, { holdMs: 500 }),
      spawnLocker(lockPath, { holdMs: 500 }),
    ])
    const successes = [a, b].filter((result) => result.ok)
    expect(successes).toHaveLength(1)
    const failure = [a, b].find((result) => !result.ok)
    expect(failure?.code).toBe('BOOT_LOCK_HELD')
  })

  it('treats corrupt lock content as diagnostics-only (flock still authoritative)', async () => {
    const lockPath = tempLockPath()
    fs.writeFileSync(lockPath, '{corrupt')

    // 无持有者：获取成功并覆写损坏内容。
    const lock = new BootLock(lockPath)
    lock.acquire({ startedAt: '2026-11-03T00:00:00.000Z', protocolVersion: '1' })
    const owner = lock.readOwner()
    expect(owner?.pid).toBe(process.pid)
    lock.release()

    // 有持有者 + 损坏内容：仍拒绝启动，诊断信息降级为 null。
    const child = await spawnLocker(lockPath, { holdMs: 60_000 })
    expect(child.ok).toBe(true)
    fs.writeFileSync(lockPath, '{corrupt-again')
    const second = new BootLock(lockPath)
    let caught: unknown
    try {
      second.acquire({ startedAt: '2026-11-03T00:00:01.000Z', protocolVersion: '1' })
    } catch (error) {
      caught = error
    }
    expect((caught as BootLockError).code).toBe('BOOT_LOCK_HELD')
    expect((caught as BootLockError).detail).toMatchObject({ existingOwner: null })
    child.child.kill('SIGKILL')
    await new Promise((resolve) => child.child.once('exit', resolve))
  })
})
