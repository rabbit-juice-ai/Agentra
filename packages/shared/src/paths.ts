import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 数据根目录：默认家目录（内建盘），支持 AGENTRA_DATA_DIR 覆盖（测试隔离）。
 * 运行状态与数据库绝不放外置项目盘：断盘不影响运行中的 Core/Daemon。
 */
export function agentraHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return env.AGENTRA_DATA_DIR
    ? path.resolve(env.AGENTRA_DATA_DIR)
    : path.join(homeDir, 'Library', 'Application Support', 'agentra')
}

// macOS sun_path 上限 104 字节，留余量。
export const MAX_SOCKET_PATH_BYTES = 90

export type AgentraPaths = {
  home: string
  runtime: string
  logs: string
  scratch: string
  worktrees: string
  database: string
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
  const scratch = path.join(home, 'scratch')
  const worktrees = path.join(home, 'worktrees')
  const coreSocket = path.join(runtime, 'core.sock')
  const daemonSocket = path.join(runtime, 'daemon.sock')
  assertSocketPathLength(coreSocket)
  assertSocketPathLength(daemonSocket)
  return {
    home,
    runtime,
    logs,
    scratch,
    worktrees,
    database: path.join(home, 'agentra.db'),
    coreSocket,
    daemonSocket,
    corePid: path.join(runtime, 'core.pid'),
    daemonPid: path.join(runtime, 'daemon.pid'),
    coreLog: path.join(logs, 'core.log'),
    daemonLog: path.join(logs, 'daemon.log'),
  }
}

/** 确保目录存在（runtime/logs/scratch，权限 0700）。 */
export function ensureDirs(paths: AgentraPaths): void {
  for (const dir of [paths.home, paths.runtime, paths.logs, paths.scratch, paths.worktrees]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

/** 执行 ID 白名单：仅允许生成器产出的安全字符，杜绝路径穿越。 */
const EXECUTION_ID_PATTERN = /^exe-[0-9a-f-]{36}$/

/**
 * 阶段 1 执行工作目录：<data>/scratch/<executionId>。
 * 无 Work 工作区，绝不写用户项目目录；返回前做规范化与边界检查。
 */
export function executionScratchDir(scratchRoot: string, executionId: string): string {
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new Error(`invalid execution id for scratch directory: ${executionId}`)
  }
  const root = path.resolve(scratchRoot)
  const dir = path.resolve(root, executionId)
  if (dir !== path.join(root, executionId) || !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error(`scratch directory escapes scratch root: ${dir}`)
  }
  return dir
}
