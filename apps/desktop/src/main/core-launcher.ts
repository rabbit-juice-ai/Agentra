import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentraPaths, type AgentraPaths } from '@agentra/shared'
import { probeSocket, pidAlive } from './probe'

const START_WAIT_MS = 15_000

function resolveCoreEntry(paths: AgentraPaths): string {
  // 打包态：resources/core/index.js（esbuild bundle 产物，随应用分发）。
  // 源码态：仓库内 apps/core/dist/index.js，或 tsx 跑 src。
  const selfDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(selfDir, '../../core/dist/index.js'),
    path.resolve(selfDir, '../../../../apps/core/dist/index.js'),
    path.resolve(selfDir, '../../../../apps/core/src/index.ts'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`cannot locate core entry; tried:\n${candidates.join('\n')}`)
}

/**
 * 确保 Core 存活：探活优先（附着），absent 才拉起。
 * detached + unref：Desktop 退出不终止 Core（架构验收核心行为）。
 */
export async function ensureCore(paths: AgentraPaths = agentraPaths()): Promise<void> {
  const state = await probeSocket(paths.coreSocket)
  if (state === 'live') return
  if (state === 'unknown') throw new Error(`cannot tell whether core socket ${paths.coreSocket} is in use; refusing to proceed`)

  if (pidAlive(paths.corePid)) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      if ((await probeSocket(paths.coreSocket)) === 'live') return
      if (!pidAlive(paths.corePid)) break
    }
  }

  // 清理陈旧 socket/pid（absent 才走到这里）。
  try {
    fs.unlinkSync(paths.coreSocket)
  } catch {
    // 忽略。
  }

  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const entry = resolveCoreEntry(paths)
  const logFd = fs.openSync(paths.coreLog, 'a')
  const isTs = entry.endsWith('.ts')
  const args = isTs
    ? ['--import', 'tsx', entry]
    : [entry]
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      // Electron 二进制当 Node 用（与内置 Node 版本一致，不依赖用户 PATH）。
      ELECTRON_RUN_AS_NODE: '1',
      AGENTRA_ROLE: 'core',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)

  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if ((await probeSocket(paths.coreSocket)) === 'live') return
  }
  throw new Error(`core did not become live within ${START_WAIT_MS / 1000}s; see ${paths.coreLog}`)
}
