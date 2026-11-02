import type { Backup } from '@agentra/protocol'
import { RpcMethodError } from '@agentra/protocol'
import type { BackupRecord } from '../db/repositories/backup-repository'
import { BackupError, type BackupService } from './backup-service'

function toDto(record: BackupRecord): Backup {
  return {
    id: record.id,
    type: record.type,
    manifestVersion: record.manifestVersion,
    dbSha256: record.dbSha256,
    fileCount: record.fileCount,
    status: record.status,
    storagePath: record.storagePath,
    error: record.error,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    verifiedAt: record.verifiedAt,
  }
}

function mapError(error: unknown): Error {
  if (error instanceof BackupError) {
    throw new RpcMethodError('INVALID_PARAMS', error.message, { code: error.code })
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** S55-1：备份链只读/创建 API（恢复属 S55-2）。 */
export class BackupRpcService {
  constructor(private readonly backups: BackupService) {}

  create(type?: 'manual' | 'pre_restore'): Backup {
    try {
      return toDto(this.backups.create(type ? { type } : {}))
    } catch (error) {
      throw mapError(error)
    }
  }

  list(limit?: number): Backup[] {
    return this.backups.list(limit).map(toDto)
  }

  exportTo(backupId: string, targetDir: string): string {
    try {
      return this.backups.exportTo(backupId, targetDir)
    } catch (error) {
      throw mapError(error)
    }
  }
}
