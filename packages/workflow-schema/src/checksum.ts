import { createHash } from 'node:crypto'
import type { WorkflowDefinition } from './schema'

/**
 * 规范化序列化（checksum 唯一输入形式）：
 * - 对象键按 Unicode 码点升序递归排序；数组默认保持顺序（nodes / edges 由调用方按 key 排序）
 * - 字符串做 NFC 归一化（视觉相同的组合字符必须得到同一 checksum）
 * - 数字用 JSON.stringify 的默认形式（1、1.0、1e0 都是 "1"）；非有限数直接拒绝
 * - 紧凑输出（无空白），UTF-8
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'

  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite numbers are not allowed')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'undefined') {
    throw new Error('canonicalize: undefined is not allowed')
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    const entries = keys.map(
      (key) => `${JSON.stringify(key.normalize('NFC'))}:${canonicalize(record[key])}`,
    )
    return `{${entries.join(',')}}`
  }

  throw new Error(`canonicalize: unsupported value type ${typeof value}`)
}

function byKey<T extends { key: string }>(left: T, right: T): number {
  if (left.key < right.key) return -1
  if (left.key > right.key) return 1
  return 0
}

/** checksum 输入固定为 {schemaVersion, nodes, edges, settings}，不含 id / template_id / version / status / 时间字段。 */
export function canonicalDefinition(definition: WorkflowDefinition): string {
  return canonicalize({
    schemaVersion: definition.schemaVersion,
    nodes: [...definition.nodes].sort(byKey),
    edges: [...definition.edges].sort(byKey),
    settings: definition.settings,
  })
}

/** SHA-256，小写十六进制。发布与读取校验共用同一实现。 */
export function computeChecksum(definition: WorkflowDefinition): string {
  return createHash('sha256').update(canonicalDefinition(definition), 'utf8').digest('hex')
}
