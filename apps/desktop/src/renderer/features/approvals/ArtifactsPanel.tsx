import { useCallback, useEffect, useState } from 'react'
import {
  buttonStyle,
  colors,
  inputStyle,
  labelStyle,
  panelStyle,
  sectionTitleStyle,
} from '../../components/styles'
import { ApiError, api } from '../../services/api'

/**
 * S5-3：Artifact 预览/下载接线。只读服务面走 artifact.preview / artifact.list
 * 显式 IPC；无通用透传，无删除/写入入口。
 *
 * S5-3b：支持两种形态——
 * - 独立 tab（交付物导航）：手输 Work ID（MVP 交互，CTO 裁定接受）；
 * - Works 页嵌入：传入 `workId` prop，自动加载，无手输框。
 */
export const ARTIFACTS_PANEL_MARKER = 'agentra-product-artifacts'

type ArtifactSummary = {
  id: string
  name: string
  artifactType: string
  versions: { id: string; version: number; checksum: string }[]
}

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

export function ArtifactsPanel({ workId: fixedWorkId }: { workId?: string } = {}) {
  const [manualWorkId, setManualWorkId] = useState('')
  const workId = fixedWorkId ?? manualWorkId
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; version: number; content: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (workId.trim().length === 0) return
    setBusy(true)
    setError(null)
    try {
      setArtifacts(await api.listArtifacts(workId.trim()))
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }, [workId])

  // 嵌入形态：workId 变化自动加载；独立形态：用户点「加载」。
  useEffect(() => {
    if (fixedWorkId !== undefined && fixedWorkId.trim().length > 0) void load()
  }, [fixedWorkId, load])

  const showPreview = async (artifactId: string, version?: number): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.previewArtifact(artifactId, version)
      const text = decodeBase64(result.contentBase64)
      setPreview({
        name: result.artifact.name,
        version: result.version.version,
        content: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…（截断）` : text,
      })
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-agentra-page={ARTIFACTS_PANEL_MARKER}>
      <h2 style={sectionTitleStyle}>Artifact 交付物</h2>
      {fixedWorkId === undefined && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="artifact-work-id">
              Work ID
            </label>
            <input
              id="artifact-work-id"
              style={{ ...inputStyle, width: 280 }}
              value={manualWorkId}
              onChange={(event) => setManualWorkId(event.target.value)}
              placeholder="输入 Work ID 加载其交付物"
            />
          </div>
          <button type="button" style={buttonStyle} onClick={() => void load()} disabled={busy}>
            加载
          </button>
        </div>
      )}
      {fixedWorkId !== undefined && (
        <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>Work {fixedWorkId}</p>
      )}

      {error && (
        <div
          style={{ ...panelStyle, borderColor: colors.red, color: colors.red, marginBottom: 12 }}
        >
          {error}
        </div>
      )}

      {preview && (
        <div style={{ ...panelStyle, marginBottom: 12 }}>
          <strong style={{ fontSize: 13 }}>
            {preview.name} · v{preview.version}
          </strong>
          <pre
            style={{
              marginTop: 8,
              padding: 10,
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            {preview.content}
          </pre>
        </div>
      )}

      {artifacts.length === 0 ? (
        <div style={{ color: colors.muted, fontSize: 13 }}>
          {workId.trim().length > 0 ? '该 Work 暂无交付物。' : '尚未加载任何交付物。'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {artifacts.map((artifact) => (
            <div key={artifact.id} style={panelStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{artifact.name}</strong>
                <span style={{ color: colors.muted, fontSize: 12 }}>{artifact.artifactType}</span>
                <span style={{ color: colors.muted, fontSize: 12 }}>
                  {artifact.versions.length} 个版本
                </span>
                {artifact.versions.map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => void showPreview(artifact.id, version.version)}
                  >
                    预览 v{version.version}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
