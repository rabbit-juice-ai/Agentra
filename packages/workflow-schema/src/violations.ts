/**
 * 发布期 violation 闭集（WORKFLOW §2「定义校验与 violations」）。
 * 16 项冻结：实现不得新增；新增需先改文档并走版本治理。
 */
export const VIOLATION_CODES = [
  'start_invalid',
  'end_invalid',
  'unreachable_node',
  'cycle',
  'edge_invalid',
  'key_duplicate',
  'degree_invalid',
  'node_config_invalid',
  'agent_task_invalid',
  'approval_invalid',
  'expression_invalid',
  'condition_invalid',
  'branch_invalid',
  'settings_invalid',
  'version_conflict',
  'cas_failed',
] as const

export type ViolationCode = (typeof VIOLATION_CODES)[number]

export type Violation = {
  violation: ViolationCode
  nodeKey?: string
  edgeKey?: string
  message: string
}

/** UNKNOWN_NODE_TYPE 是错误码而不是 violation：校验器只经 `ValidationOutcome.error` 返回它。 */
export type ValidationErrorCode = 'UNKNOWN_NODE_TYPE'

export function isViolationCode(value: unknown): value is ViolationCode {
  return typeof value === 'string' && (VIOLATION_CODES as readonly string[]).includes(value)
}
