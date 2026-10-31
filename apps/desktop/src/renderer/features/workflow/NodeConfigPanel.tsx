import type { CSSProperties } from 'react'
import { useState } from 'react'
import {
  colors,
  inputStyle,
  labelStyle,
  panelStyle,
  sectionTitleStyle,
} from '../../components/styles'
import type { DefinitionEdge, DefinitionNode } from './types'
import { NODE_TYPE_LABELS } from './types'

type Props = {
  node: DefinitionNode | null
  edge: DefinitionEdge | null
  nodes: DefinitionNode[]
  onChangeNode: (key: string, config: Record<string, unknown>, label?: string) => void
  onChangeEdge: (key: string, patch: Partial<DefinitionEdge>) => void
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseLiteral(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function literalText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

const fieldStyle: CSSProperties = { display: 'grid', gap: 4, marginBottom: 10 }
const rowStyle: CSSProperties = { display: 'flex', gap: 8 }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  )
}

export function NodeConfigPanel(props: Props) {
  const { node, edge, nodes } = props
  const [artifactError, setArtifactError] = useState<string | null>(null)

  if (edge) {
    return (
      <section style={panelStyle} data-testid="workflow-edge-panel">
        <h3 style={sectionTitleStyle}>连线配置</h3>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          {edge.key}：{edge.source} → {edge.target}
        </div>
        <Field label="when（仅 Condition 出边）">
          <select
            data-testid="workflow-panel-edge-when"
            style={inputStyle}
            value={edge.when === undefined ? '' : String(edge.when)}
            onChange={(event) => {
              const value = event.target.value
              props.onChangeEdge(edge.key, {
                when: value === '' ? undefined : value === 'true',
              })
            }}
          >
            <option value="">（未设置）</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </Field>
        <Field label="branchKey（仅 Parallel Split 出边）">
          <input
            data-testid="workflow-panel-edge-branch"
            style={inputStyle}
            value={edge.branchKey ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim()
              props.onChangeEdge(edge.key, { branchKey: value === '' ? undefined : value })
            }}
          />
        </Field>
      </section>
    )
  }

  if (!node) {
    return (
      <section style={panelStyle} data-testid="workflow-node-panel-empty">
        <h3 style={sectionTitleStyle}>节点配置</h3>
        <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>
          选中画布上的节点或连线后在这里编辑。
        </p>
      </section>
    )
  }

  const config = node.config
  const update = (patch: Record<string, unknown>, label?: string) =>
    props.onChangeNode(node.key, { ...config, ...patch }, label)
  const agentTasks = nodes.filter((item) => item.type === 'agent_task')
  const splits = nodes.filter((item) => item.type === 'parallel_split')

  return (
    <section style={panelStyle} data-testid="workflow-node-panel">
      <h3 style={sectionTitleStyle}>节点配置 · {NODE_TYPE_LABELS[node.type]}</h3>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>{node.key}</div>

      <Field label="显示名 label">
        <input
          data-testid="workflow-panel-label"
          style={inputStyle}
          value={node.label ?? ''}
          onChange={(event) => update({}, event.target.value)}
        />
      </Field>

      {node.type === 'agent_task' && (
        <>
          <Field label="workRole（必填）">
            <input
              data-testid="workflow-panel-work-role"
              style={inputStyle}
              value={asString(asRecord(config.assignmentSelector).workRole)}
              onChange={(event) =>
                update({
                  assignmentSelector: {
                    ...asRecord(config.assignmentSelector),
                    workRole: event.target.value,
                  },
                })
              }
            />
          </Field>
          <Field label="agentProfileId（可选）">
            <input
              data-testid="workflow-panel-agent-profile"
              style={inputStyle}
              value={asString(asRecord(config.assignmentSelector).agentProfileId)}
              onChange={(event) => {
                const selector = { ...asRecord(config.assignmentSelector) }
                const value = event.target.value.trim()
                if (value === '') delete selector.agentProfileId
                else selector.agentProfileId = value
                update({ assignmentSelector: selector })
              }}
            />
          </Field>
          <Field label="taskPrompt">
            <textarea
              data-testid="workflow-panel-task-prompt"
              style={{ ...inputStyle, minHeight: 72 }}
              value={asString(config.taskPrompt)}
              onChange={(event) => update({ taskPrompt: event.target.value })}
            />
          </Field>
          <Field label="workingDirectoryPolicy">
            <select
              data-testid="workflow-panel-working-dir"
              style={inputStyle}
              value={asString(config.workingDirectoryPolicy, 'work_root')}
              onChange={(event) => update({ workingDirectoryPolicy: event.target.value })}
            >
              <option value="work_root">work_root</option>
              <option value="worktree">worktree</option>
            </select>
          </Field>
          <Field label="artifacts（JSON 数组）">
            <textarea
              data-testid="workflow-panel-artifacts"
              style={{ ...inputStyle, minHeight: 64, fontFamily: 'ui-monospace, monospace' }}
              value={JSON.stringify(config.artifacts ?? [], null, 2)}
              onChange={(event) => {
                try {
                  const parsed: unknown = JSON.parse(event.target.value)
                  if (!Array.isArray(parsed)) {
                    setArtifactError('artifacts 必须是数组')
                    return
                  }
                  setArtifactError(null)
                  update({ artifacts: parsed })
                } catch {
                  setArtifactError('JSON 解析失败')
                }
              }}
            />
            {artifactError && (
              <span
                data-testid="workflow-panel-artifacts-error"
                style={{ color: colors.red, fontSize: 11 }}
              >
                {artifactError}
              </span>
            )}
          </Field>
        </>
      )}

      {node.type === 'human_approval' && (
        <>
          <Field label="被审批任务 target.nodeKey">
            <select
              data-testid="workflow-panel-target"
              style={inputStyle}
              value={asString(asRecord(config.target).nodeKey)}
              onChange={(event) =>
                update({
                  target: { ...asRecord(config.target), nodeKey: event.target.value },
                })
              }
            >
              <option value="">（未选择）</option>
              {agentTasks.map((task) => (
                <option key={task.key} value={task.key}>
                  {task.key}
                </option>
              ))}
            </select>
          </Field>
          <Field label="审批时点 phase">
            <select
              data-testid="workflow-panel-phase"
              style={inputStyle}
              value={asString(asRecord(config.target).phase, 'after_execute')}
              onChange={(event) =>
                update({
                  target: { ...asRecord(config.target), phase: event.target.value },
                })
              }
            >
              <option value="before_execute">before_execute</option>
              <option value="after_execute">after_execute</option>
            </select>
          </Field>
          <Field label="返工目标 reworkTargetNodeKey（可选）">
            <select
              data-testid="workflow-panel-rework-target"
              style={inputStyle}
              value={asString(config.reworkTargetNodeKey)}
              onChange={(event) => {
                const next = { ...config }
                if (event.target.value === '') delete next.reworkTargetNodeKey
                else next.reworkTargetNodeKey = event.target.value
                props.onChangeNode(node.key, next, node.label)
              }}
            >
              <option value="">（默认 target）</option>
              {agentTasks.map((task) => (
                <option key={task.key} value={task.key}>
                  {task.key}
                </option>
              ))}
            </select>
          </Field>
          <Field label="instructions">
            <textarea
              data-testid="workflow-panel-instructions"
              style={{ ...inputStyle, minHeight: 56 }}
              value={asString(config.instructions)}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </Field>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <Field label="条件字段（白名单路径）">
            <input
              data-testid="workflow-panel-cond-path"
              style={inputStyle}
              value={asString(asRecord(asRecord(config.predicate).left).path)}
              onChange={(event) =>
                update({
                  predicate: {
                    ...asRecord(config.predicate),
                    left: { kind: 'field', path: event.target.value },
                  },
                })
              }
            />
          </Field>
          <Field label="运算符">
            <select
              data-testid="workflow-panel-cond-op"
              style={inputStyle}
              value={asString(asRecord(config.predicate).op, '==')}
              onChange={(event) =>
                update({
                  predicate: { ...asRecord(config.predicate), op: event.target.value },
                })
              }
            >
              {['==', '!=', '>', '>=', '<', '<=', 'in'].map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </Field>
          <Field label="比较值（JSON 字面量；字符串可带引号）">
            <input
              data-testid="workflow-panel-cond-value"
              style={inputStyle}
              value={literalText(asRecord(asRecord(config.predicate).right).value)}
              onChange={(event) =>
                update({
                  predicate: {
                    ...asRecord(config.predicate),
                    right: { kind: 'literal', value: parseLiteral(event.target.value) },
                  },
                })
              }
            />
          </Field>
          <Field label="假分支 falseBranch">
            <div style={rowStyle}>
              <select
                data-testid="workflow-panel-false-branch"
                style={inputStyle}
                value={typeof config.falseBranch === 'string' ? config.falseBranch : 'rework'}
                onChange={(event) => {
                  if (event.target.value === 'edge') {
                    update({ falseBranch: 'edge' })
                  } else {
                    const report = asRecord(config.falseBranch).reportNodeKey
                    update({
                      falseBranch: {
                        kind: 'rework',
                        reportNodeKey: asString(report, agentTasks[0]?.key ?? ''),
                      },
                    })
                  }
                }}
              >
                <option value="edge">edge（画布出边）</option>
                <option value="rework">rework（引擎返工）</option>
              </select>
              {typeof config.falseBranch === 'object' && (
                <select
                  data-testid="workflow-panel-report-node"
                  style={inputStyle}
                  value={asString(asRecord(config.falseBranch).reportNodeKey)}
                  onChange={(event) =>
                    update({
                      falseBranch: { kind: 'rework', reportNodeKey: event.target.value },
                    })
                  }
                >
                  <option value="">（未选择）</option>
                  {agentTasks.map((task) => (
                    <option key={task.key} value={task.key}>
                      {task.key}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        </>
      )}

      {node.type === 'join' && (
        <Field label="配对的分叉节点 pairWith">
          <select
            data-testid="workflow-panel-pair-with"
            style={inputStyle}
            value={asString(config.pairWith)}
            onChange={(event) => update({ pairWith: event.target.value })}
          >
            <option value="">（未选择）</option>
            {splits.map((split) => (
              <option key={split.key} value={split.key}>
                {split.key}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.type === 'parallel_split' && (
        <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>
          strategy 固定为 fan_out_all；每条出边的 branchKey 在连线面板配置。
        </p>
      )}

      {(node.type === 'start' || node.type === 'end') && (
        <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>该节点没有可配置项。</p>
      )}
    </section>
  )
}
