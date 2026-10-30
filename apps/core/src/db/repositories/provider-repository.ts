import {
  type ProviderHealthStatus,
  type RuntimeInfo,
  type RuntimeProvider,
  RuntimeProvider as RuntimeProviderSchema,
} from '@agentra/protocol'
import { ProviderCapabilities } from '@agentra/runtime-sdk'
import type { Database } from '../database'
import { parseJsonColumn, serializeJsonColumn } from '../json'

type ProviderRow = {
  id: string
  provider_type: string
  provider_name: string
  executable_path: string | null
  version: string | null
  capabilities_json: string
  health_status: string
  last_discovered_at: string | null
  created_at: string
  updated_at: string
}

function toProvider(row: ProviderRow): RuntimeProvider {
  return RuntimeProviderSchema.parse({
    id: row.id,
    providerType: row.provider_type,
    providerName: row.provider_name,
    executablePath: row.executable_path,
    version: row.version,
    capabilities: parseJsonColumn(
      ProviderCapabilities,
      row.capabilities_json,
      `runtime_providers.capabilities_json(${row.id})`,
    ),
    healthStatus: row.health_status,
    lastDiscoveredAt: row.last_discovered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

/** RuntimeProvider Registry 的持久化层：发现结果 upsert，不物理删除。 */
export class ProviderRepository {
  constructor(private readonly db: Database) {}

  upsertDiscovered(info: RuntimeInfo, now: string): RuntimeProvider {
    const capabilities = serializeJsonColumn(
      ProviderCapabilities,
      info.capabilities,
      'provider.capabilities',
    )
    this.db
      .prepare(
        `INSERT INTO runtime_providers (
          id, provider_type, provider_name, executable_path, version, capabilities_json,
          health_status, last_discovered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_type = excluded.provider_type,
          provider_name = excluded.provider_name,
          executable_path = excluded.executable_path,
          version = excluded.version,
          capabilities_json = excluded.capabilities_json,
          health_status = excluded.health_status,
          last_discovered_at = excluded.last_discovered_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        info.providerId,
        info.providerType,
        info.providerName,
        info.executablePath,
        info.version,
        capabilities,
        info.healthStatus,
        info.discoveredAt,
        now,
        now,
      )
    const provider = this.get(info.providerId)
    if (!provider) throw new Error(`provider upsert failed: ${info.providerId}`)
    return provider
  }

  list(): RuntimeProvider[] {
    const rows = this.db
      .prepare('SELECT * FROM runtime_providers ORDER BY provider_name ASC, id ASC')
      .all() as ProviderRow[]
    return rows.map(toProvider)
  }

  get(id: string): RuntimeProvider | null {
    const row = this.db.prepare('SELECT * FROM runtime_providers WHERE id = ?').get(id) as
      | ProviderRow
      | undefined
    return row ? toProvider(row) : null
  }

  setHealth(id: string, status: ProviderHealthStatus, now: string): void {
    this.db
      .prepare('UPDATE runtime_providers SET health_status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id)
  }
}
