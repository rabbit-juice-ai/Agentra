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
  artifacts: string
  backups: string
  /** S55-2C：Restore 事务根目录（active Journal / staged / rollback / archive）。 */
  restore: string
  restoreActiveMarker: string
  restoreJournalA: string
  restoreJournalB: string
  restoreArchive: string
  restoreRetired: string
  restoreCapturedRollback: string
  restoreForwardStaged: string
  restoreRollbackStaged: string
  database: string
  coreSocket: string
  /** S55-2B-1B：最小 health/status socket（booting/recovering 期间唯一可用入口）。 */
  coreBootSocket: string
  /** S55-2B-1B：Core 单实例 boot lock（O_EXLOCK 文件，永久存在，不 unlink）。 */
  coreLock: string
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
  const artifacts = path.join(home, 'artifacts')
  const backups = path.join(home, 'backups')
  const restore = path.join(home, 'restore')
  const coreSocket = path.join(runtime, 'core.sock')
  // S55-2B-1B：最小 health/status socket。文件名取 boot.sock（而非 core-boot.sock）：
  // sun_path 预算 90 字节，测试/长数据根路径下 core-boot.sock 会超限。
  const coreBootSocket = path.join(runtime, 'boot.sock')
  const daemonSocket = path.join(runtime, 'daemon.sock')
  assertSocketPathLength(coreSocket)
  assertSocketPathLength(coreBootSocket)
  assertSocketPathLength(daemonSocket)
  return {
    home,
    runtime,
    logs,
    scratch,
    worktrees,
    artifacts,
    backups,
    restore,
    restoreActiveMarker: path.join(restore, 'active'),
    restoreJournalA: path.join(restore, 'journal.a.json'),
    restoreJournalB: path.join(restore, 'journal.b.json'),
    restoreArchive: path.join(restore, 'archive'),
    restoreRetired: path.join(restore, 'retired'),
    restoreCapturedRollback: path.join(restore, 'rollback'),
    restoreForwardStaged: path.join(restore, 'staged'),
    restoreRollbackStaged: path.join(restore, 'rollback-staged'),
    database: path.join(home, 'agentra.db'),
    coreSocket,
    coreBootSocket,
    coreLock: path.join(runtime, 'core.lock'),
    daemonSocket,
    corePid: path.join(runtime, 'core.pid'),
    daemonPid: path.join(runtime, 'daemon.pid'),
    coreLog: path.join(logs, 'core.log'),
    daemonLog: path.join(logs, 'daemon.log'),
  }
}

/** 确保目录存在（runtime/logs/scratch，权限 0700）。 */
export function ensureDirs(paths: AgentraPaths): void {
  for (const dir of [
    paths.home,
    paths.runtime,
    paths.logs,
    paths.scratch,
    paths.worktrees,
    paths.artifacts,
    paths.backups,
    // S55-2C：只创建 Restore 根目录；active marker / Journal / staged 子目录由
    // Restore 协议按 durable-intent 顺序创建，不能由通用 ensureDirs 预先伪造。
    paths.restore,
  ]) {
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
