import { newId } from '@agentra/shared'
import type { Database } from '../database'

export const ARTIFACT_TYPES = ['markdown', 'text', 'code', 'image', 'other'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export type ArtifactCreatedByType = 'user' | 'agent' | 'system'

export type ArtifactRecord = {
  id: string
  workId: string
  nodeRunId: string | null
  assignmentId: string | null
  artifactType: ArtifactType
  name: string
  description: string
  storagePath: string
  mimeType: string | null
  createdByType: ArtifactCreatedByType
  createdById: string | null
  createdAt: string
}

export type ArtifactVersionRecord = {
  id: string
  artifactId: string
  version: number
  storagePath: string
  checksum: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type CreateArtifactInput = {
  id?: string
  workId: string
  nodeRunId?: string | null
  assignmentId?: string | null
  artifactType: ArtifactType
  name: string
  description?: string
  storagePath: string
  mimeType?: string | null
  createdByType: ArtifactCreatedByType
  createdById?: string | null
}

export type CreateArtifactVersionInput = {
  id?: string
  artifactId: string
  version: number
  storagePath: string
  checksum: string
  metadata?: Record<string, unknown>
}

type ArtifactRow = {
  id: string
  work_id: string
  node_run_id: string | null
  assignment_id: string | null
  artifact_type: string
  name: string
  description: string
  storage_path: string
  mime_type: string | null
  created_by_type: string
  created_by_id: string | null
  created_at: string
}

type ArtifactVersionRow = {
  id: string
  artifact_id: string
  version: number
  storage_path: string
  checksum: string
  metadata_json: string
  created_at: string
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  if (!(ARTIFACT_TYPES as readonly string[]).includes(row.artifact_type)) {
    throw new Error(`unexpected artifacts.artifact_type: ${row.artifact_type}`)
  }
  const createdByType = row.created_by_type
  if (createdByType !== 'user' && createdByType !== 'agent' && createdByType !== 'system') {
    throw new Error(`unexpected artifacts.created_by_type: ${createdByType}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    nodeRunId: row.node_run_id,
    assignmentId: row.assignment_id,
    artifactType: row.artifact_type as ArtifactType,
    name: row.name,
    description: row.description,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    createdByType,
    createdById: row.created_by_id,
    createdAt: row.created_at,
  }
}

function parseMetadata(raw: string, id: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `artifact_versions.metadata_json(${id}): invalid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`artifact_versions.metadata_json(${id}): expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function toVersion(row: ArtifactVersionRow): ArtifactVersionRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    storagePath: row.storage_path,
    checksum: row.checksum,
    metadata: parseMetadata(row.metadata_json, row.id),
    createdAt: row.created_at,
  }
}

/** artifacts / artifact_versions 数据访问；不自己开事务。 */
export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  createArtifact(input: CreateArtifactInput, now: string): ArtifactRecord {
    const id = input.id ?? newId('art')
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, work_id, node_run_id, assignment_id, artifact_type, name, description,
           storage_path, mime_type, created_by_type, created_by_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workId,
        input.nodeRunId ?? null,
        input.assignmentId ?? null,
        input.artifactType,
        input.name,
        input.description ?? '',
        input.storagePath,
        input.mimeType ?? null,
        input.createdByType,
        input.createdById ?? null,
        now,
      )
    const created = this.getArtifact(id)
    if (!created) throw new Error(`artifacts(${id}) missing after insert`)
    return created
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtifactRow
      | undefined
    return row ? toArtifact(row) : null
  }

  findByWorkAndName(workId: string, name: string): ArtifactRecord | null {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE work_id = ? AND name = ?')
      .get(workId, name) as ArtifactRow | undefined
    return row ? toArtifact(row) : null
  }

  listByWork(workId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE work_id = ? ORDER BY created_at ASC, id ASC')
      .all(workId) as ArtifactRow[]
    return rows.map(toArtifact)
  }

  listByNodeRun(nodeRunId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE node_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(nodeRunId) as ArtifactRow[]
    return rows.map(toArtifact)
  }

  createVersion(input: CreateArtifactVersionInput, now: string): ArtifactVersionRecord {
    const id = input.id ?? newId('artv')
    this.db
      .prepare(
        `INSERT INTO artifact_versions (
           id, artifact_id, version, storage_path, checksum, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.artifactId,
        input.version,
        input.storagePath,
        input.checksum,
        JSON.stringify(input.metadata ?? {}),
        now,
      )
    const created = this.getVersion(id)
    if (!created) throw new Error(`artifact_versions(${id}) missing after insert`)
    return created
  }

  getVersion(id: string): ArtifactVersionRecord | null {
    const row = this.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id) as
      | ArtifactVersionRow
      | undefined
    return row ? toVersion(row) : null
  }

  findByArtifactAndVersion(artifactId: string, version: number): ArtifactVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(artifactId, version) as ArtifactVersionRow | undefined
    return row ? toVersion(row) : null
  }

  latestVersion(artifactId: string): ArtifactVersionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(artifactId) as ArtifactVersionRow | undefined
    return row ? toVersion(row) : null
  }

  nextVersion(artifactId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE artifact_id = ?',
      )
      .get(artifactId) as { next: number }
    return row.next
  }

  /** 备份用：全部 Artifact 版本（含 storage_path）。 */
  listAllVersions(): ArtifactVersionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifact_versions ORDER BY artifact_id ASC, version ASC')
      .all() as ArtifactVersionRow[]
    return rows.map(toVersion)
  }

  listVersions(artifactId: string): ArtifactVersionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC, id ASC')
      .all(artifactId) as ArtifactVersionRow[]
    return rows.map(toVersion)
  }
}
