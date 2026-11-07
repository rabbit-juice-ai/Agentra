import type { HealthResult, RuntimeProviderRecord } from '@agentra/protocol'
import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { StatusBadge } from './StatusBadge'

export const SETTINGS_PAGE_MARKER = 'agentra-product-settings'

/**
 * 设置页：只展示真实可操作的运行时/数据/关于信息，不做没有实现的开关。
 */
export function SettingsPage({
  coreHealth,
  daemonHealth,
  providers,
  worksCount,
  projectsCount,
  agentsCount,
  onRefreshProviders,
  onOpenBackups,
}: {
  coreHealth: HealthResult | null
  daemonHealth: HealthResult | null
  providers: RuntimeProviderRecord[]
  worksCount: number
  projectsCount: number
  agentsCount: number
  onRefreshProviders: () => Promise<void>
  onOpenBackups: () => void
}) {
  const [appInfo, setAppInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const healthy = providers.filter((provider) => provider.healthStatus === 'healthy').length

  useEffect(() => {
    void window.agentra
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null))
  }, [])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      await onRefreshProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const openDataDir = async (): Promise<void> => {
    setOpening(true)
    setError(null)
    try {
      const result = await window.agentra.openDataDir()
      if (result.error) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div data-agentra-page={SETTINGS_PAGE_MARKER} className="page">
      <PageHeader title="设置" subtitle="运行时、数据目录与产品信息；这里只展示真实可操作的项。" />

      {error && <div className="banner error">{error}</div>}

      <div style={{ display: 'grid', gap: 12, maxWidth: 820 }}>
        <div className="card">
          <div className="card-head">
            <div className="card-title">运行时</div>
            <div className="right">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <Icon name="refresh" size={13} />
                {refreshing ? '发现中…' : '重新发现 Provider'}
              </button>
            </div>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 10 }}>
            <dl className="kv">
              <dt>Core</dt>
              <dd>
                <StatusBadge
                  status={coreHealth ? 'healthy' : 'unavailable'}
                  label={coreHealth ? '正常' : '断连'}
                />
              </dd>
              <dt>Daemon</dt>
              <dd>
                <StatusBadge
                  status={daemonHealth ? 'healthy' : 'unavailable'}
                  label={daemonHealth ? '正常' : '断连'}
                />
              </dd>
              <dt>Provider</dt>
              <dd>
                {healthy}/{providers.length} 健康
              </dd>
              <dt>协议版本</dt>
              <dd className="mono">{coreHealth?.protocolVersion ?? '—'}</dd>
            </dl>
            <div style={{ display: 'grid', gap: 6 }}>
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                >
                  <span style={{ flex: 1 }}>{provider.providerName}</span>
                  <span title={provider.healthDetail ?? undefined}>
                    <StatusBadge status={provider.healthStatus} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">数据</div>
            <div className="right">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenBackups}>
                备份中心
              </button>
            </div>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 10 }}>
            <dl className="kv">
              <dt>数据目录</dt>
              <dd className="mono" style={{ wordBreak: 'break-all' }}>
                {appInfo?.dataDir ?? '—'}
              </dd>
              <dt>项目 / 任务 / Agents</dt>
              <dd>
                {projectsCount} / {worksCount} / {agentsCount}
              </dd>
            </dl>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ justifySelf: 'start' }}
              disabled={opening}
              onClick={() => void openDataDir()}
            >
              <Icon name="external" size={13} />
              {opening ? '打开中…' : '打开数据目录'}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">关于</div>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>产品</dt>
              <dd>Agentra</dd>
              <dt>版本</dt>
              <dd className="mono">{appInfo?.version ?? '—'}</dd>
              <dt>桌面</dt>
              <dd>Electron</dd>
              <dt>执行内核</dt>
              <dd>计划 → 任务图 → Workflow Engine（内部）</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
