import type { Backup } from '@agentra/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupRpcTimeoutMs } from '../../shared/api'
import { ApiError, api, unwrap } from './api'

describe('ApiError detail 透传', () => {
  it('carries detail from the RPC failure into ApiError', async () => {
    const detail = {
      violations: [{ violation: 'start_invalid', message: 'expected exactly one start node' }],
    }
    try {
      await unwrap(
        Promise.resolve({
          ok: false as const,
          error: { code: 'INVALID_PARAMS', message: 'workflow definition is invalid', detail },
        }),
      )
      throw new Error('expected unwrap to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INVALID_PARAMS')
      expect(apiError.message).toBe('workflow definition is invalid')
      expect(apiError.detail).toEqual(detail)
    }
  })

  it('leaves detail undefined when the failure has none', async () => {
    try {
      await unwrap(
        Promise.resolve({
          ok: false as const,
          error: { code: 'INTERNAL', message: 'boom' },
        }),
      )
    } catch (error) {
      expect((error as ApiError).detail).toBeUndefined()
    }
  })

  it('returns the result on success', async () => {
    await expect(
      unwrap(Promise.resolve({ ok: true as const, result: { value: 1 } })),
    ).resolves.toEqual({
      value: 1,
    })
  })
})

describe('backup RPC wiring', () => {
  type BackupApiStub = {
    createBackup: ReturnType<typeof vi.fn>
    listBackups: ReturnType<typeof vi.fn>
    exportBackup: ReturnType<typeof vi.fn>
  }

  let backupApi: BackupApiStub

  beforeEach(() => {
    backupApi = {
      createBackup: vi.fn(),
      listBackups: vi.fn(),
      exportBackup: vi.fn(),
    }
    vi.stubGlobal('window', { agentra: backupApi })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const backup: Backup = {
    id: 'bak-1',
    type: 'manual',
    manifestVersion: 1,
    dbSha256: 'a'.repeat(64),
    fileCount: 2,
    status: 'verified',
    storagePath: '/tmp/backups/bak-1',
    error: null,
    createdAt: '2026-11-02T00:00:00.000Z',
    completedAt: null,
    verifiedAt: '2026-11-02T00:00:00.000Z',
  }

  it('createBackup calls the IPC with no params and returns the backup', async () => {
    backupApi.createBackup.mockResolvedValue({ ok: true, result: { backup } })
    await expect(api.createBackup()).resolves.toEqual(backup)
    expect(backupApi.createBackup).toHaveBeenCalledWith()
  })

  it('listBackups defaults to limit 50 and returns backups', async () => {
    backupApi.listBackups.mockResolvedValue({ ok: true, result: { backups: [backup] } })
    await expect(api.listBackups()).resolves.toEqual([backup])
    expect(backupApi.listBackups).toHaveBeenCalledWith({ limit: 50 })
  })

  it('listBackups passes a custom limit', async () => {
    backupApi.listBackups.mockResolvedValue({ ok: true, result: { backups: [] } })
    await expect(api.listBackups(10)).resolves.toEqual([])
    expect(backupApi.listBackups).toHaveBeenCalledWith({ limit: 10 })
  })

  it('exportBackup passes backupId/targetDir and returns target', async () => {
    backupApi.exportBackup.mockResolvedValue({
      ok: true,
      result: { target: '/tmp/export/bak-1' },
    })
    await expect(api.exportBackup('bak-1', '/tmp/export')).resolves.toBe('/tmp/export/bak-1')
    expect(backupApi.exportBackup).toHaveBeenCalledWith({
      backupId: 'bak-1',
      targetDir: '/tmp/export',
    })
  })

  it('createBackup surfaces code/message/detail', async () => {
    backupApi.createBackup.mockResolvedValue({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: 'backup failed',
        detail: { code: 'INTEGRITY_CHECK_FAILED' },
      },
    })
    try {
      await api.createBackup()
      throw new Error('expected createBackup to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INVALID_PARAMS')
      expect(apiError.message).toBe('backup failed')
      expect(apiError.detail).toEqual({ code: 'INTEGRITY_CHECK_FAILED' })
    }
  })

  it('listBackups surfaces code/message without inventing detail', async () => {
    backupApi.listBackups.mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL', message: 'list failed' },
    })
    try {
      await api.listBackups()
      throw new Error('expected listBackups to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INTERNAL')
      expect(apiError.message).toBe('list failed')
      expect(apiError.detail).toBeUndefined()
    }
  })

  it('exportBackup surfaces EXPORT_PATH_INVALID detail', async () => {
    backupApi.exportBackup.mockResolvedValue({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: 'export target must be outside backupsRoot',
        detail: { code: 'EXPORT_PATH_INVALID' },
      },
    })
    try {
      await api.exportBackup('bak-1', '/tmp/backups/bak-1')
      throw new Error('expected exportBackup to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('INVALID_PARAMS')
      expect(apiError.detail).toEqual({ code: 'EXPORT_PATH_INVALID' })
    }
  })

  it('applies 120s to create/export and keeps the default for list', () => {
    expect(backupRpcTimeoutMs('create')).toBe(120_000)
    expect(backupRpcTimeoutMs('export')).toBe(120_000)
    expect(backupRpcTimeoutMs('list')).toBeUndefined()
  })
})
