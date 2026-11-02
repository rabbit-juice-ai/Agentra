import type { Backup } from '@agentra/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../services/api'
import {
  backupRecordError,
  backupStatusColor,
  backupStatusLabel,
  backupTypeLabel,
  formatBackupError,
  formatBackupTime,
} from './backup-format'
import {
  buttonStyle,
  colors,
  inputStyle,
  labelStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from './styles'

/**
 * 构建产物检查用标记：备份中心是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs（S55-1B-2 暂未登记，待后续批次接入）。
 */
export const BACKUPS_PAGE_MARKER = 'agentra-product-backups'

function BackupStatus({ status }: { status: Backup['status'] }) {
  const color = backupStatusColor(status)
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 8px',
        borderRadius: 10,
        color,
        border: `1px solid ${color}`,
        background: '#ffffff',
      }}
    >
      {backupStatusLabel(status)}
    </span>
  )
}

export function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [exportTargets, setExportTargets] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setBackups(await api.listBackups())
    } catch (err) {
      setError(formatBackupError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = useCallback(async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const backup = await api.createBackup()
      setNotice(`备份已创建：${backup.id}（${backupStatusLabel(backup.status)}）`)
      await load()
    } catch (err) {
      setError(formatBackupError(err))
    } finally {
      setCreating(false)
    }
  }, [creating, load])

  const exportOne = useCallback(
    async (backupId: string): Promise<void> => {
      if (exportingId !== null) return
      const targetDir = (exportTargets[backupId] ?? '').trim()
      if (targetDir.length === 0) {
        setError('请先输入导出目标目录。')
        return
      }
      setExportingId(backupId)
      setError(null)
      setNotice(null)
      try {
        const target = await api.exportBackup(backupId, targetDir)
        setNotice(`已导出到：${target}`)
      } catch (err) {
        setError(formatBackupError(err))
      } finally {
        setExportingId(null)
      }
    },
    [exportTargets, exportingId],
  )

  return (
    <div data-agentra-page={BACKUPS_PAGE_MARKER} style={{ display: 'grid', gap: 16 }}>
      <section style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ ...sectionTitleStyle, margin: 0 }}>备份中心</h2>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={creating || loading}
            onClick={() => void create()}
          >
            {creating ? '正在创建…' : '创建备份'}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={loading || creating}
            onClick={() => void load()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: colors.muted, margin: '10px 0 0' }}>
          备份包含 SQLite 数据库、托管 Artifact 文件与 manifest/SHA-256
          校验值；导出目标必须位于备份目录之外。
        </p>
      </section>

      {error && (
        <div
          role="alert"
          style={{ ...panelStyle, borderColor: colors.red, color: colors.red, fontSize: 13 }}
        >
          {error}
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: 12 }}
            disabled={loading}
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      )}
      {notice && (
        <div
          style={{ ...panelStyle, borderColor: colors.green, color: colors.green, fontSize: 13 }}
        >
          {notice}
        </div>
      )}

      <section style={panelStyle}>
        <h2 style={sectionTitleStyle}>备份列表（最近 50 条）</h2>
        {loading && backups.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>正在加载备份…</p>
        ) : backups.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>
            还没有备份。点击“创建备份”生成第一份。
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {backups.map((backup) => {
              const failure = backupRecordError(backup.error)
              const target = exportTargets[backup.id] ?? ''
              const exporting = exportingId === backup.id
              const exportDisabled = exportingId !== null || target.trim().length === 0
              return (
                <div
                  key={backup.id}
                  style={{
                    border: `1px solid ${colors.border}`,
                    borderRadius: 8,
                    padding: 12,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{backupTypeLabel(backup.type)}</strong>
                    <BackupStatus status={backup.status} />
                    <span style={{ fontSize: 12, color: colors.muted }}>
                      {formatBackupTime(backup.createdAt)}
                    </span>
                    <span style={{ fontSize: 12, color: colors.muted }}>
                      Artifact 文件 {backup.fileCount}
                    </span>
                    <code
                      title={backup.dbSha256 ?? undefined}
                      style={{ fontSize: 11, color: colors.muted }}
                    >
                      {backup.dbSha256 ? `${backup.dbSha256.slice(0, 12)}…` : 'db sha256 —'}
                    </code>
                  </div>
                  <div style={{ fontSize: 12, color: colors.muted }}>
                    存储路径 <code>{backup.storagePath}</code>
                  </div>
                  {backup.status === 'failed' && failure && (
                    <div style={{ fontSize: 12, color: colors.red }}>失败原因：{failure}</div>
                  )}
                  <div
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
                  >
                    <label style={{ flex: '1 1 260px' }}>
                      <span style={labelStyle}>导出目标目录</span>
                      <input
                        style={inputStyle}
                        value={target}
                        onChange={(event) =>
                          setExportTargets((current) => ({
                            ...current,
                            [backup.id]: event.target.value,
                          }))
                        }
                        placeholder="/Users/you/Desktop/agentra-backups"
                        disabled={exporting}
                      />
                    </label>
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={exportDisabled}
                      onClick={() => void exportOne(backup.id)}
                    >
                      {exporting ? '导出中…' : '导出'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
