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
      resolve(error.code === 'ENOENT' ? 'absent' : error.code === 'ECONNREFUSED' ? 'absent' : 'unknown')
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
  } catch {
    return false
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

function resolveEntry(role: 'core' | 'daemon'): string {
  // 打包态：Desktop 用 ELECTRON_RUN_AS_NODE 跑 bundle 后的单文件入口。
  const selfDir = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.resolve(selfDir, role === 'core' ? '../index.js' : '../daemon/index.js')
  if (fs.existsSync(bundled)) return bundled
  // 源码态：tsx 直接跑 src/index.ts。
  const src = path.resolve(selfDir, role === 'core' ? 'index.ts' : `../../daemon/src/index.ts`)
  if (fs.existsSync(src)) return src
  throw new Error(`cannot locate ${role} entry (tried ${bundled} and ${src})`)
}

export type LaunchResult = { spawned: boolean; state: ProbeState }

/**
 * 确保 daemon 存活：探活优先，已有实例则附着（不重复拉起）。
 * spawn 用参数数组 + detached + unref，日志重定向到文件，避免管道挂死。
 */
export async function ensureDaemon(paths: AgentraPaths, env: NodeJS.ProcessEnv = process.env, execArgv: string[] = []): Promise<LaunchResult> {
  const state = await probeSocket(paths.daemonSocket)
  if (state === 'live') return { spawned: false, state }
  if (state === 'unknown') throw new Error(`cannot tell whether daemon socket ${paths.daemonSocket} is in use; refusing to proceed`)

  // absent：pid 还活着说明正在启动中，有限等待。
  if (pidAlive(paths.daemonPid)) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      if ((await probeSocket(paths.daemonSocket)) === 'live') return { spawned: false, state: 'live' }
      if (!pidAlive(paths.daemonPid)) break
    }
  }

  cleanStaleFiles(paths, 'daemon')
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const logFd = fs.openSync(paths.daemonLog, 'a')
  const entry = resolveEntry('daemon')
  const child = spawn(process.execPath, [...execArgv, entry], {
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
      throw new Error(`daemon exited immediately with code ${child.exitCode}; see ${paths.daemonLog}`)
    }
  }
  throw new Error(`daemon did not become live within 15s; see ${paths.daemonLog}`)
}

export { CORE_ENTRY_BUNDLED }
