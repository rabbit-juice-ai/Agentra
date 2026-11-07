import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderModelInfo } from '@agentra/runtime-sdk'

type FetchLike = typeof globalThis.fetch
type EnvLike = Record<string, string | undefined>

type ClaudeSettings = {
  model?: unknown
  env?: Record<string, unknown>
}

export type ClaudeModelDiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  fetchImpl?: FetchLike
  /** 整体探测预算，默认 12s；Daemon 调用方另有 20s 上限。 */
  timeoutMs?: number
}

const ALIASES = ['FABLE', 'OPUS', 'SONNET', 'HAIKU'] as const
const BUILTIN_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable'])
/** 图像生成模型对编码 Agent 不可用，过滤掉（如 cn:hunyuan-image-alpha）。 */
const IMAGE_ONLY_MODEL = /(^|[-_:])image([-_:]|$)/i

function readSettings(homeDir: string): ClaudeSettings | null {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const env =
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? (record.env as Record<string, unknown>)
        : undefined
    return env ? { model: record.model, env } : { model: record.model }
  } catch {
    return null
  }
}

function settingsEnv(settings: ClaudeSettings | null): EnvLike {
  const env: EnvLike = {}
  for (const [key, value] of Object.entries(settings?.env ?? {})) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function envValue(env: EnvLike, key: string): string | null {
  const value = env[key]?.trim()
  return value && value.length > 0 ? value : null
}

/** 兼容 cc-switch（models[].slug）与 Anthropic（data[].id）两种返回。 */
function parseModels(payload: unknown): ProviderModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : []
  const seen = new Set<string>()
  const models: ProviderModelInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = [raw.slug, raw.id, raw.model].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (!id) continue
    const cleanId = id.trim()
    if (seen.has(cleanId)) continue
    if (IMAGE_ONLY_MODEL.test(cleanId)) continue
    const label = [raw.display_name, raw.name, raw.id].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    const rawLabel = label?.trim() ?? cleanId
    const prefixEnd = cleanId.indexOf(':')
    const prefix = prefixEnd > 0 ? cleanId.slice(0, prefixEnd) : ''
    // 分组标签已经显示 cn/global，选项标签去掉重复前缀，更接近用户配置里的模型名。
    const displayLabel =
      prefix.length > 0 && rawLabel.startsWith(`${prefix}:`)
        ? rawLabel.slice(prefix.length + 1).trim() || cleanId
        : rawLabel
    seen.add(cleanId)
    models.push({ id: cleanId, label: displayLabel })
    if (models.length >= 200) break
  }
  return models
}

async function fetchConfiguredModels(
  baseUrl: string,
  token: string | null,
  options: ClaudeModelDiscoveryOptions,
): Promise<ProviderModelInfo[]> {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return []
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
  const base = url.toString().replace(/\/+$/, '')
  const candidates = base.endsWith('/v1')
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`]
  const headerSets: Record<string, string>[] = []
  if (token) {
    // cc-switch / OpenAI 兼容代理：Bearer 返回完整目录。
    headerSets.push({ authorization: `Bearer ${token}`, accept: 'application/json' })
    // Anthropic 官方 /v1/models：x-api-key。
    headerSets.push({
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    })
  } else {
    headerSets.push({ accept: 'application/json' })
  }

  const deadline = Date.now() + (options.timeoutMs ?? 12_000)
  const fetchImpl = options.fetchImpl ?? fetch
  for (const candidate of candidates) {
    for (const headers of headerSets) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return []
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(4000, remaining))
      try {
        const response = await fetchImpl(candidate, {
          method: 'GET',
          headers,
          signal: controller.signal,
          // token 只发往用户配置的 base URL；拒绝跨域重定向。
          redirect: 'error',
        })
        if (!response.ok) continue
        const text = await response.text()
        if (text.length > 1_000_000) return []
        const models = parseModels(JSON.parse(text) as unknown)
        if (models.length > 0) return models
      } catch {
        // 单个端点/认证方式失败不阻断下一种探测。
      } finally {
        clearTimeout(timer)
      }
    }
  }
  return []
}

/**
 * 读取用户「当前配置」的 Claude Code 模型：
 * 1) 通过 ANTHROPIC_BASE_URL 的 /v1/models 拉取真实目录（cc-switch/Anthropic 兼容）；
 * 2) 失败时读取 settings.json / env 中的 ANTHROPIC_DEFAULT_*_MODEL_NAME 映射。
 * 不返回、不记录任何凭据。
 */
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions = {},
): Promise<ProviderModelInfo[]> {
  const homeDir = options.homeDir ?? os.homedir()
  const settings = readSettings(homeDir)
  const env: EnvLike = { ...settingsEnv(settings), ...(options.env ?? process.env) }
  const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL')
  const token = envValue(env, 'ANTHROPIC_AUTH_TOKEN') ?? envValue(env, 'ANTHROPIC_API_KEY') ?? null
  if (baseUrl) {
    const models = await fetchConfiguredModels(baseUrl, token, options)
    if (models.length > 0) return models
  }

  const models: ProviderModelInfo[] = []
  const seen = new Set<string>()
  const add = (id: string): void => {
    const clean = id.trim()
    if (clean.length === 0 || seen.has(clean)) return
    seen.add(clean)
    const prefixEnd = clean.indexOf(':')
    const label = prefixEnd > 0 ? clean.slice(prefixEnd + 1).trim() || clean : clean
    models.push({ id: clean, label })
  }
  for (const alias of ALIASES) {
    // MODEL_NAME 是实际后台模型（如 cn:deepseek-v4.1-flash）；MODEL 是 Claude 侧别名 ID。
    const backend = envValue(env, `ANTHROPIC_DEFAULT_${alias}_MODEL_NAME`)
    if (backend) {
      add(backend)
      continue
    }
    const mapped = envValue(env, `ANTHROPIC_DEFAULT_${alias}_MODEL`)
    if (mapped && !BUILTIN_ALIASES.has(mapped.toLowerCase())) add(mapped)
  }
  const explicit = envValue(env, 'ANTHROPIC_MODEL')
  if (explicit && !BUILTIN_ALIASES.has(explicit.toLowerCase())) add(explicit)
  return models
}
