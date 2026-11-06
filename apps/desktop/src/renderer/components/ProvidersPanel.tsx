import type { RuntimeProviderRecord } from '@agentra/protocol'
import { useState } from 'react'
import { Icon } from './Icon'
import { providerMark, providerMarkClass } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'

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
    <section className="card">
      <div className="card-head">
        <div className="card-title">Runtime Providers</div>
        <div className="right">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            disabled={busy}
          >
            <Icon name="refresh" size={13} />
            重新发现
          </button>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 12 }}>
        {providers.length === 0 && (
          <div className="empty-state" style={{ padding: '12px 0' }}>
            尚未发现 Provider。请确认已安装 Claude Code 后点击“重新发现”。
          </div>
        )}
        {providers.map((provider) => {
          const unsupported = Object.entries(provider.capabilities)
            .filter(([, support]) => support === 'unsupported')
            .map(([name]) => name)
          return (
            <div
              key={provider.id}
              style={{
                borderTop: '1px solid var(--border)',
                paddingTop: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`provider-mark ${providerMarkClass(provider.providerName)}`}>
                  {providerMark(provider.providerName)}
                </span>
                <strong style={{ fontSize: 12.5 }}>{provider.providerName}</strong>
                <StatusBadge status={provider.healthStatus} />
                <span className="faint" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  v{provider.version ?? '未知'}
                </span>
              </div>
              <div className="faint" style={{ marginTop: 6, fontSize: 11.5 }}>
                路径 <code className="mono">{provider.executablePath ?? '未找到'}</code>
              </div>
              <div className="faint" style={{ marginTop: 2, fontSize: 11.5 }}>
                认证 {provider.authMethod ?? '未知'}
              </div>
              {provider.healthDetail ? (
                <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div
                    className="muted"
                    style={{
                      flex: 1,
                      fontSize: 11.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {provider.healthDetail}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void copyHint(provider.id, provider.healthDetail ?? '')}
                  >
                    {copiedId === provider.id ? '已复制' : '复制提示'}
                  </button>
                </div>
              ) : null}
              <div className="faint" style={{ marginTop: 4, fontSize: 11 }}>
                能力：streaming={provider.capabilities.streaming} · interrupt=
                {provider.capabilities.interrupt} · structuredEvents=
                {provider.capabilities.structuredEvents}
                {unsupported.length > 0 ? ` · unsupported: ${unsupported.join(', ')}` : ''}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
