import { describe, expect, it } from 'vitest'
import { ApiError } from '../services/api'
import {
  backupRecordError,
  backupStatusColor,
  backupStatusLabel,
  backupTypeLabel,
  detailErrorCode,
  formatBackupError,
  formatBackupTime,
} from './backup-format'
import { colors } from './styles'

describe('backup-format', () => {
  it('labels backup types', () => {
    expect(backupTypeLabel('manual')).toBe('手动备份')
    expect(backupTypeLabel('pre_restore')).toBe('恢复前自动备份')
  })

  it('labels backup statuses', () => {
    expect(backupStatusLabel('creating')).toBe('创建中')
    expect(backupStatusLabel('completed')).toBe('已完成')
    expect(backupStatusLabel('failed')).toBe('失败')
    expect(backupStatusLabel('verified')).toBe('已校验')
    expect(backupStatusLabel('restored')).toBe('已恢复')
  })

  it('maps status colors without changing global StatusBadge', () => {
    expect(backupStatusColor('verified')).toBe(colors.green)
    expect(backupStatusColor('completed')).toBe(colors.green)
    expect(backupStatusColor('failed')).toBe(colors.red)
    expect(backupStatusColor('creating')).toBe(colors.amber)
    expect(backupStatusColor('restored')).toBe(colors.blue)
  })

  it('formats valid timestamps and leaves invalid values untouched', () => {
    expect(formatBackupTime('not-a-date')).toBe('not-a-date')
    const formatted = formatBackupTime('2026-11-02T00:00:00.000Z')
    expect(typeof formatted).toBe('string')
    expect(formatted.length).toBeGreaterThan(0)
  })

  it('extracts backup record error messages', () => {
    expect(backupRecordError(null)).toBeNull()
    expect(backupRecordError('plain failure')).toBe('plain failure')
    expect(backupRecordError({ message: 'artifact missing' })).toBe('artifact missing')
    expect(backupRecordError({ at: '2026-11-02' })).toBe('{"at":"2026-11-02"}')
  })

  it('extracts detail.code without inventing values', () => {
    expect(detailErrorCode({ code: 'EXPORT_PATH_INVALID' })).toBe('EXPORT_PATH_INVALID')
    expect(detailErrorCode({ code: 1 })).toBeNull()
    expect(detailErrorCode(null)).toBeNull()
    expect(detailErrorCode('EXPORT_PATH_INVALID')).toBeNull()
  })

  it('maps backup business error codes to readable messages', () => {
    expect(
      formatBackupError(new ApiError('INVALID_PARAMS', 'raw', { code: 'EXPORT_PATH_INVALID' })),
    ).toContain('导出目标不合法')
    expect(
      formatBackupError(new ApiError('INVALID_PARAMS', 'raw', { code: 'INTEGRITY_CHECK_FAILED' })),
    ).toContain('完整性检查失败')
    expect(
      formatBackupError(new ApiError('INVALID_PARAMS', 'raw', { code: 'ARTIFACT_MISSING' })),
    ).toContain('Artifact 文件缺失')
  })

  it('maps NOT_READY and keeps fallback code/message', () => {
    expect(formatBackupError(new ApiError('NOT_READY', 'core closed'))).toContain('Core 未连接')
    expect(formatBackupError(new ApiError('INTERNAL', 'boom'))).toBe('INTERNAL: boom')
  })

  it('keeps unknown detail codes in the fallback message', () => {
    expect(
      formatBackupError(new ApiError('INVALID_PARAMS', 'raw', { code: 'SOMETHING_NEW' })),
    ).toBe('INVALID_PARAMS: raw（SOMETHING_NEW）')
  })

  it('handles non-ApiError values', () => {
    expect(formatBackupError(new Error('plain'))).toBe('plain')
    expect(formatBackupError('text')).toBe('text')
  })
})
