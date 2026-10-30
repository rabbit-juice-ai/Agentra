import type { RpcResponse } from '@agentra/protocol'
import { PROTOCOL_VERSION, RpcMethodError, RpcRequest, rpcFailure } from '@agentra/protocol'

/** 每个连接一份：事件推送与关闭回调（订阅型连接需要）。 */
export type RpcContext = {
  push: (frame: unknown) => void
  onClose: (listener: () => void) => void
}

export type RpcHandler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>

export type MethodTable = Record<
  string,
  { handler: RpcHandler; paramsSchema: null | { parse: (p: unknown) => unknown } }
>

const NOOP_CONTEXT: RpcContext = { push: () => {}, onClose: () => {} }

/**
 * NDJSON 帧解析 + 信封校验 + method 分发。
 * 校验顺序：JSON 解析 → 信封（含 protocolVersion）→ method 查表 → params 校验 → handler。
 * 业务处理器抛 RpcMethodError 时保留其错误码（如 CLI_UNAVAILABLE）。
 */
export function createDispatcher(methods: MethodTable) {
  return async function dispatch(
    frame: string,
    ctx: RpcContext = NOOP_CONTEXT,
  ): Promise<RpcResponse> {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      return rpcFailure('parse-error--', 'PARSE_ERROR', 'frame is not valid JSON')
    }

    const checked = RpcRequest.safeParse(parsed)
    if (!checked.success) {
      // 区分版本不匹配与其他信封错误，客户端据此知道要不要升级。
      const version = (parsed as { protocolVersion?: unknown } | null)?.protocolVersion
      if (typeof version === 'string' && version !== PROTOCOL_VERSION) {
        const requestId =
          typeof (parsed as { requestId?: unknown }).requestId === 'string'
            ? (parsed as { requestId: string }).requestId
            : 'version-mismatch'
        return rpcFailure(
          requestId,
          'VERSION_MISMATCH',
          `protocol version ${version} not supported; server speaks ${PROTOCOL_VERSION}`,
        )
      }
      return rpcFailure('invalid-request', 'PARSE_ERROR', 'request envelope failed validation')
    }

    const request: RpcRequest = checked.data
    const entry = methods[request.method]
    if (!entry) {
      return rpcFailure(request.requestId, 'METHOD_NOT_FOUND', `unknown method: ${request.method}`)
    }
    let params: unknown
    try {
      params = entry.paramsSchema ? entry.paramsSchema.parse(request.params) : request.params
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return rpcFailure(request.requestId, 'INVALID_PARAMS', message)
    }

    try {
      const result = await entry.handler(params, ctx)
      return { requestId: request.requestId, ok: true, result }
    } catch (error) {
      if (error instanceof RpcMethodError) {
        return rpcFailure(request.requestId, error.code, error.message)
      }
      // 处理器内部失败不是入参问题：回 INTERNAL，避免客户端误判为可重试的入参错误。
      const message = error instanceof Error ? error.message : String(error)
      return rpcFailure(request.requestId, 'INTERNAL', message)
    }
  }
}
