import type { Backup } from '@agentra/protocol'
import { ApiError } from '../services/api'
import { colors } from './styles'

/** 备份页本地展示逻辑：不扩展全局 StatusBadge/错误系统。 */

export function formatBackupTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function backupTypeLabel(type: Backup['type']): string {
  return type === 'manual' ? '手动备份' : '恢复前自动备份'
}

export function backupStatusLabel(status: Backup['status']): string {
  switch (status) {
    case 'creating':
      return '创建中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'verified':
      return '已校验'
    case 'restored':
      return '已恢复'
  }
}

export function backupStatusColor(status: Backup['status']): string {
  switch (status) {
    case 'creating':
      return colors.amber
    case 'completed':
    case 'verified':
      return colors.green
    case 'failed':
      return colors.red
    case 'restored':
      return colors.blue
  }
}

export function backupRecordError(error: unknown): string | null {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error
  if (
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function detailErrorCode(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const code = (detail as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

const BACKUP_ERROR_MESSAGES: Record<string, string> = {
  BACKUP_NOT_FOUND: '备份记录不存在，可能已被移除。',
  BACKUP_DIR_UNREADABLE: '备份目录不可读或不可写，请检查数据目录权限。',
  EXPORT_PATH_INVALID: '导出目标不合法：必须是备份目录之外的目录，且不能是备份自身或其子目录。',
  INTEGRITY_CHECK_FAILED: '备份数据库完整性检查失败，备份未完成。',
  ARTIFACT_MISSING: '有 Artifact 文件缺失，备份未完成。',
}

export function formatBackupError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error)
  }
  if (error.code === 'NOT_READY') {
    return 'Core 未连接，请稍后重试。'
  }
  const detailCode = detailErrorCode(error.detail)
  if (detailCode) {
    return BACKUP_ERROR_MESSAGES[detailCode] ?? `${error.code}: ${error.message}（${detailCode}）`
  }
  return `${error.code}: ${error.message}`
}
