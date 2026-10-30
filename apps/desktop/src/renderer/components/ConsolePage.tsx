import type { AgentProfile, Execution, ToolPermissions } from '@agentra/protocol'
import { useEffect, useState } from 'react'
import type { ConsoleState } from '../state/console-reducer'
import { OutputPanel } from './OutputPanel'
import { StatusBadge } from './StatusBadge'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

type Props = {
  agents: AgentProfile[]
  state: ConsoleState
  busy: boolean
  onStart: (agentId: string, prompt: string) => Promise<boolean>
  onSelect: (executionId: string) => Promise<void>
  onCancel: (executionId: string) => Promise<void>
  onInterrupt: (executionId: string) => Promise<void>
  onSendMessage: (executionId: string, message: string) => Promise<boolean>
}

const ACTIVE_STATUSES = new Set(['pending', 'running'])

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

/**
 * 构建产物检查用的标记（U2）：发布构建里这个字符串必须不存在。
 * 由 scripts/check-release-bundle.mjs 在每次 build 后断言。
 */
export const DEV_CONSOLE_MARKER = 'agentra-dev-console'

/** 执行控制台：选 Agent + prompt → 启动 → 实时输出 → 中断/取消 → 终态。 */
export function ConsolePage({
  agents,
  state,
  busy,
  onStart,
  onSelect,
  onCancel,
  onInterrupt,
  onSendMessage,
}: Props) {
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [message, setMessage] = useState('')

  const activeAgents = agents.filter((agent) => agent.status === 'active')

  useEffect(() => {
    if (agentId === '' && activeAgents.length > 0) setAgentId(activeAgents[0]?.id ?? '')
  }, [activeAgents, agentId])

  const startAgent = activeAgents.find((agent) => agent.id === agentId) ?? null
  const selected = state.executions.find((execution) => execution.id === state.selectedId) ?? null
  const selectedAgent = selected
    ? (agents.find((agent) => agent.id === selected.agentId) ?? null)
    : null
  const selectedLogs = selected ? (state.logs[selected.id] ?? []) : []
  const running = selected !== null && ACTIVE_STATUSES.has(selected.status)
  const interruptSupported = selected?.capabilities.interrupt !== 'unsupported'

  const start = async (): Promise<void> => {
    if (agentId === '' || prompt.trim() === '') return
    const ok = await onStart(agentId, prompt)
    if (ok) setPrompt('')
  }

  const send = async (): Promise<void> => {
    if (!selected || message.trim() === '') return
    const ok = await onSendMessage(selected.id, message)
    if (ok) setMessage('')
  }

  return (
    <div data-agentra-console={DEV_CONSOLE_MARKER} style={{ display: 'grid', gap: 16 }}>
      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>启动执行</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '220px 1fr auto',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <label>
            <span style={labelStyle}>Agent</span>
            <select
              style={inputStyle}
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {activeAgents.length === 0 && <option value="">（无可用 Agent）</option>}
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.role}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span style={labelStyle}>Prompt</span>
            <textarea
              style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：Reply with exactly: OK"
            />
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void start()}
            disabled={busy || agentId === '' || prompt.trim() === ''}
          >
            启动
          </button>
        </div>
        {/* C2 无人值守明示：启动前必须可见，不增加确认弹窗 */}
        <div
          style={{
            marginTop: 10,
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
            background: '#fffdf5',
            fontSize: 12,
            color: colors.muted,
            display: 'grid',
            gap: 4,
          }}
        >
          <span>
            <strong>无人值守执行</strong>：启动后不再询问，本版本不呈现 CLI 的权限请求。
          </span>
          <span>本次实际生效的工具权限：{describeTools(startAgent?.toolPermissions ?? null)}</span>
          <span>禁止清单优先于允许清单；未列入允许清单的工具不会获得授权。</span>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
        <section style={panelStyle}>
          <h2 style={sectionTitleStyle}>执行记录</h2>
          {state.executions.length === 0 ? (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>还没有执行记录。</p>
          ) : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 420, overflow: 'auto' }}>
              {state.executions.map((execution) => (
                <button
                  key={execution.id}
                  type="button"
                  onClick={() => void onSelect(execution.id)}
                  style={{
                    textAlign: 'left',
                    border: `1px solid ${execution.id === state.selectedId ? colors.blue : colors.border}`,
                    background: execution.id === state.selectedId ? '#ddf4ff' : '#ffffff',
                    borderRadius: 6,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <code style={{ fontSize: 11 }}>{shortId(execution.id)}</code>
                    <span style={{ marginLeft: 'auto' }}>
                      <StatusBadge status={execution.status} />
                    </span>
                  </div>
                  <div style={{ color: colors.muted, marginTop: 4 }}>
                    {execution.agentId ?? 'unknown agent'} · exit {execution.exitCode ?? '—'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section style={{ ...panelStyle, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ ...sectionTitleStyle, margin: 0 }}>执行详情</h2>
            {selected && <StatusBadge status={selected.status} />}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: colors.muted }}>
              {selected
                ? `exit ${selected.exitCode ?? '—'} · pid ${selected.processId ?? '—'}`
                : ''}
            </span>
          </div>

          {selected ? (
            <ExecutionMeta
              execution={selected}
              toolPermissions={selectedAgent?.toolPermissions ?? null}
            />
          ) : (
            <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>
              选择左侧执行记录查看实时输出。
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={!running || !interruptSupported}
              title={
                interruptSupported
                  ? '发送原生 interrupt（control_request）'
                  : 'Provider 声明 interrupt=unsupported'
              }
              onClick={() => selected && void onInterrupt(selected.id)}
            >
              中断
            </button>
            <button
              type="button"
              style={dangerButtonStyle}
              disabled={!running}
              onClick={() => selected && void onCancel(selected.id)}
            >
              取消
            </button>
          </div>

          <OutputPanel logs={selectedLogs} emptyHint={selected ? '等待输出…' : '尚未选择执行'} />

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={inputStyle}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="向运行中的执行发送消息（streaming 能力）"
              disabled={!running}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void send()
              }}
            />
            <button
              type="button"
              style={buttonStyle}
              disabled={!running || message.trim() === ''}
              onClick={() => void send()}
            >
              发送
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

/** 把工具策略描述成一行可读文本；null 表示查不到对应 Agent。 */
function describeTools(toolPermissions: ToolPermissions | null): string {
  if (!toolPermissions) return '—（未找到对应 Agent 配置）'
  if (toolPermissions.allow.length === 0) {
    return '未配置（allow 为空，启动会被 Core 拒绝，错误码 AGENT_TOOLS_NOT_CONFIGURED）'
  }
  const allow = toolPermissions.allow.join(', ')
  const deny = toolPermissions.deny.length > 0 ? toolPermissions.deny.join(', ') : '无'
  return `允许 [${allow}]；禁止 [${deny}]`
}

function ExecutionMeta({
  execution,
  toolPermissions,
}: {
  execution: Execution
  toolPermissions: ToolPermissions | null
}) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: '4px 10px',
        fontSize: 12,
        margin: 0,
        color: colors.muted,
      }}
    >
      <dt>Execution</dt>
      <dd style={{ margin: 0 }}>
        <code>{execution.id}</code>
      </dd>
      <dt>Provider</dt>
      <dd style={{ margin: 0 }}>{execution.providerId}</dd>
      <dt>工作目录</dt>
      <dd style={{ margin: 0 }}>
        <code>{execution.workingDirectory}</code>
      </dd>
      <dt>开始/结束</dt>
      <dd style={{ margin: 0 }}>
        {execution.startedAt ?? '—'} / {execution.endedAt ?? '—'}
      </dd>
      <dt>工具权限</dt>
      <dd style={{ margin: 0 }}>{describeTools(toolPermissions)}</dd>
      <dt>能力快照</dt>
      <dd style={{ margin: 0 }}>
        streaming={execution.capabilities.streaming} · interrupt={execution.capabilities.interrupt}{' '}
        · checkpoint={execution.capabilities.checkpoint}
      </dd>
    </dl>
  )
}
