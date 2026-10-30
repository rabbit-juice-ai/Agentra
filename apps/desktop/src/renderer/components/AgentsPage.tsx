import type {
  AgentCreateParams,
  AgentProfile,
  AgentUpdateParams,
  RuntimeProvider,
} from '@agentra/protocol'
import { useState } from 'react'
import { AgentForm } from './AgentForm'
import { ProvidersPanel } from './ProvidersPanel'
import { StatusBadge } from './StatusBadge'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

type Props = {
  agents: AgentProfile[]
  providers: RuntimeProvider[]
  busy: boolean
  onCreate: (params: AgentCreateParams) => Promise<boolean>
  onUpdate: (params: AgentUpdateParams) => Promise<boolean>
  onArchive: (id: string) => Promise<void>
  onRefreshProviders: () => Promise<void>
}

export function AgentsPage({
  agents,
  providers,
  busy,
  onCreate,
  onUpdate,
  onArchive,
  onRefreshProviders,
}: Props) {
  const [formMode, setFormMode] = useState<'none' | 'create' | 'edit'>('none')
  const [editing, setEditing] = useState<AgentProfile | null>(null)

  const openCreate = (): void => {
    setEditing(null)
    setFormMode('create')
  }
  const openEdit = (agent: AgentProfile): void => {
    setEditing(agent)
    setFormMode('edit')
  }
  const closeForm = (): void => {
    setEditing(null)
    setFormMode('none')
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: formMode === 'none' ? '1fr' : '1fr 380px',
        gap: 16,
      }}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <ProvidersPanel
          providers={providers}
          busy={busy}
          onRefresh={() => void onRefreshProviders()}
        />
        <section style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <h2 style={{ ...sectionTitleStyle, margin: 0 }}>Agents</h2>
            <button
              type="button"
              style={{ ...primaryButtonStyle, marginLeft: 'auto' }}
              onClick={openCreate}
              disabled={busy}
            >
              新建 Agent
            </button>
          </div>
          {agents.length === 0 ? (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>
              还没有 Agent。点击“新建 Agent”创建第一个员工身份。
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: colors.muted, fontSize: 12 }}>
                  <th style={{ padding: '6px 4px' }}>名称</th>
                  <th style={{ padding: '6px 4px' }}>角色</th>
                  <th style={{ padding: '6px 4px' }}>Provider</th>
                  <th style={{ padding: '6px 4px' }}>状态</th>
                  <th style={{ padding: '6px 4px' }}>并发</th>
                  <th style={{ padding: '6px 4px' }} />
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} style={{ borderTop: `1px solid ${colors.subtle}` }}>
                    <td style={{ padding: '8px 4px', fontWeight: 600 }}>{agent.name}</td>
                    <td style={{ padding: '8px 4px' }}>{agent.role}</td>
                    <td style={{ padding: '8px 4px', color: colors.muted }}>
                      {agent.defaultProviderId ?? '自动'}
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <StatusBadge status={agent.status} />
                    </td>
                    <td style={{ padding: '8px 4px' }}>{agent.maxConcurrency}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        style={{ ...buttonStyle, marginRight: 6 }}
                        onClick={() => openEdit(agent)}
                        disabled={busy}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        style={dangerButtonStyle}
                        onClick={() => void onArchive(agent.id)}
                        disabled={busy}
                      >
                        归档
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {agents.some((agent) => agent.systemPrompt.length > 0) && (
            <p style={{ fontSize: 12, color: colors.muted, margin: '10px 0 0' }}>
              提示：系统提示词会在执行时通过 --append-system-prompt 传给 CLI。
            </p>
          )}
        </section>
      </div>
      {formMode !== 'none' && (
        <AgentForm
          providers={providers}
          initial={formMode === 'edit' ? editing : null}
          busy={busy}
          onSubmit={(params) =>
            formMode === 'edit'
              ? onUpdate(params as AgentUpdateParams)
              : onCreate(params as AgentCreateParams)
          }
          onCancel={closeForm}
        />
      )}
    </div>
  )
}
