import type { z } from 'zod'
import {
  type RpcFailure,
  RpcMethodError,
  RpcRequest,
  type RpcResponse,
  rpcFailure,
  rpcSuccess,
} from './envelope'
import { PROTOCOL_VERSION } from './version'

/**
 * RPC 分发表（ARCHITECTURE §7）。
 *
 * 为什么在这里而不是各进程各写一份：handler 的**返回类型**必须与 result schema 绑定。
 * 早先的版本把 handler 声明为 `(params: unknown) => unknown`，params 靠 `as` 断言、result 完全没绑，
 * 导致"Daemon 返回的形状与协议 DTO 不一致"只能等 Core 侧运行时 parse 才暴露。
 * 现在 params 由 paramsSchema 推断、返回值受 resultSchema 约束，并在分发时校验。
 */

/** 每个连接一份：事件推送与关闭回调（订阅型方法需要）。 */
export type RpcContext = {
  push: (frame: unknown) => void
  onClose: (listener: () => void) => void
}

/** 方法访问级别：默认 write，只读方法必须显式标记。 */
export type RpcMethodAccess = 'read' | 'write'

export type RpcMethodDef<P, R> = {
  paramsSchema: z.ZodType<P>
  resultSchema: z.ZodType<R>
  access: RpcMethodAccess
  // 方法语法（而非属性箭头函数）是刻意的：让参数位置按双变（bivariant）检查，
  // 使具体签名的方法可以放进擦除后的 MethodTable，同时保留定义处的类型推断。
  handler(params: P, ctx: RpcContext): R | Promise<R>
}

/** 擦除具体 params/result 的分发表；类型安全由 defineMethod 在定义处保证。 */
export type MethodTable = Record<string, RpcMethodDef<unknown, unknown>>

/** 分发前授权/分发生命周期钩子；由 Core 维护模式接线使用。 */
export type DispatchHooks = {
  /** 返回非 null 时直接以该失败响应结束，不进入 params/handler。 */
  authorize?: (requestId: string, method: string, access: RpcMethodAccess) => RpcFailure | null
  /** 在 params 校验前调用；返回的函数在 handler/result 校验后执行。 */
  onStart?: (method: string, access: RpcMethodAccess) => (() => void) | undefined
}

/** 定义一个 RPC 方法：params 由 schema 推断，handler 返回值受 result schema 约束。 */
export function defineMethod<P, R>(
  paramsSchema: z.ZodType<P>,
  resultSchema: z.ZodType<R>,
  handler: (params: P, ctx: RpcContext) => R | Promise<R>,
  access: RpcMethodAccess = 'write',
): RpcMethodDef<P, R> {
  return { paramsSchema, resultSchema, access, handler }
}

const NOOP_CONTEXT: RpcContext = { push: () => {}, onClose: () => {} }

/**
 * 帧解析 + 信封校验 + method 分发。
 * 校验顺序：JSON 解析 → 信封（含 protocolVersion）→ method 查表 → params 校验 → handler → result 校验。
 * 业务处理器抛 RpcMethodError 时保留其错误码（如 CLI_UNAVAILABLE / CLI_NOT_AUTHENTICATED）。
 */
export function createDispatcher(methods: MethodTable, hooks: DispatchHooks = {}) {
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

    const request = checked.data
    const entry = methods[request.method]
    if (!entry) {
      return rpcFailure(request.requestId, 'METHOD_NOT_FOUND', `unknown method: ${request.method}`)
    }

    const denied = hooks.authorize?.(request.requestId, request.method, entry.access)
    if (denied) return denied

    const release = hooks.onStart?.(request.method, entry.access)
    try {
      let params: unknown
      try {
        params = entry.paramsSchema.parse(request.params)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return rpcFailure(request.requestId, 'INVALID_PARAMS', message)
      }

      let result: unknown
      try {
        result = await entry.handler(params, ctx)
      } catch (error) {
        if (error instanceof RpcMethodError) {
          return rpcFailure(request.requestId, error.code, error.message, error.detail)
        }
        // 处理器内部失败不是入参问题：回 INTERNAL，避免客户端误判为可重试的入参错误。
        const message = error instanceof Error ? error.message : String(error)
        return rpcFailure(request.requestId, 'INTERNAL', message)
      }

      // 出站校验：handler 返回值必须满足 result schema，否则说明实现与协议契约已经漂移。
      const checkedResult = entry.resultSchema.safeParse(result)
      if (!checkedResult.success) {
        return rpcFailure(
          request.requestId,
          'INTERNAL',
          `handler for ${request.method} returned a value that violates its result schema: ${checkedResult.error.message}`,
        )
      }

      return rpcSuccess(request.requestId, checkedResult.data)
    } finally {
      release?.()
    }
  }
}
