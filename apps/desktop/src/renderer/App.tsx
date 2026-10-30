import { useCallback, useEffect, useState } from 'react'

type HealthView = {
  loading: boolean
  status: string
  detail: string
  pid?: number
  uptimeSeconds?: number
  version?: string
}

type HealthApi = {
  getCoreHealth: () => Promise<{ ok: boolean; result?: unknown; error?: string }>
  getDaemonHealth: () => Promise<{ ok: boolean; result?: unknown; error?: string }>
}

declare global {
  interface Window {
    agentra: HealthApi
  }
}

const initial: HealthView = { loading: true, status: '…', detail: '' }

function toView(promise: Promise<{ ok: boolean; result?: unknown; error?: string }>): Promise<HealthView> {
  return promise.then((res) => {
    if (!res.ok) return { loading: false, status: '断连', detail: res.error ?? 'unknown error' }
    const r = res.result as Record<string, unknown>
    return {
      loading: false,
      status: String(r['status'] ?? 'ok'),
      detail: '',
      pid: typeof r['pid'] === 'number' ? r['pid'] : undefined,
      uptimeSeconds: typeof r['uptimeSeconds'] === 'number' ? r['uptimeSeconds'] : undefined,
      version: typeof r['version'] === 'string' ? r['version'] : undefined,
    }
  })
}

function Card({ name, view }: { name: string; view: HealthView }) {
  const ok = view.status === 'ok'
  const color = ok ? '#1a7f37' : view.status === '断连' ? '#cf222e' : '#9a6700'
  return (
    <div
      style={{
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: '16px 20px',
        minWidth: 260,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: color, display: 'inline-block' }} />
        <strong style={{ fontSize: 15 }}>{name}</strong>
        <span style={{ marginLeft: 'auto', color, fontSize: 13 }}>{view.status}</span>
      </div>
      {view.pid !== undefined && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#57606a', lineHeight: 1.7 }}>
          pid {view.pid} · uptime {Math.floor(view.uptimeSeconds ?? 0)}s · v{view.version}
        </div>
      )}
      {view.detail && <div style={{ marginTop: 8, fontSize: 12, color: '#cf222e' }}>{view.detail}</div>}
    </div>
  )
}

export function App() {
  const [core, setCore] = useState<HealthView>(initial)
  const [daemon, setDaemon] = useState<HealthView>(initial)

  const refresh = useCallback(() => {
    setCore(initial)
    setDaemon(initial)
    void toView(window.agentra.getCoreHealth()).then(setCore)
    void toView(window.agentra.getDaemonHealth()).then(setDaemon)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Agentra</h1>
      <p style={{ fontSize: 13, color: '#57606a', margin: '0 0 20px' }}>
        阶段 0 · 服务健康状态（每 5 秒刷新）
        <button onClick={refresh} style={{ marginLeft: 12, fontSize: 12, cursor: 'pointer' }}>
          立即刷新
        </button>
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        <Card name="Core" view={core} />
        <Card name="Daemon" view={daemon} />
      </div>
      {(core.status === '断连' || daemon.status === '断连') && (
        <p style={{ fontSize: 12, color: '#9a6700', marginTop: 16 }}>
          提示：服务断连时请检查 ~/Library/Application Support/agentra/logs/ 下的日志。
        </p>
      )}
    </div>
  )
}
