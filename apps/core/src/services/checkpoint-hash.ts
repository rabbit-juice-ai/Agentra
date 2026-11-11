import { createHash } from 'node:crypto'

/**
 * 确定性 JSON：对象键排序、数组保持顺序。
 * Checkpoint content_hash 必须可跨进程/重放复算；不能依赖对象插入顺序。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      result[key] = canonicalize(item)
    }
    return result
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export type CheckpointHashInput = {
  schemaVersion: number
  workId: string
  seq: number
  baseDedupeKey: string
  dedupeKey: string
  attemptNo: number
  state: string
  kind: string
  stage: string
  executionId: string | null
  sessionId: string | null
  nodeRunId: string | null
  teamRunId: string | null
  parentCheckpointId: string | null
  acceptanceCriteriaWorkVersion: number
  taskMemoryVersion: number | null
  riskLevel: string
  evidenceStatus: string
  sideEffectCompleteness: string
  checkpointJson: string
  evidenceJson: string
  verificationJson: string
  errorJson: string | null
  createdAt: string
}

/** 覆盖除 id / content_hash 外的全部不可变业务字段。 */
export function hashCheckpointContent(input: CheckpointHashInput): string {
  return sha256Hex(canonicalJson(input))
}
