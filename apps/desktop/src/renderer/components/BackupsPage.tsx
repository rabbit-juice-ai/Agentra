import type { Backup } from '@agentra/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../services/api'
import {
  backupRecordError,
  backupStatusLabel,
  backupTypeLabel,
  formatBackupError,
  formatBackupTime,
} from './backup-format'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'

/**
 * 构建产物检查用标记：备份中心是产品功能，发布构建必须包含。
 * 见 scripts/check-release-bundle.mjs（S55-1B-2 暂未登记，待后续批次接入）。
 */
export const BACKUPS_PAGE_MARKER = 'agentra-product-backups'

function statusClass(status: Backup['status']): string {
  switch (status) {
    case 'completed':
    case 'verified':
      return 'done'
    case 'failed':
      return 'danger'
    case 'creating':
      return 'warn'
    case 'restored':
      return 'running'
    default:
      return 'pending'
  }
}

export function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [exportOpenId, setExportOpenId] = useState<string | null>(null)
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
        setExportOpenId(null)
      } catch (err) {
        setError(formatBackupError(err))
      } finally {
        setExportingId(null)
      }
    },
    [exportTargets, exportingId],
  )

  const latest = backups[0]
  const verifiedCount = backups.filter(
    (backup) => backup.status === 'verified' || backup.status === 'completed',
  ).length

  return (
    <div data-agentra-page={BACKUPS_PAGE_MARKER} className="page">
      <PageHeader
        title="备份中心"
        subtitle={
          latest
            ? `最近备份 ${formatBackupTime(latest.createdAt)} · ${verifiedCount} 个完整 · 共 ${backups.length} 个备份`
            : '备份包含 SQLite 数据库、托管 Artifact 文件与 manifest/SHA-256 校验值'
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={loading || creating}
              onClick={() => void load()}
            >
              <Icon name="refresh" size={14} />
              {loading ? '刷新中…' : '刷新'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={creating || loading}
              onClick={() => void create()}
            >
              <Icon name="archive" size={14} />
              {creating ? '正在创建…' : '立即备份'}
            </button>
          </>
        }
      />

      {error && (
        <div className="banner error" role="alert">
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {notice && <div className="banner success">{notice}</div>}

      <div className="card">
        <div className="card-head">
          <div className="card-title">备份记录</div>
          <div className="right">
            <span className="faint" style={{ fontSize: 10.5 }}>
              最近 50 条
            </span>
          </div>
        </div>
        {loading && backups.length === 0 ? (
          <div className="empty-state">正在加载备份…</div>
        ) : backups.length === 0 ? (
          <div className="empty-state">还没有备份。点击“立即备份”生成第一份。</div>
        ) : (
          <table className="backup-table">
            <thead>
              <tr>
                <th>备份</th>
                <th>类型</th>
                <th>创建时间</th>
                <th>Artifact 文件</th>
                <th>完整性</th>
                <th className="right">操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => {
                const failure = backupRecordError(backup.error)
                const exporting = exportingId === backup.id
                return (
                  <tr key={backup.id}>
                    <td>
                      <strong className="mono">{backup.id}</strong>
                      <div className="faint mono" style={{ fontSize: 10, marginTop: 2 }}>
                        {backup.dbSha256 ? `sha256 ${backup.dbSha256.slice(0, 12)}…` : 'sha256 —'}
                      </div>
                      {backup.status === 'failed' && failure && (
                        <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 3 }}>
                          {failure}
                        </div>
                      )}
                    </td>
                    <td>{backupTypeLabel(backup.type)}</td>
                    <td>{formatBackupTime(backup.createdAt)}</td>
                    <td>{backup.fileCount}</td>
                    <td>
                      <span className={`pill ${statusClass(backup.status)}`}>
                        {backupStatusLabel(backup.status)}
                      </span>
                    </td>
                    <td className="right">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={exporting}
                        onClick={() =>
                          setExportOpenId((current) => (current === backup.id ? null : backup.id))
                        }
                      >
                        导出
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {exportOpenId && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <div className="card-title">导出备份 · {exportOpenId}</div>
            <div className="right">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setExportOpenId(null)}
              >
                <Icon name="x" />
              </button>
            </div>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="backup-export-target">导出目标目录（必须位于备份目录之外）</label>
              <input
                id="backup-export-target"
                className="input"
                value={exportTargets[exportOpenId] ?? ''}
                onChange={(event) =>
                  setExportTargets((current) => ({
                    ...current,
                    [exportOpenId]: event.target.value,
                  }))
                }
                placeholder="/Users/you/Desktop/agentra-backups"
                disabled={exportingId !== null}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                exportingId !== null || (exportTargets[exportOpenId] ?? '').trim().length === 0
              }
              onClick={() => void exportOne(exportOpenId)}
            >
              {exportingId === exportOpenId ? '导出中…' : '确认导出'}
            </button>
          </div>
        </div>
      )}

      <div
        className="danger-zone"
        style={{ borderColor: 'var(--border-2)', background: 'var(--surface)' }}
      >
        <span className="task-icon" style={{ background: 'var(--fill)', color: 'var(--muted)' }}>
          <Icon name="alert" />
        </span>
        <div className="text">
          <h4 style={{ color: 'var(--text)' }}>恢复数据（当前构建未开放）</h4>
          <p>
            恢复预检、维护模式与原子替换属于独立阶段；本构建只提供备份创建与导出。恢复入口在专项验收通过前不会出现在界面上。
          </p>
        </div>
        <button type="button" className="btn btn-secondary" disabled>
          暂不可用
        </button>
      </div>
    </div>
  )
}
