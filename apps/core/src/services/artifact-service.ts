import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type {
  ArtifactRecord,
  ArtifactRepository,
  ArtifactType,
  ArtifactVersionRecord,
} from '../db/repositories/artifact-repository'

export type ArtifactServiceErrorCode =
  | 'WORK_NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'INVALID_TYPE'
  | 'INVALID_NAME'
  | 'CONTENT_REQUIRED'
  | 'CHECKSUM_MISMATCH'

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactError'
  }
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Artifact 创建与版本化（S5-2，DATABASE §2.8）。
 *
 * - 内容文件落盘到 `<artifactsRoot>/<workId>/<artifactId>/v<version>/<name>`，
 *   与库内 storage_path 一致；写入前做路径边界检查（不允许越出 artifactsRoot）。
 * - 版本号由 MAX(version)+1 派生并在事务内创建；artifact_versions 表有不可变触发器，
 *   「返工 / 重新提交产生新版本、历史版本不覆盖」由 DB 触发器兜底。
 * - checksum 为 sha256，写库前与内容重算值比对，防落盘与记账不一致。
 */
export class ArtifactService {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactRepository,
    private readonly artifactsRoot: string,
    private readonly works: { get(id: string): { id: string; status: string } | null },
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createVersion(input: Parameters<ArtifactService['createVersionRecord']>[0]): {
    artifact: ArtifactRecord
    version: ArtifactVersionRecord
  } {
    return this.createBatch(
      [input],
      (records) => records[0] as { artifact: ArtifactRecord; version: ArtifactVersionRecord },
    )
  }

  /** 文件先独占写入，版本记录与 NodeRun 完成同一事务；失败只移除本次新建文件。 */
  createBatch<T>(
    inputs: Array<Parameters<ArtifactService['createVersionRecord']>[0]>,
    commit: (records: Array<{ artifact: ArtifactRecord; version: ArtifactVersionRecord }>) => T,
  ): T {
    const ownedFiles: string[] = []
    try {
      return transaction(this.db, () =>
        commit(inputs.map((input) => this.createVersionRecord(input, ownedFiles))),
      )
    } catch (error) {
      for (const file of ownedFiles) {
        try {
          fs.unlinkSync(file)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Artifact transaction and file cleanup failed',
          )
        }
      }
      throw error
    }
  }

  private createVersionRecord(
    input: {
      workId: string
      nodeRunId?: string | null
      assignmentId?: string | null
      artifactType: ArtifactType
      name: string
      description?: string
      content: string | Buffer
      mimeType?: string | null
      metadata?: Record<string, unknown>
      createdByType: 'user' | 'agent' | 'system'
      createdById?: string | null
    },
    ownedFiles: string[],
  ): { artifact: ArtifactRecord; version: ArtifactVersionRecord } {
    if (!(input.artifactType in { markdown: 1, text: 1, code: 1, image: 1, other: 1 })) {
      throw new ArtifactError('INVALID_TYPE', `unsupported artifact type: ${input.artifactType}`)
    }
    if (!NAME_PATTERN.test(input.name)) {
      throw new ArtifactError(
        'INVALID_NAME',
        `artifact name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}: ${input.name}`,
      )
    }
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8')
    if (content.length === 0) {
      throw new ArtifactError('CONTENT_REQUIRED', 'artifact content must not be empty')
    }
    const work = this.works.get(input.workId)
    if (!work) throw new ArtifactError('WORK_NOT_FOUND', `work ${input.workId} not found`)
    if (work.status !== 'active' && work.status !== 'paused') {
      throw new ArtifactError(
        'WORK_NOT_FOUND',
        `work ${input.workId} is ${work.status}; cannot receive artifacts`,
      )
    }

    const checksum = createHash('sha256').update(content).digest('hex')
    const now = this.now()

    {
      let artifact = this.artifacts.findByWorkAndName(
        input.workId,
        input.name,
        input.nodeRunId ?? undefined,
      )
      if (!artifact) {
        const artifactId = `art-${crypto.randomUUID()}`
        // 新 artifact：第一版内容即当前内容，storage_path 先占位再由版本路径覆盖。
        artifact = this.artifacts.createArtifact(
          {
            id: artifactId,
            workId: input.workId,
            nodeRunId: input.nodeRunId ?? null,
            assignmentId: input.assignmentId ?? null,
            artifactType: input.artifactType,
            name: input.name,
            description: input.description ?? '',
            storagePath: '',
            mimeType: input.mimeType ?? null,
            createdByType: input.createdByType,
            createdById: input.createdById ?? null,
          },
          now,
        )
      }

      const version = this.artifacts.nextVersion(artifact.id)
      const dir = this.versionDir(input.workId, artifact.id, version)
      const filePath = path.join(dir, crypto.randomUUID(), input.name)
      this.assertSafePath(filePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      this.assertSafePath(filePath)
      const fd = fs.openSync(filePath, 'wx', 0o600)
      ownedFiles.push(filePath)
      try {
        fs.writeFileSync(fd, content)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      const parent = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(parent)
      } finally {
        fs.closeSync(parent)
      }

      const created = this.artifacts.createVersion(
        {
          artifactId: artifact.id,
          version,
          storagePath: filePath,
          checksum,
          metadata: input.metadata ?? {},
        },
        now,
      )
      const recomputed = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
      if (recomputed !== checksum) {
        throw new ArtifactError(
          'CHECKSUM_MISMATCH',
          `artifact ${artifact.id} v${version} checksum mismatch after write`,
        )
      }
      return { artifact, version: created }
    }
  }

  preview(
    artifactId: string,
    version?: number,
  ): { artifact: ArtifactRecord; version: ArtifactVersionRecord; content: Buffer } {
    const artifact = this.artifacts.getArtifact(artifactId)
    if (!artifact) throw new ArtifactError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`)
    const record =
      version === undefined
        ? this.artifacts.latestVersion(artifactId)
        : this.artifacts.findByArtifactAndVersion(artifactId, version)
    if (!record) {
      throw new ArtifactError(
        'VERSION_NOT_FOUND',
        `artifact ${artifactId} version ${version ?? 'latest'} not found`,
      )
    }
    const content = this.readVersionFile(record)
    return { artifact, version: record, content }
  }

  openPath(
    artifactId: string,
    version?: number,
  ): {
    artifact: ArtifactRecord
    version: ArtifactVersionRecord
    absolutePath: string
    exists: boolean
  } {
    const artifact = this.artifacts.getArtifact(artifactId)
    if (!artifact) throw new ArtifactError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`)
    const record =
      version === undefined
        ? this.artifacts.latestVersion(artifactId)
        : this.artifacts.findByArtifactAndVersion(artifactId, version)
    if (!record) {
      throw new ArtifactError(
        'VERSION_NOT_FOUND',
        `artifact ${artifactId} version ${version ?? 'latest'} not found`,
      )
    }
    const absolutePath = path.resolve(record.storagePath)
    return { artifact, version: record, absolutePath, exists: fs.existsSync(absolutePath) }
  }

  listByWork(workId: string): ArtifactRecord[] {
    return this.artifacts.listByWork(workId)
  }

  listVersions(artifactId: string): ArtifactVersionRecord[] {
    if (!this.artifacts.getArtifact(artifactId)) {
      throw new ArtifactError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`)
    }
    return this.artifacts.listVersions(artifactId)
  }

  private readVersionFile(record: ArtifactVersionRecord): Buffer {
    const filePath = path.resolve(record.storagePath)
    const root = path.resolve(this.artifactsRoot)
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new ArtifactError('VERSION_NOT_FOUND', `artifact version path escapes artifacts root`)
    }
    if (!fs.existsSync(filePath)) {
      throw new ArtifactError('VERSION_NOT_FOUND', `artifact file missing: ${record.storagePath}`)
    }
    this.assertSafePath(filePath)
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let content: Buffer
    try {
      if (!fs.fstatSync(fd).isFile())
        throw new ArtifactError('VERSION_NOT_FOUND', 'Artifact is not a regular file')
      content = fs.readFileSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (createHash('sha256').update(content).digest('hex') !== record.checksum) {
      throw new ArtifactError(
        'CHECKSUM_MISMATCH',
        `artifact version ${record.id} checksum mismatch`,
      )
    }
    return content
  }

  private assertSafePath(file: string): void {
    const root = path.resolve(this.artifactsRoot)
    const relative = path.relative(root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new ArtifactError('INVALID_NAME', 'Artifact path escapes root')
    let current = root
    for (const part of ['.', ...relative.split(path.sep)]) {
      current = path.resolve(current, part)
      const stat = fs.lstatSync(current, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink())
        throw new ArtifactError('INVALID_NAME', 'Artifact path contains a symlink')
    }
  }

  private versionDir(workId: string, artifactId: string, version: number): string {
    const root = path.resolve(this.artifactsRoot)
    const dir = path.resolve(root, workId, artifactId, `v${version}`)
    if (!dir.startsWith(`${root}${path.sep}`)) {
      throw new ArtifactError('INVALID_NAME', `artifact path escapes artifacts root`)
    }
    return dir
  }
}
