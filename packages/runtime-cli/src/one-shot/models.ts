import type { ProviderModelInfo } from '@agentra/runtime-sdk'

/** 模型 ID 允许的字符；标签可含空格与括号。 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/**
 * Antigravity `agy models` 的格式：每行 `id<TAB>label`。
 * 无 tab 时把整行当作 id；重复 id 只保留第一次。
 */
export function parseTabbedModels(stdout: string): ProviderModelInfo[] {
  const seen = new Set<string>()
  const models: ProviderModelInfo[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const [idPart, ...labelParts] = line.split('\t')
    const id = idPart?.trim() ?? ''
    if (!MODEL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = labelParts.join(' ').trim() || id
    models.push({ id, label })
  }
  return models
}

/**
 * Grok `grok models` 的格式：
 *   Default model: grok-4.6
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 * 未认证时也会返回这段列表；认证状态由 discovery 单独判断。
 */
export function parseGrokModels(stdout: string): ProviderModelInfo[] {
  const seen = new Set<string>()
  const models: ProviderModelInfo[] = []
  const add = (id: string, label: string): void => {
    if (!MODEL_ID.test(id) || seen.has(id)) return
    seen.add(id)
    models.push({ id, label })
  }
  let defaultModel: string | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    const defaultMatch = /^Default model:\s*(\S+)/i.exec(line)
    if (defaultMatch?.[1]) {
      defaultModel = defaultMatch[1]
      continue
    }
    const item = /^[*-]\s+(\S+)(.*)$/.exec(line)
    if (!item?.[1]) continue
    const suffix = item[2]?.replace(/\s*\(default\)\s*$/i, '').trim() ?? ''
    add(item[1], suffix.length > 0 ? `${item[1]} ${suffix}` : item[1])
  }
  if (defaultModel) add(defaultModel, `${defaultModel}（默认）`)
  return models
}
