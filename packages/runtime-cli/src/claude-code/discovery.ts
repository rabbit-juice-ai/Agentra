import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeInfo } from '@agentra/runtime-sdk'
import { type CommandResult, runCommand } from '../run-command'
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_PROVIDER_NAME,
} from './capabilities'

export type RunCommand = typeof runCommand

export type DiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  run?: RunCommand
}

const HINT_INSTALL =
  'Claude Code CLI 未找到。请安装 Claude Code 并将 claude 加入 PATH，或设置 AGENTRA_CLAUDE_PATH 指向可执行文件。'
const HINT_LOGIN =
  'Claude Code 未认证。请在终端执行 `claude auth login`（或配置 ANTHROPIC_API_KEY）后重试。'

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

/** PATH + 常见安装位置查找 claude；返回规范化后的绝对路径。 */
export function findClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicit = env.AGENTRA_CLAUDE_PATH
  if (explicit && isExecutableFile(explicit)) return path.resolve(explicit)

  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'claude')),
    path.join(homeDir, '.local', 'bin', 'claude'),
    path.join(homeDir, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return path.resolve(candidate)
  }
  return null
}

/** `claude --version` 输出形如 "2.1.314 (Claude Code)"，取首个 token。 */
export function parseVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^v?(\d+\.\d+\.\d+\S*)/)
  return match?.[1] ?? null
}

export type AuthProbe = { authenticated: boolean; authMethod: string | null; detail: string }

/**
 * 认证探测：优先 `claude auth status`（本地、无网络），失败时回退到 API Key 环境变量。
 * 只读取状态，不读取、不记录任何凭据内容。
 */
export function interpretAuthStatus(result: CommandResult, env: NodeJS.ProcessEnv): AuthProbe {
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN)
  let loggedIn = false
  let authMethod: string | null = null
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      loggedIn?: unknown
      authMethod?: unknown
    }
    loggedIn = parsed.loggedIn === true
    authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : null
  } catch {
    // 旧版 CLI 无 auth status：只能靠 API Key 判断。
    if (hasApiKey) return { authenticated: true, authMethod: 'api_key', detail: '' }
    return { authenticated: false, authMethod: null, detail: HINT_LOGIN }
  }

  if (loggedIn) return { authenticated: true, authMethod, detail: '' }
  if (hasApiKey) return { authenticated: true, authMethod: 'api_key', detail: '' }
  return { authenticated: false, authMethod, detail: HINT_LOGIN }
}

/**
 * Claude Code Provider 自动发现：路径 → 可执行性 → 版本 → 认证。
 * 任何一步失败都返回结构化 health，不抛异常（UI 需要展示原因）。
 */
export async function discoverClaudeCode(options: DiscoveryOptions = {}): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? os.homedir()
  const run = options.run ?? runCommand
  const discoveredAt = new Date().toISOString()

  const base = {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    providerType: 'cli' as const,
    providerName: CLAUDE_CODE_PROVIDER_NAME,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    discoveredAt,
  }

  const executablePath = findClaudeExecutable(env, homeDir)
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
      healthDetail: `无法执行 ${executablePath}：${error instanceof Error ? error.message : String(error)}。请检查文件权限或重新安装 Claude Code。`,
      authMethod: null,
    }
  }
  if (versionResult.code !== 0) {
    return {
      ...base,
      executablePath,
      version: null,
      healthStatus: 'unavailable',
      healthDetail: `\`claude --version\` 退出码 ${versionResult.code}：${versionResult.stderr.trim().slice(0, 500) || '无输出'}。请重新安装 Claude Code。`,
      authMethod: null,
    }
  }
  const version = parseVersion(versionResult.stdout)
  if (!version) {
    return {
      ...base,
      executablePath,
      version: null,
      healthStatus: 'unavailable',
      healthDetail: `无法解析版本输出：${versionResult.stdout.trim().slice(0, 200) || '空'}`,
      authMethod: null,
    }
  }

  let authResult: CommandResult | null = null
  try {
    authResult = await run(executablePath, ['auth', 'status'], { env, timeoutMs: 5000 })
  } catch {
    authResult = null
  }
  const auth = authResult
    ? interpretAuthStatus(authResult, env)
    : (env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN)
      ? { authenticated: true, authMethod: 'api_key', detail: '' }
      : { authenticated: false, authMethod: null, detail: HINT_LOGIN }

  return {
    ...base,
    executablePath,
    version,
    healthStatus: auth.authenticated ? 'healthy' : 'unauthenticated',
    healthDetail: auth.detail,
    authMethod: auth.authMethod,
  }
}
