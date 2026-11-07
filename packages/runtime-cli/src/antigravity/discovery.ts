import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeInfo } from '@agentra/runtime-sdk'
import { type CommandResult, runCommand } from '../run-command'
import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
} from './capabilities'

export type RunCommand = typeof runCommand

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  run?: RunCommand
}

const HINT_INSTALL =
  'Antigravity CLI 未找到。请安装 Antigravity CLI（`agy`）并加入 PATH，或设置 AGENTRA_ANTIGRAVITY_PATH。'
const HINT_LOGIN =
  'Antigravity CLI 未登录。请在终端运行一次 `agy` 完成认证，或配置 Gemini API Key。'

const AUTH_ERROR = /not authenticated|authentication|unauthorized|credential|please log ?in/i

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

export function findAntigravityExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicit = env.AGENTRA_ANTIGRAVITY_PATH
  if (explicit && isExecutableFile(explicit)) return path.resolve(explicit)
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'agy')),
    path.join(homeDir, '.local', 'bin', 'agy'),
    path.join(homeDir, '.antigravity', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
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

export async function discoverAntigravity(options: DiscoveryOptions = {}): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const run = options.run ?? runCommand
  const discoveredAt = new Date().toISOString()
  const base = {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    providerType: 'cli' as const,
    providerName: ANTIGRAVITY_PROVIDER_NAME,
    capabilities: ANTIGRAVITY_CAPABILITIES,
    discoveredAt,
  }
  const executablePath = findAntigravityExecutable(env, homeDir)
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
      healthDetail: `Antigravity CLI 无法执行：${error instanceof Error ? error.message : String(error)}`,
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
      healthDetail: 'Antigravity CLI 已找到，但 --version 执行失败。',
      authMethod: null,
    }
  }
  // `agy models` 是本地认证探测：未登录时命令以非零退出并在输出中提示认证问题。
  let modelsResult: CommandResult | null = null
  try {
    modelsResult = await run(executablePath, ['models'], { env, timeoutMs: 5000 })
  } catch {
    // 探测失败不阻断发现；按已安装但认证未知处理。
  }
  if (modelsResult && modelsResult.code !== 0) {
    const combined = `${modelsResult.stdout}\n${modelsResult.stderr}`
    if (AUTH_ERROR.test(combined)) {
      return {
        ...base,
        executablePath,
        version,
        healthStatus: 'unauthenticated',
        healthDetail: HINT_LOGIN,
        authMethod: null,
      }
    }
  }
  return {
    ...base,
    executablePath,
    version,
    healthStatus: 'healthy',
    healthDetail: modelsResult
      ? 'Antigravity CLI 已安装并可用。'
      : 'Antigravity CLI 已安装；认证状态在首次执行时校验。',
    authMethod: null,
  }
}
