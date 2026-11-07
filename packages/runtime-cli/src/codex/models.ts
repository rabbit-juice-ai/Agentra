import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderModelInfo } from '@agentra/runtime-sdk'

const IMAGE_ONLY_MODEL = /(^|[-_:])image([-_:]|$)/i

export type CodexModelDiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

function addModel(models: ProviderModelInfo[], seen: Set<string>, id: string, label: string): void {
  const clean = id.trim()
  if (clean.length === 0 || seen.has(clean) || IMAGE_ONLY_MODEL.test(clean)) return
  const prefixEnd = clean.indexOf(':')
  const prefix = prefixEnd > 0 ? clean.slice(0, prefixEnd) : ''
  const rawLabel = label.trim() || clean
  const displayLabel =
    prefix.length > 0 && rawLabel.startsWith(`${prefix}:`)
      ? rawLabel.slice(prefix.length + 1).trim() || clean
      : rawLabel
  seen.add(clean)
  models.push({ id: clean, label: displayLabel })
}

/**
 * 读取用户当前的 Codex 模型配置：
 * - cc-switch 生成的模型目录（包含 deepseek / glm / kimi 等实际后台模型）；
 * - 没有目录时读取 config.toml 的 model，或 OPENAI_MODEL/CODEX_MODEL 环境变量。
 */
export function discoverCodexModels(options: CodexModelDiscoveryOptions = {}): ProviderModelInfo[] {
  const homeDir = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const models: ProviderModelInfo[] = []
  const seen = new Set<string>()

  try {
    const raw = fs.readFileSync(
      path.join(homeDir, '.codex', 'cc-switch-model-catalog.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      const list = (parsed as { models?: unknown }).models
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          const id = record.slug ?? record.id
          if (typeof id !== 'string') continue
          const label = typeof record.display_name === 'string' ? record.display_name : id
          addModel(models, seen, id, label)
          if (models.length >= 200) break
        }
      }
    }
  } catch {
    // 没有目录文件时继续走配置回退。
  }

  if (models.length === 0) {
    try {
      const config = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8')
      const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(config)
      if (match?.[1]) addModel(models, seen, match[1], match[1])
    } catch {
      // config.toml 不存在时继续。
    }
  }
  if (models.length === 0) {
    const configured = env.OPENAI_MODEL ?? env.CODEX_MODEL
    if (configured && configured.trim().length > 0) {
      addModel(models, seen, configured, configured)
    }
  }
  return models
}
