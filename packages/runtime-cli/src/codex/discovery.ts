import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeInfo } from '@agentra/runtime-sdk'
import { type CommandResult, runCommand } from '../run-command'
import { CODEX_CAPABILITIES, CODEX_PROVIDER_ID, CODEX_PROVIDER_NAME } from './capabilities'

export type RunCommand = typeof runCommand

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  run?: RunCommand
}

const HINT_INSTALL =
  'Codex CLI 未找到。请安装 Codex 并将 codex 加入 PATH，或设置 AGENTRA_CODEX_PATH 指向可执行文件。'

function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicit = env.AGENTRA_CODEX_PATH
  if (explicit && isExecutableFile(explicit)) return path.resolve(explicit)
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'codex')),
    path.join(homeDir, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return path.resolve(candidate)
  }
  return null
}

export function parseVersion(stdout: string): string | null {
  const match = stdout.trim().match(/v?(\d+\.\d+\.\d+\S*)/)
  return match?.[1] ?? null
}

export async function discoverCodex(options: DiscoveryOptions = {}): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const run = options.run ?? runCommand
  const discoveredAt = new Date().toISOString()
  const base = {
    providerId: CODEX_PROVIDER_ID,
    providerType: 'cli' as const,
    providerName: CODEX_PROVIDER_NAME,
    capabilities: CODEX_CAPABILITIES,
    discoveredAt,
  }
  const executablePath = findCodexExecutable(env, homeDir)
  if (!executablePath) {
    return {
      ...base,
      executablePath: null,
      version: null,
      healthStatus: 'unavailable',
      healthDetail: HINT_INSTALL,
      authMethod: null,
    }
  }
  let versionResult: CommandResult
  try {
    versionResult = await run(executablePath, ['--version'], { env, timeoutMs: 5000 })
  } catch (error) {
    return {
      ...base,
      executablePath,
      version: null,
      healthStatus: 'unavailable',
      healthDetail: `Codex CLI 无法执行：${error instanceof Error ? error.message : String(error)}`,
      authMethod: null,
    }
  }
  const version = parseVersion(versionResult.stdout)
  if (versionResult.code !== 0 || !version) {
    return {
      ...base,
      executablePath,
      version,
      healthStatus: 'unavailable',
      healthDetail: 'Codex CLI 已找到，但 --version 执行失败。',
      authMethod: null,
    }
  }
  return {
    ...base,
    executablePath,
    version,
    healthStatus: 'healthy',
    healthDetail: 'Codex CLI 已安装；认证状态在首次执行时校验。',
    authMethod: null,
  }
}
