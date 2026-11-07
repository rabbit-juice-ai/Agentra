import type { RuntimeProviderRecord } from '@agentra/protocol'
import { Icon } from './Icon'
import { providerMark, providerMarkClass } from './ProviderBadge'
import { StatusBadge } from './StatusBadge'

type Props = {
  providers: RuntimeProviderRecord[]
  busy: boolean
  onRefresh: () => void
}

/**
 * Provider 只展示「发现了哪些 + 是否健康」。
 * 路径、认证方式、能力矩阵属于排障信息，不占用日常界面。
 */
export function ProvidersPanel({ providers, busy, onRefresh }: Props) {
  const healthy = providers.filter((provider) => provider.healthStatus === 'healthy').length
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">Providers</div>
        <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="faint" style={{ fontSize: 10.5 }}>
            {healthy}/{providers.length} 健康
          </span>
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
      <div className="card-body" style={{ display: 'grid', gap: 0 }}>
        {providers.length === 0 ? (
          <div className="empty-state" style={{ padding: '12px 0' }}>
            尚未发现 Provider。请确认 CLI 已安装后点击「重新发现」。
          </div>
        ) : (
          providers.map((provider, index) => (
            <div
              key={provider.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderTop: index === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span className={`provider-mark ${providerMarkClass(provider.providerName)}`}>
                {providerMark(provider.providerName)}
              </span>
              <strong style={{ fontSize: 12.5, flex: 1 }}>{provider.providerName}</strong>
              {provider.version && (
                <span className="faint" style={{ fontSize: 11 }}>
                  v{provider.version}
                </span>
              )}
              <span title={provider.healthDetail ?? undefined}>
                <StatusBadge status={provider.healthStatus} />
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
