import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 数据根目录：默认家目录（内建盘），支持 AGENTRA_DATA_DIR 覆盖（测试隔离）。
 * 运行状态与数据库绝不放外置项目盘：断盘不影响运行中的 Core/Daemon。
 */
export function agentraHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return env.AGENTRA_DATA_DIR ? path.resolve(env.AGENTRA_DATA_DIR) : path.join(homeDir, 'Library', 'Application Support', 'agentra')
}

// macOS sun_path 上限 104 字节，留余量。
export const MAX_SOCKET_PATH_BYTES = 90

export type AgentraPaths = {
  home: string
  runtime: string
  logs: string
  coreSocket: string
  daemonSocket: string
  corePid: string
  daemonPid: string
  coreLog: string
  daemonLog: string
}

function assertSocketPathLength(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes (${Buffer.byteLength(socketPath)}): ${socketPath}; ` +
        `set AGENTRA_DATA_DIR to a shorter path`,
    )
  }
}

export function agentraPaths(home: string = agentraHome()): AgentraPaths {
  const runtime = path.join(home, 'runtime')
  const logs = path.join(home, 'logs')
  const coreSocket = path.join(runtime, 'core.sock')
  const daemonSocket = path.join(runtime, 'daemon.sock')
  assertSocketPathLength(coreSocket)
  assertSocketPathLength(daemonSocket)
  return {
    home,
    runtime,
    logs,
    coreSocket,
    daemonSocket,
    corePid: path.join(runtime, 'core.pid'),
    daemonPid: path.join(runtime, 'daemon.pid'),
    coreLog: path.join(logs, 'core.log'),
    daemonLog: path.join(logs, 'daemon.log'),
  }
}

/** 确保目录存在（runtime/logs，权限 0700）。 */
export function ensureDirs(paths: AgentraPaths): void {
  for (const dir of [paths.home, paths.runtime, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}
