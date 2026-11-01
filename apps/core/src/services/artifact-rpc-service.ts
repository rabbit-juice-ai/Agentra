import {
  type ArtifactListResult,
  type ArtifactPreviewResult,
  RpcMethodError,
} from '@agentra/protocol'
import { ArtifactError, type ArtifactService } from './artifact-service'

function mapArtifactError(error: unknown): Error {
  if (error instanceof ArtifactError) {
    throw new RpcMethodError('INVALID_PARAMS', error.message, { code: error.code })
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * S5-3：Artifact 只读服务面（预览/列表）。
 * 每个方法对应一条显式 RPC；不做通用透传，不暴露创建/删除。
 */
export class ArtifactRpcService {
  constructor(private readonly artifacts: ArtifactService) {}

  preview(params: { artifactId: string; version?: number }): ArtifactPreviewResult {
    try {
      const { artifact, version, content } = this.artifacts.preview(
        params.artifactId,
        params.version,
      )
      return {
        artifact: {
          id: artifact.id,
          workId: artifact.workId,
          nodeRunId: artifact.nodeRunId,
          artifactType: artifact.artifactType,
          name: artifact.name,
          description: artifact.description,
          mimeType: artifact.mimeType,
          createdAt: artifact.createdAt,
        },
        version: {
          id: version.id,
          artifactId: version.artifactId,
          version: version.version,
          storagePath: version.storagePath,
          checksum: version.checksum,
          createdAt: version.createdAt,
        },
        contentBase64: content.toString('base64'),
      }
    } catch (error) {
      throw mapArtifactError(error)
    }
  }

  listByWork(workId: string): ArtifactListResult {
    try {
      return {
        artifacts: this.artifacts.listByWork(workId).map((artifact) => ({
          id: artifact.id,
          workId: artifact.workId,
          nodeRunId: artifact.nodeRunId,
          artifactType: artifact.artifactType,
          name: artifact.name,
          description: artifact.description,
          mimeType: artifact.mimeType,
          createdAt: artifact.createdAt,
          versions: this.artifacts.listVersions(artifact.id).map((version) => ({
            id: version.id,
            artifactId: version.artifactId,
            version: version.version,
            storagePath: version.storagePath,
            checksum: version.checksum,
            createdAt: version.createdAt,
          })),
        })),
      }
    } catch (error) {
      throw mapArtifactError(error)
    }
  }
}
