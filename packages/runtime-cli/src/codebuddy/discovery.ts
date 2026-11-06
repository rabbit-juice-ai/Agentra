import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeInfo } from '@agentra/runtime-sdk'
import { type CommandResult, runCommand } from '../run-command'
import {
  CODEBUDDY_CAPABILITIES,
  CODEBUDDY_PROVIDER_ID,
  CODEBUDDY_PROVIDER_NAME,
} from './capabilities'

export type RunCommand = typeof runCommand

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  run?: RunCommand
}

const HINT_INSTALL =
  'CodeBuddy CLI 未找到。请安装 CodeBuddy 并将 codebuddy 加入 PATH，或设置 AGENTRA_CODEBUDDY_PATH。'

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

export function findCodeBuddyExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicit = env.AGENTRA_CODEBUDDY_PATH
  if (explicit && isExecutableFile(explicit)) return path.resolve(explicit)
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'codebuddy')),
    path.join(homeDir, '.local', 'bin', 'codebuddy'),
    '/opt/homebrew/bin/codebuddy',
    '/usr/local/bin/codebuddy',
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

export async function discoverCodeBuddy(options: DiscoveryOptions = {}): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const run = options.run ?? runCommand
  const discoveredAt = new Date().toISOString()
  const base = {
    providerId: CODEBUDDY_PROVIDER_ID,
    providerType: 'cli' as const,
    providerName: CODEBUDDY_PROVIDER_NAME,
    capabilities: CODEBUDDY_CAPABILITIES,
    discoveredAt,
  }
  const executablePath = findCodeBuddyExecutable(env, homeDir)
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
      healthDetail: `CodeBuddy CLI 无法执行：${error instanceof Error ? error.message : String(error)}`,
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
      healthDetail: 'CodeBuddy CLI 已找到，但 --version 执行失败。',
      authMethod: null,
    }
  }
  return {
    ...base,
    executablePath,
    version,
    healthStatus: 'healthy',
    healthDetail: 'CodeBuddy CLI 已安装；认证状态在首次执行时校验。',
    authMethod: null,
  }
}
