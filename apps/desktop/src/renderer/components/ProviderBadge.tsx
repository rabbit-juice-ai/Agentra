import type { RuntimeProviderRecord } from '@agentra/protocol'

/** Stable monogram for a provider, so the badge never depends on an id format. */
export function providerMark(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('codebuddy')) return 'CB'
  if (normalized.includes('claude')) return 'CC'
  if (normalized.includes('codex')) return 'CX'
  if (normalized.includes('gemini')) return 'GM'
  if (normalized.includes('antigravity')) return 'AG'
  if (normalized.includes('grok')) return 'GK'
  if (normalized.includes('cursor')) return 'CU'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? ''
    const second = words[1]?.[0] ?? ''
    return `${first}${second}`.toUpperCase() || 'AI'
  }
  return name.trim().slice(0, 2).toUpperCase() || 'AI'
}

function variant(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('codebuddy')) return 'cb'
  if (normalized.includes('codex')) return 'cx'
  if (normalized.includes('gemini')) return 'gm'
  if (normalized.includes('antigravity')) return 'ag'
  if (normalized.includes('grok')) return 'gk'
  return ''
}

export function providerMarkClass(name: string): string {
  return variant(name)
}

export function ProviderBadge({
  provider,
  fallback = '未绑定',
}: {
  provider?: RuntimeProviderRecord | null
  fallback?: string
}) {
  if (!provider) {
    return (
      <span className="provider-badge" title="未绑定 Provider；编辑 Agent 时必须显式选择">
        <span className="provider-mark">AU</span>
        {fallback}
      </span>
    )
  }
  return (
    <span className="provider-badge" title={provider.executablePath ?? provider.providerName}>
      <span className={`provider-mark ${variant(provider.providerName)}`}>
        {providerMark(provider.providerName)}
      </span>
      {provider.providerName}
    </span>
  )
}
