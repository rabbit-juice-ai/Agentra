import type { z } from 'zod'
import {
  type ConditionExpr,
  type ConditionLiteral,
  type ConditionOperand,
  findUnknownNodeTypes,
  NODE_TYPES,
  type NodeType,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowEdge,
  type WorkflowNode,
} from './schema'
import type { Violation } from './violations'

export type ValidationOutcome =
  | { ok: true; definition: WorkflowDefinition; violations: [] }
  | { ok: false; kind: 'error'; code: 'UNKNOWN_NODE_TYPE'; message: string; nodeKey?: string }
  | { ok: false; kind: 'violations'; violations: Violation[] }

const TEST_RESULT_FIELDS = [
  'pass',
  'failureReason',
  'relatedTasks',
  'impactScope',
  'relatedArtifacts',
] as const

const STATUS_PATH = /^nodes\.([a-z0-9_-]{1,64})\.status$/
const ATTEMPT_PATH = /^nodes\.([a-z0-9_-]{1,64})\.attempt$/
const OUTPUT_PATH = /^nodes\.([a-z0-9_-]{1,64})\.output\.([A-Za-z0-9_-]{1,64})$/

const MAX_EXPR_DEPTH = 10
const MAX_EXPR_NODES = 50

type Graph = {
  nodes: Map<string, WorkflowNode>
  out: Map<string, WorkflowEdge[]>
  inn: Map<string, WorkflowEdge[]>
}

/**
 * 校验入口：未知节点类型走错误码（不是 violation），其余问题一律进 violations 数组。
 * 结构解析失败时只报解析问题（图规则无法在不可信结构上运行）；解析通过后跑 12 条图规则。
 */
export function validateWorkflowDefinition(input: unknown): ValidationOutcome {
  for (const first of findUnknownNodeTypes(input)) {
    const suffix = first.nodeKey ? ` at node "${first.nodeKey}"` : ''
    return {
      ok: false,
      kind: 'error',
      code: 'UNKNOWN_NODE_TYPE',
      nodeKey: first.nodeKey,
      message: `unknown node type ${JSON.stringify(first.type)}${suffix}; allowed: ${NODE_TYPES.join(', ')}`,
    }
  }

  const parsed = WorkflowDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, kind: 'violations', violations: mapZodIssues(parsed.error, input) }
  }

  const violations = validateGraph(parsed.data)
  if (violations.length > 0) return { ok: false, kind: 'violations', violations }
  return { ok: true, definition: parsed.data, violations: [] }
}

function readItemKey(input: unknown, field: 'nodes' | 'edges', index: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[field]
  if (!Array.isArray(value)) return undefined
  const item: unknown = typeof index === 'number' ? value[index] : undefined
  if (typeof item !== 'object' || item === null) return undefined
  const key = (item as { key?: unknown }).key
  return typeof key === 'string' ? key : undefined
}

function mapZodIssues(error: z.ZodError, input: unknown): Violation[] {
  const violations: Violation[] = []
  for (const issue of error.issues) {
    const [head, index] = issue.path
    const message = issue.message

    if (head === 'nodes') {
      violations.push({
        violation: 'node_config_invalid',
        nodeKey: readItemKey(input, 'nodes', index),
        message,
      })
      continue
    }
    if (head === 'edges') {
      violations.push({
        violation: 'edge_invalid',
        edgeKey: readItemKey(input, 'edges', index),
        message,
      })
      continue
    }
    violations.push({ violation: 'settings_invalid', message })
  }
  return violations
}

function validateGraph(def: WorkflowDefinition): Violation[] {
  const violations: Violation[] = []
  const graph = buildGraph(def, violations)
  const { nodes, out, inn } = graph

  checkStartAndEnd(nodes, out, inn, violations)
  checkReachability(nodes, out, violations)
  checkAcyclic(nodes, out, inn, violations)
  checkDegrees(nodes, out, inn, violations)
  checkConditions(nodes, out, violations)
  checkBranches(nodes, out, inn, violations)
  checkAgentTasks(nodes, out, violations)
  checkApprovals(nodes, out, violations)
  checkExpressions(nodes, out, violations)

  return violations
}

function buildGraph(def: WorkflowDefinition, violations: Violation[]): Graph {
  const nodes = new Map<string, WorkflowNode>()
  for (const node of def.nodes) {
    if (nodes.has(node.key)) {
      violations.push({
        violation: 'key_duplicate',
        nodeKey: node.key,
        message: `duplicate node key "${node.key}"`,
      })
      continue
    }
    nodes.set(node.key, node)
  }

  const out = new Map<string, WorkflowEdge[]>()
  const inn = new Map<string, WorkflowEdge[]>()
  for (const key of nodes.keys()) {
    out.set(key, [])
    inn.set(key, [])
  }

  const edgeKeys = new Set<string>()
  const signatures = new Set<string>()

  for (const edge of def.edges) {
    if (edgeKeys.has(edge.key)) {
      violations.push({
        violation: 'key_duplicate',
        edgeKey: edge.key,
        message: `duplicate edge key "${edge.key}"`,
      })
    } else {
      edgeKeys.add(edge.key)
    }

    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)

    if (!source) {
      violations.push({
        violation: 'edge_invalid',
        edgeKey: edge.key,
        message: `edge source "${edge.source}" does not exist`,
      })
    }
    if (!target) {
      violations.push({
        violation: 'edge_invalid',
        edgeKey: edge.key,
        message: `edge target "${edge.target}" does not exist`,
      })
    }
    if (edge.source === edge.target) {
      violations.push({
        violation: 'edge_invalid',
        edgeKey: edge.key,
        message: 'self-loop edges are not allowed',
      })
    }

    const signature = `${edge.source}\u0000${edge.target}\u0000${String(edge.when)}`
    if (signatures.has(signature)) {
      violations.push({
        violation: 'edge_invalid',
        edgeKey: edge.key,
        message: 'duplicate edge (source + target + when)',
      })
    } else {
      signatures.add(signature)
    }

    if (edge.branchKey !== undefined && source && source.type !== 'parallel_split') {
      violations.push({
        violation: 'branch_invalid',
        edgeKey: edge.key,
        message: 'branchKey is only allowed on parallel_split out-edges',
      })
    }
    if (edge.when !== undefined && source && source.type !== 'condition') {
      violations.push({
        violation: 'condition_invalid',
        edgeKey: edge.key,
        message: 'when is only allowed on condition out-edges',
      })
    }

    if (source && target) {
      out.get(edge.source)?.push(edge)
      inn.get(edge.target)?.push(edge)
    }
  }

  return { nodes, out, inn }
}

function checkStartAndEnd(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  inn: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  const starts = [...nodes.values()].filter((node) => node.type === 'start')
  if (starts.length !== 1) {
    violations.push({
      violation: 'start_invalid',
      message: `expected exactly one start node, found ${starts.length}`,
    })
  }
  for (const start of starts) {
    if ((inn.get(start.key)?.length ?? 0) > 0) {
      violations.push({
        violation: 'start_invalid',
        nodeKey: start.key,
        message: 'start node must have no incoming edges',
      })
    }
    if ((out.get(start.key)?.length ?? 0) === 0) {
      violations.push({
        violation: 'start_invalid',
        nodeKey: start.key,
        message: 'start node must have at least one outgoing edge',
      })
    }
  }

  const ends = [...nodes.values()].filter((node) => node.type === 'end')
  if (ends.length === 0) {
    violations.push({ violation: 'end_invalid', message: 'at least one end node is required' })
  }
  for (const end of ends) {
    if ((out.get(end.key)?.length ?? 0) > 0) {
      violations.push({
        violation: 'end_invalid',
        nodeKey: end.key,
        message: 'end node must have no outgoing edges',
      })
    }
    if ((inn.get(end.key)?.length ?? 0) === 0) {
      violations.push({
        violation: 'end_invalid',
        nodeKey: end.key,
        message: 'end node must have at least one incoming edge',
      })
    }
  }
}

function checkReachability(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  const starts = [...nodes.values()].filter((node) => node.type === 'start')
  if (starts.length !== 1) return

  const start = starts[0]
  if (!start) return

  const visited = new Set<string>()
  const queue: string[] = [start.key]
  visited.add(start.key)
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) break
    for (const edge of out.get(key) ?? []) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target)
        queue.push(edge.target)
      }
    }
  }

  for (const node of nodes.values()) {
    if (!visited.has(node.key)) {
      violations.push({
        violation: 'unreachable_node',
        nodeKey: node.key,
        message: 'node is not reachable from start',
      })
    }
  }
}

function checkAcyclic(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  inn: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  const indegree = new Map<string, number>()
  for (const key of nodes.keys()) indegree.set(key, inn.get(key)?.length ?? 0)

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key)
  let removed = 0
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) break
    removed += 1
    for (const edge of out.get(key) ?? []) {
      const next = (indegree.get(edge.target) ?? 0) - 1
      indegree.set(edge.target, next)
      if (next === 0) queue.push(edge.target)
    }
  }

  if (removed < nodes.size) {
    const remaining = [...nodes.keys()].filter((key) => (indegree.get(key) ?? 0) > 0)
    violations.push({
      violation: 'cycle',
      nodeKey: remaining[0],
      message: `graph contains a directed cycle (${remaining.join(', ')})`,
    })
  }
}

function checkDegrees(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  inn: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  for (const node of nodes.values()) {
    if (node.type !== 'end' && (out.get(node.key)?.length ?? 0) === 0) {
      violations.push({
        violation: 'degree_invalid',
        nodeKey: node.key,
        message: 'non-end node must have at least one outgoing edge',
      })
    }
    if (node.type !== 'start' && (inn.get(node.key)?.length ?? 0) === 0) {
      violations.push({
        violation: 'degree_invalid',
        nodeKey: node.key,
        message: 'non-start node must have at least one incoming edge',
      })
    }
  }
}

function checkConditions(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  for (const node of nodes.values()) {
    if (node.type !== 'condition') continue
    const outs = out.get(node.key) ?? []
    const trueEdges = outs.filter((edge) => edge.when === true)
    const falseEdges = outs.filter((edge) => edge.when === false)
    const plainEdges = outs.filter((edge) => edge.when === undefined)

    if (trueEdges.length !== 1) {
      violations.push({
        violation: 'condition_invalid',
        nodeKey: node.key,
        message: `condition must have exactly one when=true out-edge (found ${trueEdges.length})`,
      })
    }
    if (node.config.falseBranch === 'edge') {
      if (falseEdges.length !== 1) {
        violations.push({
          violation: 'condition_invalid',
          nodeKey: node.key,
          message: `falseBranch="edge" requires exactly one when=false out-edge (found ${falseEdges.length})`,
        })
      }
    } else if (falseEdges.length !== 0) {
      violations.push({
        violation: 'condition_invalid',
        nodeKey: node.key,
        message: 'falseBranch="rework" must not have a when=false out-edge',
      })
    }
    if (plainEdges.length > 0) {
      violations.push({
        violation: 'condition_invalid',
        nodeKey: node.key,
        message: 'every condition out-edge must declare when',
      })
    }
  }
}

function canReach(out: Map<string, WorkflowEdge[]>, from: string, to: string): boolean {
  if (from === to) return true
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) break
    for (const edge of out.get(key) ?? []) {
      if (edge.target === to) return true
      if (!seen.has(edge.target)) {
        seen.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return false
}

/** split 与 join 之间的区域（不含两端），用于检测嵌套并行。 */
function regionBetween(
  out: Map<string, WorkflowEdge[]>,
  splitKey: string,
  joinKey: string,
): Set<string> {
  const region = new Set<string>()
  const queue = (out.get(splitKey) ?? []).map((edge) => edge.target)
  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) break
    if (key === joinKey || region.has(key)) continue
    region.add(key)
    for (const edge of out.get(key) ?? []) {
      if (!region.has(edge.target)) queue.push(edge.target)
    }
  }
  return region
}

function checkBranches(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  inn: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  const joins = [...nodes.values()].filter((node) => node.type === 'join')

  for (const split of nodes.values()) {
    if (split.type !== 'parallel_split') continue
    const outs = out.get(split.key) ?? []

    if (outs.length < 2) {
      violations.push({
        violation: 'branch_invalid',
        nodeKey: split.key,
        message: 'parallel_split must have at least two out-edges',
      })
    }

    const seen = new Set<string>()
    for (const edge of outs) {
      if (edge.branchKey === undefined) {
        violations.push({
          violation: 'branch_invalid',
          edgeKey: edge.key,
          message: 'parallel_split out-edge must declare branchKey',
        })
        continue
      }
      if (seen.has(edge.branchKey)) {
        violations.push({
          violation: 'branch_invalid',
          edgeKey: edge.key,
          message: `duplicate branchKey "${edge.branchKey}" within parallel_split "${split.key}"`,
        })
      }
      seen.add(edge.branchKey)
    }

    const paired = joins.filter((join) => join.config.pairWith === split.key)
    if (paired.length !== 1) {
      violations.push({
        violation: 'branch_invalid',
        nodeKey: split.key,
        message: `parallel_split must be paired with exactly one join (found ${paired.length})`,
      })
      continue
    }

    const join = paired[0]
    if (!join) continue
    for (const edge of outs) {
      if (!canReach(out, edge.target, join.key)) {
        violations.push({
          violation: 'branch_invalid',
          edgeKey: edge.key,
          message: `branch "${edge.branchKey ?? edge.key}" cannot reach join "${join.key}"`,
        })
      }
    }

    for (const key of regionBetween(out, split.key, join.key)) {
      if (nodes.get(key)?.type === 'parallel_split') {
        violations.push({
          violation: 'branch_invalid',
          nodeKey: key,
          message: 'nested parallel_split is not supported in schemaVersion 1',
        })
      }
    }
  }

  for (const join of joins) {
    if ((inn.get(join.key)?.length ?? 0) < 2) {
      violations.push({
        violation: 'branch_invalid',
        nodeKey: join.key,
        message: 'join must have at least two in-edges',
      })
    }
    const split = nodes.get(join.config.pairWith)
    if (split?.type !== 'parallel_split') {
      violations.push({
        violation: 'branch_invalid',
        nodeKey: join.key,
        message: `pairWith "${join.config.pairWith}" must reference a parallel_split node`,
      })
    }
  }
}

function checkAgentTasks(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  for (const node of nodes.values()) {
    if (node.type !== 'agent_task') continue
    for (const ref of node.config.inputArtifactRefs) {
      const ancestor = nodes.get(ref.nodeKey)
      if (!ancestor) {
        violations.push({
          violation: 'agent_task_invalid',
          nodeKey: node.key,
          message: `inputArtifactRefs references unknown node "${ref.nodeKey}"`,
        })
        continue
      }
      if (!canReach(out, ref.nodeKey, node.key)) {
        violations.push({
          violation: 'agent_task_invalid',
          nodeKey: node.key,
          message: `inputArtifactRefs "${ref.nodeKey}" must be an ancestor of "${node.key}"`,
        })
        continue
      }
      if (ancestor.type !== 'agent_task') {
        violations.push({
          violation: 'agent_task_invalid',
          nodeKey: node.key,
          message: `inputArtifactRefs "${ref.nodeKey}" is not an agent_task and declares no artifacts`,
        })
        continue
      }
      const declared = ancestor.config.artifacts
      if (ref.artifactName !== undefined) {
        if (!declared.some((artifact) => artifact.name === ref.artifactName)) {
          violations.push({
            violation: 'agent_task_invalid',
            nodeKey: node.key,
            message: `artifact "${ref.artifactName}" is not declared by "${ref.nodeKey}"`,
          })
        }
      } else if (declared.length !== 1) {
        violations.push({
          violation: 'agent_task_invalid',
          nodeKey: node.key,
          message: `"${ref.nodeKey}" declares ${declared.length} artifacts; artifactName is required unless exactly one is declared`,
        })
      }
    }
  }
}

function checkApprovals(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  for (const node of nodes.values()) {
    if (node.type !== 'human_approval') continue

    const targetKey = node.config.target.nodeKey
    const target = nodes.get(targetKey)
    if (target?.type !== 'agent_task') {
      violations.push({
        violation: 'approval_invalid',
        nodeKey: node.key,
        message: `target "${targetKey}" must be an agent_task`,
      })
    } else if (node.config.target.phase === 'before_execute') {
      if (!canReach(out, node.key, targetKey)) {
        violations.push({
          violation: 'approval_invalid',
          nodeKey: node.key,
          message: 'before_execute approval must be upstream of its target',
        })
      }
    } else if (!canReach(out, targetKey, node.key)) {
      violations.push({
        violation: 'approval_invalid',
        nodeKey: node.key,
        message: 'after_execute approval must be downstream of its target',
      })
    }

    const reworkKey = node.config.reworkTargetNodeKey ?? targetKey
    const reworkTarget = nodes.get(reworkKey)
    if (reworkTarget?.type !== 'agent_task') {
      violations.push({
        violation: 'approval_invalid',
        nodeKey: node.key,
        message: `reworkTargetNodeKey "${reworkKey}" must be an agent_task`,
      })
    } else if (reworkKey !== targetKey && !canReach(out, reworkKey, node.key)) {
      violations.push({
        violation: 'approval_invalid',
        nodeKey: node.key,
        message: 'reworkTargetNodeKey must be the target or an upstream agent_task',
      })
    }
  }
}

function checkExpressions(
  nodes: Map<string, WorkflowNode>,
  out: Map<string, WorkflowEdge[]>,
  violations: Violation[],
): void {
  for (const node of nodes.values()) {
    if (node.type !== 'condition') continue

    const stats = expressionStats(node.config.predicate)
    if (stats.depth > MAX_EXPR_DEPTH) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey: node.key,
        message: `predicate depth ${stats.depth} exceeds ${MAX_EXPR_DEPTH}`,
      })
    }
    if (stats.count > MAX_EXPR_NODES) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey: node.key,
        message: `predicate node count ${stats.count} exceeds ${MAX_EXPR_NODES}`,
      })
    }
    walkExpression(node.key, node.config.predicate, nodes, violations)

    const falseBranch = node.config.falseBranch
    if (typeof falseBranch === 'object' && falseBranch.kind === 'rework') {
      const report = nodes.get(falseBranch.reportNodeKey)
      if (report?.type !== 'agent_task') {
        violations.push({
          violation: 'condition_invalid',
          nodeKey: node.key,
          message: `falseBranch.reportNodeKey "${falseBranch.reportNodeKey}" must be an agent_task`,
        })
      } else {
        if (report.config.outputContract.profile !== 'test_result') {
          violations.push({
            violation: 'condition_invalid',
            nodeKey: node.key,
            message: `falseBranch.reportNodeKey "${falseBranch.reportNodeKey}" must declare outputContract.profile="test_result"`,
          })
        }
        if (!canReach(out, falseBranch.reportNodeKey, node.key)) {
          violations.push({
            violation: 'condition_invalid',
            nodeKey: node.key,
            message: 'falseBranch.reportNodeKey must be upstream of the condition node',
          })
        }
      }
    }
  }
}

function expressionStats(expr: ConditionExpr): { depth: number; count: number } {
  switch (expr.kind) {
    case 'comparison':
      return { depth: 1, count: 1 }
    case 'not': {
      const inner = expressionStats(expr.operand)
      return { depth: inner.depth + 1, count: inner.count + 1 }
    }
    case 'logical': {
      let depth = 0
      let count = 1
      for (const operand of expr.operands) {
        const inner = expressionStats(operand)
        depth = Math.max(depth, inner.depth)
        count += inner.count
      }
      return { depth: depth + 1, count }
    }
  }
}

function walkExpression(
  nodeKey: string,
  expr: ConditionExpr,
  nodes: Map<string, WorkflowNode>,
  violations: Violation[],
): void {
  switch (expr.kind) {
    case 'comparison': {
      checkFieldPath(nodeKey, expr.left, nodes, violations)
      if (expr.right.kind !== 'literal') {
        violations.push({
          violation: 'expression_invalid',
          nodeKey,
          message: 'comparison right-hand side must be a literal',
        })
        return
      }
      const value = expr.right.value
      if (expr.op === 'in') {
        if (!Array.isArray(value)) {
          violations.push({
            violation: 'expression_invalid',
            nodeKey,
            message: 'operator "in" requires a literal array on the right',
          })
          return
        }
        const types = new Set(value.map((item) => (item === null ? 'null' : typeof item)))
        if (types.has('null')) {
          violations.push({
            violation: 'expression_invalid',
            nodeKey,
            message: 'null is not allowed in an "in" array',
          })
        }
        if (types.size > 1) {
          violations.push({
            violation: 'expression_invalid',
            nodeKey,
            message: '"in" array elements must share one type',
          })
        }
      } else if (expr.op !== '==' && expr.op !== '!=') {
        if (typeof value !== 'number') {
          violations.push({
            violation: 'expression_invalid',
            nodeKey,
            message: `operator "${expr.op}" requires a numeric literal`,
          })
        }
      }
      return
    }
    case 'not':
      walkExpression(nodeKey, expr.operand, nodes, violations)
      return
    case 'logical':
      for (const operand of expr.operands) walkExpression(nodeKey, operand, nodes, violations)
  }
}

function checkFieldPath(
  nodeKey: string,
  operand: ConditionOperand,
  nodes: Map<string, WorkflowNode>,
  violations: Violation[],
): void {
  if (operand.kind !== 'field' || typeof operand.path !== 'string') return
  const path = operand.path

  const status = STATUS_PATH.exec(path)
  if (status) {
    const refKey = status[1]
    if (refKey !== undefined && !nodes.has(refKey)) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey,
        message: `field path "${path}" references unknown node "${refKey}"`,
      })
    }
    return
  }

  const attempt = ATTEMPT_PATH.exec(path)
  if (attempt) {
    const refKey = attempt[1]
    if (refKey !== undefined && !nodes.has(refKey)) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey,
        message: `field path "${path}" references unknown node "${refKey}"`,
      })
    }
    return
  }

  const output = OUTPUT_PATH.exec(path)
  if (output) {
    const refKey = output[1]
    const fieldName = output[2]
    if (refKey === undefined || fieldName === undefined) return
    const ref = nodes.get(refKey)
    if (!ref) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey,
        message: `field path "${path}" references unknown node "${refKey}"`,
      })
      return
    }
    if (ref.type !== 'agent_task') {
      violations.push({
        violation: 'expression_invalid',
        nodeKey,
        message: `field path "${path}" requires an agent_task source`,
      })
      return
    }
    const contract = ref.config.outputContract
    const allowed: readonly string[] =
      contract.profile === 'test_result'
        ? TEST_RESULT_FIELDS
        : contract.fields.map((field) => field.name)
    if (!allowed.includes(fieldName)) {
      violations.push({
        violation: 'expression_invalid',
        nodeKey,
        message: `field "${fieldName}" is not declared in outputContract of "${refKey}"`,
      })
    }
    return
  }

  violations.push({
    violation: 'expression_invalid',
    nodeKey,
    message: `field path "${path}" is not in the whitelist (nodes.<key>.status|attempt|output.<field>)`,
  })
}

export type { ConditionLiteral, NodeType }
