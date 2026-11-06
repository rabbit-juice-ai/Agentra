import { type Approval, WorkflowArtifactRef } from '@agentra/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { approvalTypeLabel } from '../../components/approval-label'
import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runFilter, setRunFilter] = useState('all')

  const refresh = useCallback(async () => {
    try {
      // Core 查询真实 pending 集合；不依赖无人生成的 URL hash。
      setLoading(true)
      setError(null)
      const collected: PendingRow[] = (await api.listPendingApprovals()).map((approval) => ({
        approval,
        runId: approval.workflowRunId,
      }))
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
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
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

  const runIds = useMemo(
    () =>
      [...new Set(rows.map((row) => row.runId))].sort((left, right) => left.localeCompare(right)),
    [rows],
  )
  const visibleRows = useMemo(
    () => (runFilter === 'all' ? rows : rows.filter((row) => row.runId === runFilter)),
    [rows, runFilter],
  )

  const selectedRow =
    visibleRows.find((row) => row.approval.id === selectedId) ?? visibleRows[0] ?? null

  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelectedId(null)
      return
    }
    if (!visibleRows.some((row) => row.approval.id === selectedId)) {
      setSelectedId(visibleRows[0]?.approval.id ?? null)
    }
  }, [visibleRows, selectedId])

  const oldest = rows[0]
  const commentError = selectedRow ? commentErrors[selectedRow.approval.id] : false

  return (
    <div data-agentra-page={APPROVALS_PAGE_MARKER} className="page">
      <PageHeader
        title={
          <>
            审批中心
            {rows.length > 0 && <span className="pill accent plain">{rows.length}</span>}
          </>
        }
        subtitle={
          rows.length === 0
            ? '当前没有等待中的审批 · MVP 无自动超时决策'
            : `${rows.length} 项待处理 · 最久等待 ${waitingDuration(oldest?.approval.requestedAt ?? new Date().toISOString(), nowMs)} · 按等待时长排序`
        }
        actions={
          <>
            <select
              className="select"
              value={runFilter}
              onChange={(event) => setRunFilter(event.target.value)}
              aria-label="按运行筛选"
            >
              <option value="all">全部运行</option>
              {runIds.map((runId) => (
                <option key={runId} value={runId}>
                  {runId.slice(0, 18)}…
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title="刷新"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <Icon name="refresh" />
            </button>
          </>
        }
      />

      {error && <div className="banner error">{error}</div>}

      {loading && rows.length === 0 ? (
        <div className="empty-state">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state">当前没有等待中的审批。</div>
        </div>
      ) : (
        <div className="split wide">
          <div className="card list-card">
            <div className="card-head">
              <div className="card-title">待处理</div>
              <div className="right">
                <span className="faint" style={{ fontSize: 10.5 }}>
                  等待最久优先
                </span>
              </div>
            </div>
            <div className="list-scroll">
              {visibleRows.map((row) => {
                const isSelected = selectedRow?.approval.id === row.approval.id
                return (
                  <button
                    type="button"
                    key={row.approval.id}
                    className={`inbox-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedId(row.approval.id)}
                  >
                    <span className="avatar" style={{ marginTop: 2 }}>
                      {approvalTypeLabel(row.approval.approvalType).slice(0, 1) || '审'}
                    </span>
                    <div className="inbox-main">
                      <div className="inbox-name">
                        {approvalTypeLabel(row.approval.approvalType)} · 第 {row.approval.round} 轮
                      </div>
                      <div className="inbox-meta">
                        <span className="mono">{row.runId.slice(0, 14)}…</span>
                        <span>·</span>
                        <span className="pill warn">等你回复</span>
                      </div>
                    </div>
                    <span className="inbox-age">
                      {waitingDuration(row.approval.requestedAt, nowMs)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {selectedRow && (
            <div className="card detail-pane">
              <div className="detail-head">
                <div>
                  <div className="card-title">
                    {approvalTypeLabel(selectedRow.approval.approvalType)}
                    <span className="pill warn">等待审批</span>
                  </div>
                  <div className="card-sub" style={{ marginTop: 4 }}>
                    run {selectedRow.runId} · 请求人 {selectedRow.approval.requestedBy} · 第{' '}
                    {selectedRow.approval.round} 轮 · 已等待{' '}
                    {waitingDuration(selectedRow.approval.requestedAt, nowMs)}
                  </div>
                </div>
              </div>

              <div className="detail-tabs">
                <button type="button" className="tab active">
                  交付物
                </button>
              </div>

              <div className="detail-body">
                <ApprovalContext approval={selectedRow.approval} />
                <div className="meta-grid">
                  <div className="meta-cell">
                    <div className="k">审批类型</div>
                    <div className="v">{approvalTypeLabel(selectedRow.approval.approvalType)}</div>
                  </div>
                  <div className="meta-cell">
                    <div className="k">轮次</div>
                    <div className="v">第 {selectedRow.approval.round} 轮</div>
                  </div>
                  <div className="meta-cell">
                    <div className="k">目标节点</div>
                    <div className="v mono">
                      {selectedRow.approval.targetNodeRunId ?? '执行前审批'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="decision-bar">
                <textarea
                  className="textarea"
                  value={commentDrafts[selectedRow.approval.id] ?? ''}
                  onChange={(event) =>
                    setCommentDrafts((prev) => ({
                      ...prev,
                      [selectedRow.approval.id]: event.target.value,
                    }))
                  }
                  placeholder="审批意见（选择“要求修改”时必填）"
                />
                {commentError && (
                  <div style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 5 }}>
                    request_changes 必须填写意见（A3）。
                  </div>
                )}
                <div className="decision-actions">
                  <span className="hint">
                    要求修改将退回目标节点并产生新的审批轮次；驳回保持分支暂停。
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => void decide(selectedRow, 'reject')}
                  >
                    驳回
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void decide(selectedRow, 'request_changes')}
                  >
                    要求修改
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void decide(selectedRow, 'approve')}
                  >
                    通过
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ApprovalContext({ approval }: { approval: Approval }) {
  const [context, setContext] = useState('')
  const [refs, setRefs] = useState<WorkflowArtifactRef[]>([])
  const [preview, setPreview] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState('')

  useEffect(() => {
    let alive = true
    void api
      .getWorkflowRun(approval.workflowRunId)
      .then((view) => {
        if (!alive) return
        const target = view.nodes.find((node) => node.id === approval.targetNodeRunId)
        setContext(
          `Work ${view.run.workId} · 任务审批${target?.status ? ` · ${target.status}` : ''}`,
        )
        const output = target?.output
        const values =
          output && typeof output === 'object' && 'artifacts' in output ? output.artifacts : []
        setRefs(WorkflowArtifactRef.array().parse(values))
      })
      .catch((err) => {
        if (alive) setError(String(err))
      })
    return () => {
      alive = false
    }
  }, [approval.workflowRunId, approval.targetNodeRunId])

  const showPreview = (ref: WorkflowArtifactRef): void => {
    setError(null)
    void api
      .previewArtifact(ref.artifactId, ref.version)
      .then((file) => {
        if (file.version.id !== ref.versionId || file.version.checksum !== ref.checksum) {
          throw new Error('Artifact version mismatch')
        }
        const bytes = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0))
        setPreview(new TextDecoder().decode(bytes))
        setPreviewName(`${ref.name} v${ref.version}`)
      })
      .catch((err) => setError(String(err)))
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="faint" style={{ fontSize: 11.5 }}>
        {context || '正在加载运行上下文…'}
      </div>
      {error && <div className="banner error">{error}</div>}
      {refs.length === 0 ? (
        <div className="empty-state" style={{ padding: '16px 0' }}>
          该审批没有关联交付物。
        </div>
      ) : (
        refs.map((ref) => (
          <div className="doc" key={ref.versionId}>
            <div className="doc-head">
              <span className="artifact-icon">
                <Icon name="doc" size={14} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="doc-title">
                  {ref.name} · v{ref.version}
                </div>
                <div className="doc-meta mono">SHA-256 {ref.checksum.slice(0, 16)}…</div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => showPreview(ref)}
                >
                  预览
                </button>
              </div>
            </div>
            {preview && previewName === `${ref.name} v${ref.version}` && (
              <div className="doc-body">
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'var(--mono)',
                    fontSize: 11.5,
                  }}
                >
                  {preview}
                </pre>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
