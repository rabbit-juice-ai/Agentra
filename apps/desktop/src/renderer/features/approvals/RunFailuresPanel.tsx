import { useCallback, useEffect, useState } from 'react'
import { StatusBadge } from '../../components/StatusBadge'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  panelStyle,
  sectionTitleStyle,
} from '../../components/styles'
import { ApiError, api } from '../../services/api'

/**
 * 构建产物检查用的标记：失败终态呈现是产品功能（阶段 5 任务清单 M1），
 * 发布构建必须包含。见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const RUN_FAILURES_PANEL_MARKER = 'agentra-product-run-failures'

type RunSummary = { id: string; status: string; startedAt: string | null; endedAt: string | null }
type NodeView = {
  id: string
  workflowNodeKey: string
  status: string
  attempt: number
  error: { category?: string; message?: string } | null
  startedAt: string | null
  endedAt: string | null
}

/** UI 侧把 unknown 的 error/output 收窄成可展示形态。 */
function asNodeView(raw: {
  id: string
  workflowNodeKey: string
  status: string
  attempt: number
  error: unknown
  startedAt: string | null
  endedAt: string | null
}): NodeView {
  const error =
    typeof raw.error === 'object' && raw.error !== null
      ? (raw.error as { category?: string; message?: string })
      : null
  return {
    id: raw.id,
    workflowNodeKey: raw.workflowNodeKey,
    status: raw.status,
    attempt: raw.attempt,
    error,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
  }
}

/** 失败/卡住的 NodeRun：failed / reconciliation_required 是需要人工介入的终态。 */
const ATTENTION_STATUSES = new Set(['failed', 'reconciliation_required'])

export function RunFailuresPanel({ workId }: { workId: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [expanded, setExpanded] = useState<Record<string, NodeView[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [handling, setHandling] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setRuns(await api.listWorkflowRunsByWork(workId))
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }, [workId])

  useEffect(() => {
    if (workId.trim().length > 0) void load()
  }, [workId, load])

  const openRun = useCallback(async (runId: string) => {
    setBusy(true)
    setError(null)
    try {
      const view = await api.getWorkflowRun(runId)
      setExpanded((prev) => ({ ...prev, [runId]: view.nodes.map(asNodeView) }))
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 超限人工处理（阶段 5 第 180 行）。MVP 边界（CTO 裁定）：
   * - 继续返工 / 接管都经「审批决策」链路落库（request_changes 决策 + 审计行），
   *   不实现 Human Takeover 原语（D-012/D-015 排除）；
   * - 终止在 MVP 暂不提供 Run 级 RPC（Work 级终止在 Works 页已有）。
   */
  const handleExhausted = useCallback(
    async (runId: string, nodeKey: string, action: 'request_changes' | 'reject') => {
      setHandling(`${runId}:${nodeKey}`)
      setError(null)
      try {
        // 找到该节点最新 attempt 的 NodeRun → 它上面的 pending/最近审批
        const view = await api.getWorkflowRun(runId)
        const node = view.nodes
          .filter((candidate) => candidate.workflowNodeKey === nodeKey)
          .sort((left, right) => right.attempt - left.attempt)[0]
        if (!node) throw new Error(`node ${nodeKey} not found in run ${runId}`)
        const approval = await api.getApproval(node.id)
        if (!approval.approval) {
          throw new Error(
            `节点 ${nodeKey} 没有待决策的审批；超限人工处理走审批决策链路（先重进审批节点）`,
          )
        }
        await api.decideApproval({
          nodeRunId: node.id,
          decision: action,
          decidedBy: 'local-user',
          ...(action === 'request_changes' ? { comment: '人工处理：继续返工' } : {}),
        })
        await load()
        await openRun(runId)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setHandling(null)
      }
    },
    [load, openRun],
  )

  if (workId.trim().length === 0) {
    return null
  }

  return (
    <div data-agentra-page={RUN_FAILURES_PANEL_MARKER}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={sectionTitleStyle}>运行状态与失败终态</h3>
        <button type="button" style={buttonStyle} onClick={() => void load()} disabled={busy}>
          刷新
        </button>
      </div>

      {error && (
        <div
          style={{ ...panelStyle, borderColor: colors.red, color: colors.red, marginBottom: 12 }}
        >
          {error}
        </div>
      )}

      {runs.length === 0 ? (
        <div style={{ color: colors.muted, fontSize: 13 }}>该 Work 暂无 WorkflowRun。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((run) => {
            const nodes = expanded[run.id]
            const attention = nodes?.filter((node) => ATTENTION_STATUSES.has(node.status)) ?? []
            return (
              <div key={run.id} style={panelStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <StatusBadge status={run.status} />
                  <span style={{ fontSize: 12, color: colors.muted }}>run {run.id}</span>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() =>
                      nodes
                        ? setExpanded((prev) => ({ ...prev, [run.id]: [] }))
                        : void openRun(run.id)
                    }
                  >
                    {nodes ? '收起' : '查看节点'}
                  </button>
                </div>

                {nodes && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {nodes.length === 0 ? (
                      <span style={{ color: colors.muted, fontSize: 12 }}>无节点记录。</span>
                    ) : (
                      nodes.map((node) => (
                        <div
                          key={`${node.id}-${node.attempt}`}
                          style={{
                            padding: '6px 10px',
                            border: `1px solid ${ATTENTION_STATUSES.has(node.status) ? colors.red : colors.border}`,
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              gap: 10,
                              alignItems: 'center',
                              flexWrap: 'wrap',
                            }}
                          >
                            <StatusBadge status={node.status} />
                            <strong>{node.workflowNodeKey}</strong>
                            <span style={{ color: colors.muted }}>attempt {node.attempt}</span>
                            {node.endedAt && (
                              <span style={{ color: colors.muted }}>
                                结束 {new Date(node.endedAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                          {node.error && (
                            <div style={{ marginTop: 4, color: colors.red }}>
                              失败原因[{node.error.category ?? 'unknown'}]：{node.error.message}
                              {node.startedAt && (
                                <button
                                  type="button"
                                  style={{ ...buttonStyle, marginLeft: 8 }}
                                  onClick={() => void openRun(run.id)}
                                >
                                  日志入口（重查节点详情）
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                    {attention.length > 0 && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: '6px 10px',
                          border: `1px solid ${colors.amber}`,
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        <strong>返工超限 / 人工处理（{attention.length} 个节点待处理）</strong>
                        {attention.map((node) => (
                          <div
                            key={`${node.id}-handle`}
                            style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}
                          >
                            <span>
                              {node.workflowNodeKey}（attempt {node.attempt}，{node.status}）
                            </span>
                            <button
                              type="button"
                              style={primarySmall}
                              disabled={handling !== null}
                              onClick={() =>
                                void handleExhausted(
                                  run.id,
                                  node.workflowNodeKey,
                                  'request_changes',
                                )
                              }
                            >
                              继续返工
                            </button>
                            <button
                              type="button"
                              style={dangerButtonStyle}
                              disabled={handling !== null}
                              onClick={() =>
                                void handleExhausted(run.id, node.workflowNodeKey, 'reject')
                              }
                            >
                              接管（拒绝并暂停）
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const primarySmall: React.CSSProperties = {
  ...buttonStyle,
  padding: '2px 8px',
  fontSize: 12,
}
