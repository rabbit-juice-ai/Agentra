import type { RuntimeProviderRecord } from '@agentra/protocol'
import { useState } from 'react'
import { StatusBadge } from './StatusBadge'
import { buttonStyle, colors, panelStyle, sectionTitleStyle } from './styles'

type Props = {
  providers: RuntimeProviderRecord[]
  busy: boolean
  onRefresh: () => void
}

/** Provider 健康面板：路径/版本/健康状态与 runtime_providers 表一致（验收 2）。 */
export function ProvidersPanel({ providers, busy, onRefresh }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // 只复制提示文本（安装/登录命令），不涉及任何凭据。
  const copyHint = async (providerId: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(providerId)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setCopiedId(null)
    }
  }

  return (
    <section style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <h2 style={{ ...sectionTitleStyle, margin: 0 }}>Runtime Providers</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          style={{ ...buttonStyle, marginLeft: 'auto' }}
        >
          重新发现
        </button>
      </div>
      {providers.length === 0 && (
        <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>
          尚未发现 Provider。请确认已安装 Claude Code 后点击“重新发现”。
        </p>
      )}
      {providers.map((provider) => {
        const unsupported = Object.entries(provider.capabilities)
          .filter(([, support]) => support === 'unsupported')
          .map(([name]) => name)
        return (
          <div
            key={provider.id}
            style={{
              borderTop: `1px solid ${colors.subtle}`,
              paddingTop: 10,
              marginTop: 10,
              fontSize: 13,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{provider.providerName}</strong>
              <StatusBadge status={provider.healthStatus} />
              <span style={{ marginLeft: 'auto', color: colors.muted, fontSize: 12 }}>
                v{provider.version ?? '未知'}
              </span>
            </div>
            <div style={{ marginTop: 6, color: colors.muted, fontSize: 12 }}>
              路径：
              <code style={{ fontSize: 12 }}>{provider.executablePath ?? '未找到'}</code>
            </div>
            <div style={{ marginTop: 2, color: colors.muted, fontSize: 12 }}>
              认证：{provider.authMethod ?? '未知'}
            </div>
            {provider.healthDetail ? (
              <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div
                  style={{
                    flex: 1,
                    color: colors.muted,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {provider.healthDetail}
                </div>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => void copyHint(provider.id, provider.healthDetail ?? '')}
                >
                  {copiedId === provider.id ? '已复制' : '复制提示'}
                </button>
              </div>
            ) : null}
            <div style={{ marginTop: 2, color: colors.muted, fontSize: 12 }}>
              能力：streaming={provider.capabilities.streaming} · interrupt=
              {provider.capabilities.interrupt} · structuredEvents=
              {provider.capabilities.structuredEvents}
              {unsupported.length > 0 ? ` · unsupported: ${unsupported.join(', ')}` : ''}
            </div>
          </div>
        )
      })}
    </section>
  )
}
