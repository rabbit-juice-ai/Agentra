import type {
  ExecutionHandle,
  ExecutionStatus,
  InterruptResult,
  ProviderModelInfo,
  RuntimeConfig,
  RuntimeEventListener,
  RuntimeHealth,
  RuntimeInfo,
  RuntimeMessage,
  StartExecutionConfig,
  Unsubscribe,
} from './types'

/**
 * 运行时错误码：与 protocol 的 RpcErrorCode 同名，由 Daemon 原样映射回 RPC 错误。
 * 不让适配器直接依赖 protocol，保持 Runtime SDK 与传输层解耦。
 */
export type RuntimeErrorCode =
  | 'CLI_UNAVAILABLE'
  | 'CLI_NOT_AUTHENTICATED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'EXECUTION_NOT_FOUND'
  | 'RUNTIME_ERROR'

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

/** 统一运行时接口（ARCHITECTURE §5）。resume 能力在 MVP 中可声明但不由 UI 触发。 */
export interface RuntimeProvider {
  readonly id: string
  discover(): Promise<RuntimeInfo[]>
  inspect(config: RuntimeConfig): Promise<RuntimeHealth>
  start(config: StartExecutionConfig): Promise<ExecutionHandle>
  sendMessage(executionId: string, message: RuntimeMessage): Promise<void>
  interrupt(executionId: string): Promise<InterruptResult>
  resume(executionId: string, checkpoint?: string): Promise<ExecutionHandle>
  cancel(executionId: string): Promise<void>
  getStatus(executionId: string): Promise<ExecutionStatus>
  subscribe(executionId: string, listener: RuntimeEventListener): Unsubscribe
  /** 可选：从 CLI 动态读取可用模型；不支持或失败时返回 []，Core 回退内置目录。 */
  listModels?(): Promise<ProviderModelInfo[]>
}
