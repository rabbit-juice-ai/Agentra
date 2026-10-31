/**
 * 阶段 4 运行态共享类型。
 * NodeFailure 刻意是结构化对象（不是字符串）：S4-4 的 Assignment 解析失败等
 * 需要一个可被 UI/审计消费的失败类别，而不是只能写一句 message。
 */
export const NODE_FAILURE_CATEGORIES = [
  'assignment_unresolved',
  'assignment_ambiguous',
  'assignment_inactive',
  'provider_unavailable',
  'output_contract_violation',
  'condition_evaluation',
  'join_failed',
  'internal',
] as const
export type NodeFailureCategory = (typeof NODE_FAILURE_CATEGORIES)[number]

export type NodeFailure = {
  category: NodeFailureCategory
  nodeKey: string
  message: string
  details?: Record<string, unknown>
}

export function isNodeFailure(value: unknown): value is NodeFailure {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.category === 'string' &&
    (NODE_FAILURE_CATEGORIES as readonly string[]).includes(record.category) &&
    typeof record.nodeKey === 'string' &&
    record.nodeKey.length > 0 &&
    typeof record.message === 'string' &&
    record.message.length > 0
  )
}
