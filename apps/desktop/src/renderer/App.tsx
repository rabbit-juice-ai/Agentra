import type { HealthResult } from '@agentra/protocol'
import { useState } from 'react'
import { AgentsPage } from './components/AgentsPage'
import { ConsolePage } from './components/ConsolePage'
import { buttonStyle, colors } from './components/styles'
import { useAgentra } from './hooks/useAgentra'

type Tab = 'console' | 'agents'

function HealthDot({ label, health }: { label: string; health: HealthResult | null }) {
  const ok = health !== null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: ok ? colors.green : colors.red,
          display: 'inline-block',
        }}
      />
      <span style={{ color: colors.muted }}>
        {label} {ok ? `pid ${health.pid}` : '断连'}
      </span>
    </span>
  )
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...buttonStyle,
        border: 'none',
        borderBottom: `2px solid ${active ? colors.blue : 'transparent'}`,
        borderRadius: 0,
        background: 'transparent',
        color: active ? colors.text : colors.muted,
        fontWeight: active ? 600 : 400,
        padding: '8px 12px',
      }}
    >
      {children}
    </button>
  )
}

export function App() {
  const store = useAgentra()
  const [tab, setTab] = useState<Tab>('console')

  return (
    <div
      style={{
        minHeight: '100vh',
        background: colors.bg,
        color: colors.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '10px 20px',
          background: colors.panel,
          borderBottom: `1px solid ${colors.border}`,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <strong style={{ fontSize: 15 }}>Agentra</strong>
        <nav style={{ display: 'flex' }}>
          <TabButton active={tab === 'console'} onClick={() => setTab('console')}>
            执行控制台
          </TabButton>
          <TabButton active={tab === 'agents'} onClick={() => setTab('agents')}>
            Agents
          </TabButton>
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
          <HealthDot label="Core" health={store.coreHealth} />
          <HealthDot label="Daemon" health={store.daemonHealth} />
        </div>
      </header>

      {store.banner && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '12px 20px 0',
            padding: '8px 12px',
            borderRadius: 6,
            border: `1px solid ${colors.amber}`,
            background: '#fff8c5',
            fontSize: 13,
            color: colors.text,
          }}
        >
          <span style={{ flex: 1 }}>{store.banner}</span>
          <button type="button" style={buttonStyle} onClick={store.dismissBanner}>
            关闭
          </button>
        </div>
      )}

      <main style={{ padding: 20 }}>
        {tab === 'console' ? (
          <ConsolePage
            agents={store.agents}
            state={store.consoleState}
            busy={store.busy}
            onStart={store.actions.startExecution}
            onSelect={store.actions.selectExecution}
            onCancel={store.actions.cancelExecution}
            onInterrupt={store.actions.interruptExecution}
            onSendMessage={store.actions.sendMessage}
          />
        ) : (
          <AgentsPage
            agents={store.agents}
            providers={store.providers}
            busy={store.busy}
            onCreate={store.actions.createAgent}
            onUpdate={store.actions.updateAgent}
            onArchive={store.actions.archiveAgent}
            onSetStatus={store.actions.setAgentStatus}
            onRefreshProviders={store.actions.refreshProviderDiscovery}
          />
        )}
      </main>
    </div>
  )
}
