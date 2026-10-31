import {
  computeChecksum,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@agentra/workflow-schema'
import type {
  WorkflowRepository,
  WorkflowVersionStatus,
} from '../db/repositories/workflow-repository'

export type DefinitionLoadErrorCode =
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_READABLE'
  | 'DEFINITION_INVALID'
  | 'CHECKSUM_MISMATCH'

export class WorkflowDefinitionLoadError extends Error {
  constructor(
    readonly code: DefinitionLoadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowDefinitionLoadError'
  }
}

export type LoadedWorkflowDefinition = {
  versionId: string
  version: number
  status: Extract<WorkflowVersionStatus, 'published' | 'deprecated'>
  schemaVersion: number
  checksum: string
  definition: WorkflowDefinition
}

/**
 * 运行期唯一的定义入口：只消费阶段 3 的已发布版本，**不复制定义层**。
 *
 * - 只接受 `published` / `deprecated`：`deprecated` 仍可读（DATABASE §2.5 的
 *   不可变触发器保证它既不能被改也不能被删），因此历史 Run 永远能重新加载定义；
 * - 加载时用同一份 Schema 重新 parse 并重算 checksum 与库中值比对：
 *   定义在发布时已经校验过，这里防的是存储损坏，不是重新做发布校验；
 * - 定义不可变 ⇒ 进程内按 versionId 缓存是安全的；重启后重新读库即可。
 */
export class PublishedDefinitionProvider {
  private readonly cache = new Map<string, LoadedWorkflowDefinition>()

  constructor(private readonly versions: WorkflowRepository) {}

  get(versionId: string): LoadedWorkflowDefinition {
    const cached = this.cache.get(versionId)
    if (cached) return cached

    const record = this.versions.getVersion(versionId)
    if (!record) {
      throw new WorkflowDefinitionLoadError(
        'VERSION_NOT_FOUND',
        `workflow version ${versionId} not found`,
      )
    }
    if (record.status !== 'published' && record.status !== 'deprecated') {
      throw new WorkflowDefinitionLoadError(
        'VERSION_NOT_READABLE',
        `workflow version ${versionId} is ${record.status}; only published/deprecated versions can run`,
      )
    }

    let definition: WorkflowDefinition
    try {
      definition = WorkflowDefinitionSchema.parse(record.definition)
    } catch (error) {
      throw new WorkflowDefinitionLoadError(
        'DEFINITION_INVALID',
        `workflow version ${versionId} definition is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    const checksum = computeChecksum(definition)
    if (checksum !== record.checksum) {
      throw new WorkflowDefinitionLoadError(
        'CHECKSUM_MISMATCH',
        `workflow version ${versionId} checksum mismatch: stored ${record.checksum}, recomputed ${checksum}`,
      )
    }

    const loaded: LoadedWorkflowDefinition = {
      versionId,
      version: record.version,
      status: record.status,
      schemaVersion: definition.schemaVersion,
      checksum,
      definition,
    }
    this.cache.set(versionId, loaded)
    return loaded
  }

  /** 仅测试用：清空进程内缓存。 */
  clear(): void {
    this.cache.clear()
  }
}
