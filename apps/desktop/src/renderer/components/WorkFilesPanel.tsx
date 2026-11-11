import type { WorkFilesListResult } from '@agentra/protocol'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../services/api'
import { Icon } from './Icon'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function WorkFilesPanel({ workId }: { workId: string }) {
  const [data, setData] = useState<WorkFilesListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setData(await api.listWorkFiles(workId))
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
    } finally {
      setBusy(false)
    }
  }, [workId])

  useEffect(() => {
    void load()
  }, [load])

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(path)
      setTimeout(() => setCopied(null), 1200)
    } catch {
      // 剪贴板不可用时保留路径展示，不阻塞阅读。
    }
  }

  const rootPath = data?.rootPath ?? ''
  const rootPrefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          交付文件
          {data && <span className="faint">{data.files.length} 个文件</span>}
        </div>
        <div className="right">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={13} />
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 10 }}>
        {error && <div className="banner error">{error}</div>}
        {data && (
          <div className="work-files-root" title={data.rootPath}>
            {data.rootPath}
          </div>
        )}
        {!data && !error ? (
          <div className="empty-state">正在读取工作目录…</div>
        ) : data && !data.exists ? (
          <div className="empty-state">工作目录不存在或不可读。</div>
        ) : data && data.files.length === 0 ? (
          <div className="empty-state">工作目录里还没有文件。</div>
        ) : (
          <div className="work-files">
            {data?.files.map((file) => {
              const fullPath = `${rootPrefix}${file.path}`
              return (
                <div className="work-file-row" key={file.path}>
                  <Icon name="file" size={13} />
                  <span className="work-file-path" title={file.path}>
                    {file.path}
                  </span>
                  <span className="work-file-meta">
                    {formatSize(file.size)} · {new Date(file.modifiedAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    className="message-expand"
                    onClick={() => void copyPath(fullPath)}
                  >
                    {copied === fullPath ? '已复制' : '复制路径'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {data?.truncated && (
          <div className="faint" style={{ fontSize: 10.5 }}>
            文件较多，仅显示前 200 个。
          </div>
        )}
      </div>
    </div>
  )
}
