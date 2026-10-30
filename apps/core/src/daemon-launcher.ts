import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentraPaths } from '@agentra/shared'

export type ProbeState = 'live' | 'starting' | 'absent' | 'unknown'

/** 探测 UDS：连接成功即 live；拒绝/不存在才可判定；超时说明不了什么。 */
export function probeSocket(socketPath: string, timeoutMs = 1500): Promise<ProbeState> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('unknown')
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve('live')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(
        error.code === 'ENOENT' ? 'absent' : error.code === 'ECONNREFUSED' ? 'absent' : 'unknown',
      )
    })
  })
}

/** pid 文件探活：进程存活且是当年写文件的进程。 */
export function pidAlive(pidFile: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid?: number }
    if (typeof raw.pid !== 'number') return false
    process.kill(raw.pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但当前用户无权发信号（如 pid 1）；只有 ESRCH/读文件失败才算不存在。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function cleanStaleFiles(paths: AgentraPaths, role: 'core' | 'daemon'): void {
  const socketPath = role === 'core' ? paths.coreSocket : paths.daemonSocket
  const pidFile = role === 'core' ? paths.corePid : paths.daemonPid
  for (const file of [socketPath, pidFile]) {
    try {
      fs.unlinkSync(file)
    } catch {
      // 不存在即目标状态。
    }
  }
}

const CORE_ENTRY_BUNDLED = path.join('apps', 'core', 'dist', 'index.js')

/**
 * 定位 daemon 入口。
 *
 * 三种布局，按优先级：
 * 1. 打包态：daemon 与 core 同目录（`resources/core/index.js` ↔ `resources/daemon/index.js`）。
 * 2. 仓库态且 Core 从构建产物运行（`apps/core/dist/index.js`）：用 `apps/daemon/dist/index.js`。
 * 3. 仓库态且 Core 从源码运行（tsx 跑 `apps/core/src/index.ts`）：用 `apps/daemon/src/index.ts`。
 *
 * 之前只找 `apps/core/daemon/index.js`（该目录不存在），导致永远回退到 src；
 * 打包态 `src/` 不随包发布，回退会直接抛错，应用起不来。
 */
function resolveEntry(role: 'core' | 'daemon'): string {
  const selfFile = fileURLToPath(import.meta.url)
  const selfDir = path.dirname(selfFile)
  const fromSource = path.extname(selfFile) === '.ts'

  if (role === 'core') {
    const bundledCore = path.resolve(selfDir, '../index.js')
    if (fs.existsSync(bundledCore)) return bundledCore
    const srcCore = path.resolve(selfDir, 'index.ts')
    if (fs.existsSync(srcCore)) return srcCore
    throw new Error(`cannot locate core entry (tried ${bundledCore} and ${srcCore})`)
  }

  const packaged = path.resolve(selfDir, '../daemon/index.js')
  if (fs.existsSync(packaged)) return packaged

  const repoDist = path.resolve(selfDir, '../../daemon/dist/index.js')
  const repoSrc = path.resolve(selfDir, '../../daemon/src/index.ts')
  const candidates = fromSource ? [repoSrc, repoDist] : [repoDist, repoSrc]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`cannot locate daemon entry (tried ${[packaged, ...candidates].join(', ')})`)
}

export type LaunchResult = { spawned: boolean; state: ProbeState }

/**
 * 确保 daemon 存活：探活优先，已有实例则附着（不重复拉起）。
 * spawn 用参数数组 + detached + unref，日志重定向到文件，避免管道挂死。
 */
export async function ensureDaemon(
  paths: AgentraPaths,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: string[] = [],
): Promise<LaunchResult> {
  const state = await probeSocket(paths.daemonSocket)
  if (state === 'live') return { spawned: false, state }
  if (state === 'unknown')
    throw new Error(
      `cannot tell whether daemon socket ${paths.daemonSocket} is in use; refusing to proceed`,
    )

  // absent：pid 还活着说明正在启动中，有限等待。
  if (pidAlive(paths.daemonPid)) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      if ((await probeSocket(paths.daemonSocket)) === 'live')
        return { spawned: false, state: 'live' }
      if (!pidAlive(paths.daemonPid)) break
    }
  }

  cleanStaleFiles(paths, 'daemon')
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const logFd = fs.openSync(paths.daemonLog, 'a')
  const entry = resolveEntry('daemon')
  // 源码态入口是 .ts：与 Desktop 拉起 Core 一致，用 tsx 加载（Node 原生类型剥离
  // 不支持无扩展名的相对导入，直接 node 跑 .ts 会 ERR_MODULE_NOT_FOUND）。
  const entryArgs = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry]
  const child = spawn(process.execPath, [...execArgv, ...entryArgs], {
    env: { ...env, AGENTRA_ROLE: 'daemon' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if ((await probeSocket(paths.daemonSocket)) === 'live') return { spawned: true, state: 'live' }
    if (child.exitCode !== null && child.pid) {
      // detached+unref 下仍可短暂读取首次退出码，帮助诊断。
      throw new Error(
        `daemon exited immediately with code ${child.exitCode}; see ${paths.daemonLog}`,
      )
    }
  }
  throw new Error(`daemon did not become live within 15s; see ${paths.daemonLog}`)
}

export { CORE_ENTRY_BUNDLED }
