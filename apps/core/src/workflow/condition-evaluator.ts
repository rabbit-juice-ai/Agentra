import type { ConditionExpr, ConditionOperand } from '@agentra/workflow-schema'
import type { NodeRunStatus } from './state-machine'

export type ConditionNodeState = {
  status: NodeRunStatus
  attempt: number
  output: Record<string, unknown> | null
}

export type ConditionContext = Map<string, ConditionNodeState>

export type ConditionEvaluation = { ok: true; value: boolean } | { ok: false; reason: string }

const STATUS_PATH = /^nodes\.([a-z0-9_-]{1,64})\.status$/
const ATTEMPT_PATH = /^nodes\.([a-z0-9_-]{1,64})\.attempt$/
const OUTPUT_PATH = /^nodes\.([a-z0-9_-]{1,64})\.output\.([A-Za-z0-9_-]{1,64})$/

type OperandValue = { value: unknown }

function resolveOperand(
  operand: ConditionOperand,
  context: ConditionContext,
): ConditionEvaluation | OperandValue {
  if (operand.kind === 'literal') return { value: operand.value }
  const path = operand.path

  const status = STATUS_PATH.exec(path)
  if (status) {
    const node = context.get(status[1] as string)
    if (!node) return { ok: false, reason: `field path "${path}" references unknown node` }
    return { value: node.status }
  }
  const attempt = ATTEMPT_PATH.exec(path)
  if (attempt) {
    const node = context.get(attempt[1] as string)
    if (!node) return { ok: false, reason: `field path "${path}" references unknown node` }
    return { value: node.attempt }
  }
  const output = OUTPUT_PATH.exec(path)
  if (output) {
    const node = context.get(output[1] as string)
    if (!node) return { ok: false, reason: `field path "${path}" references unknown node` }
    if (node.output === null || !((output[2] as string) in node.output)) {
      return { ok: false, reason: `field "${path}" is missing from node output` }
    }
    return { value: node.output[output[2] as string] }
  }
  return { ok: false, reason: `field path "${path}" is not in the whitelist` }
}

function isEvaluation(value: ConditionEvaluation | OperandValue): value is ConditionEvaluation {
  return 'ok' in value
}

function compare(op: string, left: unknown, right: unknown): ConditionEvaluation {
  if (op === '==' || op === '!=') {
    if (left === null || right === null) {
      const equal = left === null && right === null
      return { ok: true, value: op === '==' ? equal : !equal }
    }
    if (typeof left !== typeof right) {
      return { ok: false, reason: `type mismatch: ${typeof left} vs ${typeof right}` }
    }
    // 输出里的对象/数组不能用引用相等比较，否则会静默得到 false——按类型不符处理。
    if (typeof left === 'object' || typeof right === 'object') {
      return { ok: false, reason: '== / != only supports primitive values' }
    }
    const equal = left === right
    return { ok: true, value: op === '==' ? equal : !equal }
  }
  if (op === 'in') {
    if (!Array.isArray(right))
      return { ok: false, reason: 'operator "in" requires a literal array' }
    if (left === null) return { ok: false, reason: 'null is not allowed with "in"' }
    for (const item of right) {
      if (typeof item !== typeof left) {
        return { ok: false, reason: `type mismatch in "in": ${typeof item} vs ${typeof left}` }
      }
    }
    return { ok: true, value: right.includes(left) }
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    return { ok: false, reason: `operator "${op}" requires numbers` }
  }
  switch (op) {
    case '>':
      return { ok: true, value: left > right }
    case '>=':
      return { ok: true, value: left >= right }
    case '<':
      return { ok: true, value: left < right }
    case '<=':
      return { ok: true, value: left <= right }
    default:
      return { ok: false, reason: `unsupported operator "${op}"` }
  }
}

/** 结构化条件求值：任何字段缺失/类型不符都返回 ok:false（调用方必须让节点 failed）。 */
export function evaluateCondition(
  expr: ConditionExpr,
  context: ConditionContext,
): ConditionEvaluation {
  switch (expr.kind) {
    case 'comparison': {
      const left = resolveOperand(expr.left, context)
      if (isEvaluation(left)) return left
      const right = resolveOperand(expr.right, context)
      if (isEvaluation(right)) return right
      return compare(expr.op, left.value, right.value)
    }
    case 'not': {
      const inner = evaluateCondition(expr.operand, context)
      if (!inner.ok) return inner
      return { ok: true, value: !inner.value }
    }
    case 'logical': {
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const result = evaluateCondition(operand, context)
          if (!result.ok) return result
          if (!result.value) return { ok: true, value: false }
        }
        return { ok: true, value: true }
      }
      for (const operand of expr.operands) {
        const result = evaluateCondition(operand, context)
        if (!result.ok) return result
        if (result.value) return { ok: true, value: true }
      }
      return { ok: true, value: false }
    }
  }
}
