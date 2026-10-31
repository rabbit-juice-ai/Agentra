import {
  NODE_TYPES,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agentra/workflow-schema'
import type { NodeFailure } from './types'

export type NodeHandlerContext = {
  runId: string
  branchRunId: string | null
  nodeRunId: string
  nodeKey: string
  attempt: number
  definition: WorkflowDefinition
  node: WorkflowNode
}

/**
 * 节点处理结果。S4-1 只固定最小形状；S4-3/S4-4 会在此之上扩展
 * （如 ready 的调度提示、waiting_approval 的审批引用），但**不改变分发机制**。
 */
export type NodeHandlerOutcome = {
  status: 'succeeded' | 'failed' | 'waiting_approval' | 'ready' | 'skipped'
  /** status='failed' 时必填：结构化失败（category + nodeKey），不是字符串。 */
  error?: NodeFailure
  patch?: Record<string, unknown>
}

export type NodeHandler = (
  context: NodeHandlerContext,
) => NodeHandlerOutcome | Promise<NodeHandlerOutcome>

export class UnknownNodeHandlerError extends Error {
  constructor(readonly nodeType: string) {
    super(`no handler registered for node type: ${nodeType}`)
    this.name = 'UnknownNodeHandlerError'
  }
}

/**
 * 节点处理器注册表：引擎只按 type 查表分发，**不在引擎核心写 switch**。
 * 新增节点类型 = 注册一个新 handler，不改这里。
 */
export class NodeHandlerRegistry {
  private readonly handlers = new Map<NodeType, NodeHandler>()

  register(type: NodeType, handler: NodeHandler): this {
    this.handlers.set(type, handler)
    return this
  }

  has(type: NodeType): boolean {
    return this.handlers.has(type)
  }

  get(type: NodeType): NodeHandler {
    const handler = this.handlers.get(type)
    if (!handler) throw new UnknownNodeHandlerError(type)
    return handler
  }

  types(): NodeType[] {
    return [...this.handlers.keys()]
  }

  /** 统一异步分发，避免调用方区分同步/异步 handler。 */
  async dispatch(type: NodeType, context: NodeHandlerContext): Promise<NodeHandlerOutcome> {
    return this.get(type)(context)
  }

  /** 引擎启动时校验：MVP 的 7 种节点都必须有 handler（未注册即失败，不静默跳过）。 */
  assertComplete(required: readonly NodeType[] = NODE_TYPES): void {
    const missing = required.filter((type) => !this.handlers.has(type))
    if (missing.length > 0) {
      throw new Error(`missing node handlers: ${missing.join(', ')}`)
    }
  }
}
