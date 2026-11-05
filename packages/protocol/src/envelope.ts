import { z } from 'zod'
import { ProtocolVersionSchema } from './version'

/** 统一错误码。VERSION_MISMATCH 在信封校验层判定，不进业务处理器。 */
export const RpcErrorCode = z.enum([
  'PARSE_ERROR',
  'INVALID_PARAMS',
  'METHOD_NOT_FOUND',
  'VERSION_MISMATCH',
  'NOT_READY',
  'INTERNAL',
  // 阶段 1：CLI 不可用 / 未认证时启动执行必须返回固定错误码，且不创建 Execution。
  'CLI_UNAVAILABLE',
  'CLI_NOT_AUTHENTICATED',
  // 阶段 1：Provider 显式声明 unsupported 的能力被调用时返回，且不改变执行状态。
  'CAPABILITY_UNSUPPORTED',
  'EXECUTION_NOT_FOUND',
  'AGENT_NOT_FOUND',
  'PROVIDER_NOT_FOUND',
  // 阶段 1 收尾（U3）：Agent 未配置任何允许工具（allow 为空）时启动执行返回该码，且不创建 Execution。
  'AGENT_TOOLS_NOT_CONFIGURED',
  // 阶段 2（PRD A-19 / DEVELOPMENT_PLAN 阶段 2 验收）：两个 Work 争用同一非 Worktree 目录时返回。
  // B2 只加枚举与文档，行为在 B3（工作目录锁）生效。
  'WORKDIR_LOCKED',
  // 阶段 3 B2（第 15 个）：工作流定义里出现 7 种节点白名单之外的 type。
  // 这是错误码，不是 violation —— 校验器不把它放进 violations 数组。
  'UNKNOWN_NODE_TYPE',
  // 阶段 5.5 S55-2B：维护模式拒绝新的外部写请求。
  'MAINTENANCE_ACTIVE',
  // 阶段 5.5 S55-2B：恢复锁/恢复事务未完成，业务 RPC 一律 fail closed。
  'RECOVERY_LOCKED',
  // 阶段 5.5 S55-2B：Core 正在关闭，拒绝新的业务请求。
  'SHUTTING_DOWN',
  // 阶段 5.5 S55-2C：Restore 事务生命周期错误。
  'RESTORE_ALREADY_ACTIVE',
  'RESTORE_PRECHECK_FAILED',
  'RESTORE_DRAIN_TIMEOUT',
  'RESTORE_CHECKPOINT_BUSY',
  'RESTORE_JOURNAL_INVALID',
  'RESTORE_FILESYSTEM_CONFLICT',
  'RESTORE_INSUFFICIENT_SPACE',
])
export type RpcErrorCode = z.infer<typeof RpcErrorCode>

export const RpcError = z.object({
  code: RpcErrorCode,
  message: z.string().min(1),
  /**
   * 结构化补充信息（可选）。形状由具体方法定义；工作流定义校验失败时是
   * `{ violations: [...] }`。纯增量字段，未加 .strict()，不改变 PROTOCOL_VERSION。
   */
  detail: z.unknown().optional(),
})
export type RpcError = z.infer<typeof RpcError>

/** 请求信封：WS 与 UDS/NDJSON 共用同一信封，只是帧格式不同。 */
export const RpcRequest = z.object({
  requestId: z.string().min(8),
  protocolVersion: ProtocolVersionSchema,
  method: z.string().min(1),
  params: z.unknown(),
})
export type RpcRequest = z.infer<typeof RpcRequest>

export const RpcSuccess = z.object({
  requestId: z.string().min(8),
  ok: z.literal(true),
  result: z.unknown(),
})
export type RpcSuccess = z.infer<typeof RpcSuccess>

export const RpcFailure = z.object({
  requestId: z.string().min(8),
  ok: z.literal(false),
  error: RpcError,
})
export type RpcFailure = z.infer<typeof RpcFailure>

export const RpcResponse = z.union([RpcSuccess, RpcFailure])
export type RpcResponse = z.infer<typeof RpcResponse>

/** 构造失败响应的便捷函数。error 经 Zod 校验，未知 code / 空 message 立即抛错。 */
export function rpcFailure(
  requestId: string,
  code: RpcErrorCode,
  message: string,
  detail?: unknown,
): RpcFailure {
  const error: Record<string, unknown> = { code, message }
  if (detail !== undefined) error.detail = detail
  return { requestId, ok: false, error: RpcError.parse(error) }
}

/** 构造成功响应的便捷函数。 */
export function rpcSuccess(requestId: string, result: unknown): RpcSuccess {
  return { requestId, ok: true, result }
}

/**
 * 处理器可抛出的业务错误：分发器把它映射为对应错误码，
 * 而不是统一压成 INTERNAL（否则客户端无法区分可操作的失败原因）。
 */
export class RpcMethodError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RpcMethodError'
  }
}
