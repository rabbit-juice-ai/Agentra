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
])
export type RpcErrorCode = z.infer<typeof RpcErrorCode>

export const RpcError = z.object({
  code: RpcErrorCode,
  message: z.string().min(1),
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
export function rpcFailure(requestId: string, code: RpcErrorCode, message: string): RpcFailure {
  return { requestId, ok: false, error: RpcError.parse({ code, message }) }
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
  ) {
    super(message)
    this.name = 'RpcMethodError'
  }
}
