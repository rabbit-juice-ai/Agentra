import type {
  WorkflowRun,
  WorkflowRunGetResult,
  WorkflowTemplate,
  WorkflowVersion,
} from '@agentra/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { buttonStyle, inputStyle, panelStyle, primaryButtonStyle } from '../../components/styles'
import { unwrap } from '../../services/api'

/** 生产 Run 入口；业务状态只取 Core，不在 renderer 推进状态机。 */
export function WorkflowRunsPanel({ workId, active }: { workId: string; active: boolean }) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [view, setView] = useState<WorkflowRunGetResult | null>(null)
  const [selectedRun, setSelectedRun] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<{ versionId: string; requestId: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRuns((await unwrap(window.agentra.listWorkflowRunsByWork({ workId }))).runs)
      if (selectedRun) setView(await unwrap(window.agentra.getWorkflowRun({ runId: selectedRun })))
    } catch (err) {
      setError(String(err))
    }
  }, [workId, selectedRun])
  useEffect(() => {
    let alive = true
    void unwrap(window.agentra.listWorkflowTemplates({}))
      .then((result) => {
        if (alive) setTemplates(result.templates)
      })
      .catch((err) => {
        if (alive) setError(String(err))
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    let alive = true
    setVersionId('')
    setVersions([])
    if (templateId)
      void unwrap(window.agentra.listWorkflowVersions({ templateId }))
        .then((result) => {
          if (!alive) return
          const published = result.versions.filter((v) => v.status === 'published')
          setVersions(published)
          setVersionId(published.at(-1)?.id ?? '')
        })
        .catch((err) => {
          if (alive) setError(String(err))
        })
    return () => {
      alive = false
    }
  }, [templateId])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [refresh])

  async function start() {
    if (busy || !versionId) return
    setBusy(true)
    setError('')
    // 连接超时后保留请求键；再点启动是重试同一次请求，而非再启动一个 Run。
    if (request.current?.versionId !== versionId)
      request.current = { versionId, requestId: crypto.randomUUID() }
    try {
      const result = await unwrap(
        window.agentra.startWorkflowRun({
          workId,
          workflowVersionId: versionId,
          requestId: request.current.requestId,
        }),
      )
      setSelectedRun(result.run.id)
      if (result.schedulingError) setError(result.schedulingError)
      else request.current = null
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={panelStyle}>
      <h3>Workflow 运行</h3>
      <p>
        使用已发布版本与本 Work 的 Assignment。执行采用无人值守模式；工具权限由 Agent
        配置决定，执行中不弹出工具授权请求。
      </p>
      <select
        aria-label="Workflow 模板"
        style={inputStyle}
        value={templateId}
        onChange={(e) => setTemplateId(e.target.value)}
        disabled={busy}
      >
        <option value="">选择 Workflow 模板</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select
        aria-label="已发布版本"
        style={inputStyle}
        value={versionId}
        onChange={(e) => setVersionId(e.target.value)}
        disabled={busy}
      >
        <option value="">选择已发布版本</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            v{v.version}
          </option>
        ))}
      </select>
      <button
        type="button"
        style={primaryButtonStyle}
        disabled={!active || !versionId || busy}
        onClick={() => void start()}
      >
        {busy ? '启动中…' : '启动 Workflow'}
      </button>
      {!active && <p>请先激活 Work，再启动 Workflow。</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={buttonStyle} onClick={() => void refresh()}>
        刷新运行状态
      </button>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <button type="button" onClick={() => setSelectedRun(run.id)}>
              {run.id} · {run.status}
            </button>
          </li>
        ))}
      </ul>
      {view && (
        <div>
          <h4>
            {view.run.id} · {view.run.status}
          </h4>
          {view.branches.map((b) => (
            <p key={b.id}>
              分支 {b.branchKey}：{b.status} {b.pauseReason}
            </p>
          ))}
          {view.nodes.map((n) => (
            <div key={n.id}>
              <strong>{n.workflowNodeKey}</strong> · attempt {n.attempt} · {n.status}
              <small> {n.id}</small>
              {n.error != null && <pre>{JSON.stringify(n.error, null, 2)}</pre>}
              {n.output != null && <pre>{JSON.stringify(n.output, null, 2)}</pre>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
