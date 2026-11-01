import type { Approval } from '@agentra/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StatusBadge } from '../../components/StatusBadge'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from '../../components/styles'
import { ApiError, api } from '../../services/api'

/**
 * 构建产物检查用的标记：审批中心是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs 的正向断言。
 */
export const APPROVALS_PAGE_MARKER = 'agentra-product-approvals'

/** 等待时长展示（只展示与排序，不自动决策——PRD §5.7 无审批超时）。 */
function waitingDuration(requestedAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(requestedAt))
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

type PendingRow = {
  approval: Approval
  /** 审批节点所在 run（等待时长排序在 run 内做，run 之间按 requested_at） */
  runId: string
}

export function ApprovalsPage() {
  const [rows, setRows] = useState<PendingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [commentErrors, setCommentErrors] = useState<Record<string, boolean>>({})
  const [nowMs, setNowMs] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    try {
      // 审批中心按 Run 查询 pending；这里聚合各 running Run 的 pending 审批。
      // 当前阶段没有 run 列表 RPC，pending 审批经 run id 由 Work/Workflow 视图带入；
      // 审批中心自身维护最近活跃 run 集合（可从 URL/选中态进入）。
      setLoading(true)
      setError(null)
      const runIds = pendingRunIdsFromLocation()
      const collected: PendingRow[] = []
      for (const runId of runIds) {
        const approvals = await api.listPendingApprovals(runId)
        for (const approval of approvals) collected.push({ approval, runId })
      }
      // 按等待时长排序：等待最久的在前（验收要求）
      collected.sort(
        (left, right) =>
          Date.parse(left.approval.requestedAt) - Date.parse(right.approval.requestedAt),
      )
      setRows(collected)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 等待时长每 30 秒刷新一次展示
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const decide = useCallback(
    async (row: PendingRow, decision: 'approve' | 'request_changes' | 'reject') => {
      const comment = (commentDrafts[row.approval.id] ?? '').trim()
      if (decision === 'request_changes' && comment.length === 0) {
        // request_changes 强制意见输入（A3）
        setCommentErrors((prev) => ({ ...prev, [row.approval.id]: true }))
        return
      }
      setBusy(true)
      setError(null)
      try {
        await api.decideApproval({
          nodeRunId: row.approval.nodeRunId,
          decision,
          decidedBy: 'local-user',
          ...(comment.length > 0 ? { comment } : {}),
        })
        setCommentDrafts((prev) => {
          const next = { ...prev }
          delete next[row.approval.id]
          return next
        })
        setCommentErrors((prev) => ({ ...prev, [row.approval.id]: false }))
        await refresh()
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      } finally {
        setBusy(false)
      }
    },
    [commentDrafts, refresh],
  )

  const sorted = useMemo(() => rows, [rows])

  return (
    <div data-agentra-page={APPROVALS_PAGE_MARKER}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={sectionTitleStyle}>审批中心</h2>
        <button type="button" style={buttonStyle} onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </div>
      <p style={{ color: colors.muted, fontSize: 12 }}>
        等待中的审批按等待时长排序；request_changes 必须填写意见。MVP 无自动超时决策。
      </p>

      {error && (
        <div
          style={{ ...panelStyle, borderColor: colors.red, color: colors.red, marginBottom: 12 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: colors.muted, fontSize: 13 }}>加载中…</div>
      ) : sorted.length === 0 ? (
        <div style={{ color: colors.muted, fontSize: 13 }}>当前没有等待中的审批。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sorted.map(({ approval, runId }) => (
            <div key={approval.id} style={panelStyle}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 8,
                  flexWrap: 'wrap',
                }}
              >
                <StatusBadge status={approval.status} />
                <strong style={{ fontSize: 13 }}>{approval.approvalType}</strong>
                <span style={{ color: colors.muted, fontSize: 12 }}>round {approval.round}</span>
                <span style={{ color: colors.muted, fontSize: 12 }}>run {runId}</span>
                <span style={{ color: colors.amber, fontSize: 12 }}>
                  已等待 {waitingDuration(approval.requestedAt, nowMs)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
                节点 {approval.nodeRunId}
                {approval.targetNodeRunId ? ` · 目标 ${approval.targetNodeRunId}` : ''}
              </div>

              <div>
                <label style={labelStyle} htmlFor={`comment-${approval.id}`}>
                  意见（request_changes 必填）
                </label>
                <input
                  id={`comment-${approval.id}`}
                  style={{
                    ...inputStyle,
                    width: '100%',
                    ...(commentErrors[approval.id] ? { borderColor: colors.red } : {}),
                  }}
                  value={commentDrafts[approval.id] ?? ''}
                  onChange={(event) =>
                    setCommentDrafts((prev) => ({
                      ...prev,
                      [approval.id]: event.target.value,
                    }))
                  }
                  placeholder="request_changes 时必须填写修改意见"
                />
                {commentErrors[approval.id] && (
                  <div style={{ color: colors.red, fontSize: 12, marginTop: 4 }}>
                    request_changes 必须填写意见（A3）。
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={busy}
                  onClick={() => void decide({ approval, runId }, 'approve')}
                >
                  批准
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => void decide({ approval, runId }, 'request_changes')}
                >
                  要求修改
                </button>
                <button
                  type="button"
                  style={dangerButtonStyle}
                  disabled={busy}
                  onClick={() => void decide({ approval, runId }, 'reject')}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * MVP 阶段审批中心的 Run 集合来源：URL hash（#approvals/<runId>[,<runId>]）。
 * Work/Workflow 视图跳转审批中心时携带 run 列表；直接打开页面时为空集合。
 * 不做隐藏的全局扫描（没有 run 列表 RPC，与执行入口隔离一致）。
 */
function pendingRunIdsFromLocation(): string[] {
  if (typeof window === 'undefined') return []
  const hash = window.location.hash
  const match = /#approvals\/(.+)$/.exec(hash)
  const captured = match?.[1]
  if (!captured) return []
  return captured
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}
