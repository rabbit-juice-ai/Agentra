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

/** 构造失败响应的便捷函数。 */
export function rpcFailure(requestId: string, code: RpcErrorCode, message: string): RpcFailure {
  return { requestId, ok: false, error: { code, message } }
}

/** 构造成功响应的便捷函数。 */
export function rpcSuccess(requestId: string, result: unknown): RpcSuccess {
  return { requestId, ok: true, result }
}
