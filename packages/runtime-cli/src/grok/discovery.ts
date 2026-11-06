import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeInfo } from '@agentra/runtime-sdk'
import { type CommandResult, runCommand } from '../run-command'
import { GROK_CAPABILITIES, GROK_PROVIDER_ID, GROK_PROVIDER_NAME } from './capabilities'

export type RunCommand = typeof runCommand

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  run?: RunCommand
}

const HINT_INSTALL =
  'Grok CLI 未找到。请安装 Grok CLI 并将 grok 加入 PATH，或设置 AGENTRA_GROK_PATH。'
const HINT_LOGIN =
  'Grok CLI 未登录。请在终端执行 `grok login`（或 `grok login --device-code`），或设置 XAI_API_KEY。'

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

export function findGrokExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicit = env.AGENTRA_GROK_PATH
  if (explicit && isExecutableFile(explicit)) return path.resolve(explicit)
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'grok')),
    path.join(homeDir, '.grok', 'bin', 'grok'),
    path.join(homeDir, '.local', 'bin', 'grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
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

export async function discoverGrok(options: DiscoveryOptions = {}): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const run = options.run ?? runCommand
  const discoveredAt = new Date().toISOString()
  const base = {
    providerId: GROK_PROVIDER_ID,
    providerType: 'cli' as const,
    providerName: GROK_PROVIDER_NAME,
    capabilities: GROK_CAPABILITIES,
    discoveredAt,
  }
  const executablePath = findGrokExecutable(env, homeDir)
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
      healthDetail: `Grok CLI 无法执行：${error instanceof Error ? error.message : String(error)}`,
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
      healthDetail: 'Grok CLI 已找到，但 --version 执行失败。',
      authMethod: null,
    }
  }
  // `grok models` 是本地认证探测；未登录时 stdout 明确包含 not authenticated。
  let authResult: CommandResult | null = null
  try {
    authResult = await run(executablePath, ['models'], { env, timeoutMs: 5000 })
  } catch {
    // 探测失败不阻断发现；按已安装但认证未知处理。
  }
  if (authResult && /not authenticated/i.test(authResult.stdout)) {
    return {
      ...base,
      executablePath,
      version,
      healthStatus: 'unauthenticated',
      healthDetail: HINT_LOGIN,
      authMethod: null,
    }
  }
  return {
    ...base,
    executablePath,
    version,
    healthStatus: 'healthy',
    healthDetail: 'Grok CLI 已安装并已认证。',
    authMethod: null,
  }
}
