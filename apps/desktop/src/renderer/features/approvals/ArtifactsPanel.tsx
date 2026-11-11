import type { Work } from '@agentra/protocol'
import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
import { ApiError, api } from '../../services/api'

/**
 * S5-3：Artifact 预览/下载接线。只读服务面走 artifact.preview / artifact.list
 * 显式 IPC；无通用透传，无删除/写入入口。
 *
 * S5-3b：支持两种形态——
 * - 独立 tab（交付物导航）：选择 Work 后加载；
 * - Works 页嵌入：传入 `workId` prop，自动加载，无选择框。
 */
export const ARTIFACTS_PANEL_MARKER = 'agentra-product-artifacts'

type ArtifactSummary = {
  id: string
  name: string
  artifactType: string
  versions: { id: string; version: number; checksum: string }[]
}

type Selection = { artifactId: string; version: number }

function decodeBase64(base64: string): string {
  // atob 在 Electron renderer 可用；二进制内容按 UTF-8 尽力显示。
  try {
    return decodeURIComponent(
      Array.from(atob(base64))
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
  } catch {
    return `(二进制内容，${base64.length} 字符 base64)`
  }
}

export function ArtifactsPanel({
  workId: fixedWorkId,
  works,
}: {
  workId?: string
  works?: Work[]
} = {}) {
  const [selectedWorkId, setSelectedWorkId] = useState('')
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<{
    name: string
    version: number
    checksum: string
    content: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadedWorkId, setLoadedWorkId] = useState<string | null>(null)

  const load = useCallback(async (targetWorkId: string): Promise<void> => {
    if (targetWorkId.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      const list = await api.listArtifacts(targetWorkId.trim())
      setArtifacts(list)
      setLoadedWorkId(targetWorkId.trim())
      const first = list[0]
      const latest = first?.versions[first.versions.length - 1]
      setSelection(first && latest ? { artifactId: first.id, version: latest.version } : null)
      if (!first) setPreview(null)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  // 嵌入形态：workId 变化自动加载；独立形态：选择 Work 后加载。
  useEffect(() => {
    if (fixedWorkId !== undefined && fixedWorkId.trim().length > 0) {
      void load(fixedWorkId)
    }
  }, [fixedWorkId, load])

  useEffect(() => {
    if (fixedWorkId === undefined && selectedWorkId === '' && works && works.length > 0) {
      setSelectedWorkId(works[0]?.id ?? '')
    }
  }, [fixedWorkId, selectedWorkId, works])

  useEffect(() => {
    if (!selection) return
    let alive = true
    setBusy(true)
    setError(null)
    void api
      .previewArtifact(selection.artifactId, selection.version)
      .then((result) => {
        if (!alive) return
        const text = decodeBase64(result.contentBase64)
        setPreview({
          name: result.artifact.name,
          version: result.version.version,
          checksum: result.version.checksum,
          content: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…（截断）` : text,
        })
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [selection])

  const selectedArtifact =
    artifacts.find((artifact) => artifact.id === selection?.artifactId) ?? null

  return (
    <div data-agentra-page={ARTIFACTS_PANEL_MARKER} className="page">
      <PageHeader
        title="交付物"
        subtitle={
          loadedWorkId ? `${artifacts.length} 个交付物` : '选择 Work 查看其运行产出的交付物'
        }
        actions={
          fixedWorkId === undefined ? (
            <>
              <select
                className="select"
                value={selectedWorkId}
                onChange={(event) => setSelectedWorkId(event.target.value)}
                aria-label="选择 Work"
              >
                <option value="">选择 Work</option>
                {(works ?? []).map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || selectedWorkId === ''}
                onClick={() => void load(selectedWorkId)}
              >
                加载
              </button>
            </>
          ) : null
        }
      />

      {error && <div className="banner error">{error}</div>}

      {loadedWorkId === null ? (
        <div className="card">
          <div className="empty-state">
            {fixedWorkId === undefined ? '选择上方 Work 后点击“加载”。' : '正在加载交付物…'}
          </div>
        </div>
      ) : artifacts.length === 0 ? (
        <div className="card">
          <div className="empty-state">该 Work 暂无交付物。</div>
        </div>
      ) : (
        <div className="split artifacts">
          <div className="card list-card">
            <div className="card-head">
              <div className="card-title">全部交付物</div>
              <div className="right">
                <span className="faint" style={{ fontSize: 10.5 }}>
                  按更新时间
                </span>
              </div>
            </div>
            <div className="list-scroll">
              {artifacts.map((artifact) => {
                const latest = artifact.versions[artifact.versions.length - 1]
                const isSelected = selection?.artifactId === artifact.id
                return (
                  <button
                    type="button"
                    key={artifact.id}
                    className={`inbox-row ${isSelected ? 'selected' : ''}`}
                    onClick={() =>
                      latest && setSelection({ artifactId: artifact.id, version: latest.version })
                    }
                  >
                    <span className="artifact-icon">
                      <Icon name="doc" size={14} />
                    </span>
                    <div className="inbox-main">
                      <div className="inbox-name">{artifact.name}</div>
                      <div className="inbox-meta">
                        <span>{artifact.artifactType}</span>
                        <span>·</span>
                        <span>{artifact.versions.length} 个版本</span>
                      </div>
                    </div>
                    {latest && <span className="inbox-age">v{latest.version}</span>}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="card detail-pane">
            <div className="detail-head">
              <div>
                <div className="card-title">
                  {selectedArtifact?.name ?? '选择交付物'}
                  {preview && <span className="pill done">v{preview.version}</span>}
                </div>
                <div className="card-sub" style={{ marginTop: 4 }}>
                  {selectedArtifact?.artifactType ?? '只读'} · Work {loadedWorkId}
                </div>
              </div>
              <div className="right">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!preview}
                  onClick={() => {
                    if (preview) void navigator.clipboard.writeText(preview.content)
                  }}
                >
                  复制内容
                </button>
              </div>
            </div>

            <div className="detail-tabs">
              <button type="button" className="tab active">
                内容
              </button>
            </div>

            <div className="detail-body">
              {selectedArtifact && selectedArtifact.versions.length > 1 && (
                <div className="filter-chips" style={{ marginBottom: 0 }}>
                  {selectedArtifact.versions.map((version) => (
                    <button
                      type="button"
                      key={version.id}
                      className={`chip-filter ${selection?.version === version.version ? 'on' : ''}`}
                      onClick={() =>
                        setSelection({
                          artifactId: selectedArtifact.id,
                          version: version.version,
                        })
                      }
                    >
                      v{version.version}
                    </button>
                  ))}
                </div>
              )}

              {preview ? (
                <>
                  <div className="meta-grid">
                    <div className="meta-cell">
                      <div className="k">版本</div>
                      <div className="v">{preview.version}</div>
                    </div>
                    <div className="meta-cell">
                      <div className="k">类型</div>
                      <div className="v">{selectedArtifact?.artifactType ?? '—'}</div>
                    </div>
                    <div className="meta-cell">
                      <div className="k">校验值</div>
                      <div className="v mono">{preview.checksum.slice(0, 16)}…</div>
                    </div>
                  </div>
                  <div className="doc">
                    <div className="doc-head">
                      <span className="artifact-icon">
                        <Icon name="doc" size={14} />
                      </span>
                      <div>
                        <div className="doc-title">{preview.name}</div>
                        <div className="doc-meta">只读 · 由运行产出</div>
                      </div>
                    </div>
                    <div className="doc-body">
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'var(--mono)',
                          fontSize: 11.5,
                        }}
                      >
                        {preview.content}
                      </pre>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state">选择左侧交付物查看内容。</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
