import fs from 'node:fs'
import path from 'node:path'
import {
  type DaemonExecutionStartParams,
  type DaemonExecutionStartResult,
  type DaemonExecutionStatusResult,
  PROTOCOL_VERSION,
  type RpcErrorCode,
  RpcMethodError,
  type RuntimeEvent as RuntimeEventEnvelope,
} from '@agentra/protocol'
import {
  type ExecutionState,
  type ProviderCapabilities,
  RuntimeError,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeInfo,
  type RuntimeProvider,
} from '@agentra/runtime-sdk'
import { newId } from '@agentra/shared'
import type { RuntimeEventHub } from './event-hub'

const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'crashed',
])

/**
 * 对尚不存在的路径求真实路径：向上找到最近的已存在祖先做 realpath，再把剩余段接回去。
 * 这样「创建之前」就能判断最终落点是否逃逸。
 */
function realpathOfNearestExisting(target: string): string {
  const segments: string[] = []
  let current = target
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return segments.length === 0 ? real : path.join(real, ...segments.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      segments.push(path.basename(current))
      current = parent
    }
  }
}

export type ExecutionLogger = {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

type ExecutionRecord = {
  executionId: string
  providerId: string
  capabilities: ProviderCapabilities
  status: ExecutionState
  processId: number | null
  exitCode: number | null
  startedAt: string | null
  endedAt: string | null
  sequenceNo: number
  unsubscribe: (() => void) | null
}

export type ExecutionManagerOptions = {
  scratchRoot: string
  providers: Map<string, RuntimeProvider>
  hub: RuntimeEventHub
  logger?: ExecutionLogger
  now?: () => string
}

/**
 * Daemon 执行宿主：启动/中断/取消 CLI 进程，把 Provider 事件包装成协议层事件并广播。
 * 不做工作流业务决策，也不访问业务数据库。
 */
export class ExecutionManager {
  private readonly records = new Map<string, ExecutionRecord>()
  private readonly scratchRoot: string
  private readonly providers: Map<string, RuntimeProvider>
  private readonly hub: RuntimeEventHub
  private readonly logger: ExecutionLogger | undefined
  private readonly now: () => string

  constructor(options: ExecutionManagerOptions) {
    this.scratchRoot = path.resolve(options.scratchRoot)
    this.providers = options.providers
    this.hub = options.hub
    this.logger = options.logger
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async discover(): Promise<RuntimeInfo[]> {
    const infos = await Promise.all(
      [...this.providers.values()].map((provider) => provider.discover()),
    )
    return infos.flat()
  }

  async start(params: DaemonExecutionStartParams): Promise<DaemonExecutionStartResult> {
    if (this.records.has(params.executionId)) {
      throw new RpcMethodError(
        'INTERNAL',
        `execution already exists in daemon: ${params.executionId}`,
      )
    }
    const provider = this.providers.get(params.providerId)
    if (!provider) {
      throw new RpcMethodError(
        'PROVIDER_NOT_FOUND',
        `daemon has no runtime for provider ${params.providerId}`,
      )
    }
    const workingDirectory = this.resolveWorkingDirectory(
      params.workingDirectory,
      params.allowedRoots ?? [],
    )

    const record: ExecutionRecord = {
      executionId: params.executionId,
      providerId: params.providerId,
      capabilities: params.capabilities,
      status: 'pending',
      processId: null,
      exitCode: null,
      startedAt: null,
      endedAt: null,
      sequenceNo: 0,
      unsubscribe: null,
    }
    this.records.set(params.executionId, record)
    // 先订阅再启动：不丢失启动瞬间的 running/output/exited 事件。
    record.unsubscribe = provider.subscribe(params.executionId, (event) =>
      this.forward(record, event),
    )

    try {
      const handle = await provider.start({
        executionId: params.executionId,
        prompt: params.prompt,
        workingDirectory,
        sessionId: params.sessionId,
        systemPrompt: params.systemPrompt,
        model: params.model,
        permissionMode: params.permissionMode,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
      })
      record.processId = handle.processId
      record.startedAt = handle.startedAt
      this.logger?.info('execution started', {
        executionId: params.executionId,
        providerId: params.providerId,
        processId: handle.processId,
      })
      return { processId: handle.processId, startedAt: handle.startedAt }
    } catch (error) {
      record.unsubscribe?.()
      this.records.delete(params.executionId)
      this.logger?.warn('execution start failed', {
        executionId: params.executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.raise(error)
    }
  }

  async sendMessage(executionId: string, message: string): Promise<{ sent: true }> {
    const record = this.require(executionId)
    if (record.capabilities.streaming === 'unsupported') {
      throw new RpcMethodError(
        'CAPABILITY_UNSUPPORTED',
        `provider ${record.providerId} declares streaming=unsupported`,
      )
    }
    const provider = this.providerFor(record)
    try {
      await provider.sendMessage(executionId, { role: 'user', content: message })
      return { sent: true }
    } catch (error) {
      this.raise(error)
    }
  }

  async interrupt(executionId: string): Promise<{ interrupted: boolean }> {
    const record = this.require(executionId)
    if (record.capabilities.interrupt === 'unsupported') {
      throw new RpcMethodError(
        'CAPABILITY_UNSUPPORTED',
        `provider ${record.providerId} declares interrupt=unsupported; use cancel instead`,
      )
    }
    if (TERMINAL_STATES.has(record.status)) return { interrupted: false }
    const provider = this.providerFor(record)
    try {
      const result = await provider.interrupt(executionId)
      this.logger?.info('execution interrupt requested', { executionId })
      return { interrupted: result.interrupted }
    } catch (error) {
      this.raise(error)
    }
  }

  async cancel(executionId: string): Promise<{ cancelled: true }> {
    const record = this.require(executionId)
    if (TERMINAL_STATES.has(record.status)) return { cancelled: true }
    const provider = this.providerFor(record)
    try {
      await provider.cancel(executionId)
      this.logger?.info('execution cancel requested', { executionId })
      return { cancelled: true }
    } catch (error) {
      this.raise(error)
    }
  }

  async status(executionId: string): Promise<DaemonExecutionStatusResult> {
    const record = this.require(executionId)
    const provider = this.providerFor(record)
    try {
      const status = await provider.getStatus(executionId)
      return {
        executionId,
        status: status.status,
        processId: status.processId,
        exitCode: status.exitCode,
        startedAt: status.startedAt,
        endedAt: status.endedAt,
      }
    } catch (error) {
      // Provider 已释放记录（保留期结束）：回退到宿主自己的终态记录。
      if (error instanceof RuntimeError && error.code === 'EXECUTION_NOT_FOUND') {
        return {
          executionId,
          status: record.status,
          processId: record.processId,
          exitCode: record.exitCode,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        }
      }
      this.raise(error)
    }
  }

  listActive(): string[] {
    return [...this.records.values()]
      .filter((record) => !TERMINAL_STATES.has(record.status))
      .map((record) => record.executionId)
  }

  /** 进程退出前取消所有运行中的执行，避免留下孤儿进程。 */
  async shutdown(): Promise<void> {
    const active = [...this.records.values()].filter(
      (record) => !TERMINAL_STATES.has(record.status),
    )
    await Promise.all(
      active.map(async (record) => {
        try {
          await this.providerFor(record).cancel(record.executionId)
        } catch {
          // 关闭路径尽力而为。
        }
      }),
    )
  }

  private providerFor(record: ExecutionRecord): RuntimeProvider {
    const provider = this.providers.get(record.providerId)
    if (!provider) {
      throw new RpcMethodError(
        'PROVIDER_NOT_FOUND',
        `daemon has no runtime for provider ${record.providerId}`,
      )
    }
    return provider
  }

  private require(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId)
    if (!record) {
      throw new RpcMethodError(
        'EXECUTION_NOT_FOUND',
        `daemon does not know execution ${executionId}`,
      )
    }
    return record
  }

  /**
   * 工作目录边界校验：实际目录必须落在 scratch 根或 Core 声明的 allowedRoots 之内。
   * 符号链接逃逸同样要挡（realpath 后再比一次）。
   */
  private resolveWorkingDirectory(input: string, allowedRoots: string[]): string {
    const dir = path.resolve(input)
    const roots = [this.scratchRoot, ...allowedRoots.map((root) => path.resolve(root))]
    const within = (candidate: string, root: string): boolean =>
      candidate === root || candidate.startsWith(`${root}${path.sep}`)

    if (!roots.some((root) => within(dir, root))) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `working directory is outside the allowed roots: ${input}`,
      )
    }
    const realRoots = roots.map((root) => {
      try {
        return fs.realpathSync(root)
      } catch {
        return root
      }
    })
    // 先 realpath 再 mkdir：目录还不存在时，用最近的已存在祖先做判定，
    // 避免「根内有指向外部的符号链接」时先把目录创建到根外、再拒绝。
    const resolvedBefore = realpathOfNearestExisting(dir)
    if (!realRoots.some((root) => within(resolvedBefore, root))) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `working directory escapes allowed roots via symlink: ${input}`,
      )
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const realDir = fs.realpathSync(dir)
    if (!realRoots.some((root) => within(realDir, root))) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `working directory escapes allowed roots via symlink: ${input}`,
      )
    }
    return realDir
  }

  private forward(record: ExecutionRecord, event: RuntimeEvent): void {
    record.sequenceNo += 1
    const sequenceNo = record.sequenceNo
    const occurredAt = event.timestamp || this.now()
    const base: Omit<RuntimeEventEnvelope, 'eventType' | 'payload'> = {
      eventId: newId('evt'),
      protocolVersion: PROTOCOL_VERSION,
      occurredAt,
      aggregateType: 'execution',
      aggregateId: record.executionId,
      correlationId: record.executionId,
    }

    let envelope: RuntimeEventEnvelope
    if (event.type === 'output') {
      envelope = {
        ...base,
        eventType: 'execution.output',
        payload: {
          executionId: record.executionId,
          sequenceNo,
          stream: event.stream,
          content: event.content,
          timestamp: occurredAt,
        },
      }
    } else if (event.type === 'state') {
      record.status = event.status
      if (event.status === 'running' && !record.startedAt) record.startedAt = occurredAt
      if (TERMINAL_STATES.has(event.status)) record.endedAt = occurredAt
      envelope = {
        ...base,
        eventType: 'execution.state',
        payload: {
          executionId: record.executionId,
          sequenceNo,
          status: event.status,
          previousStatus: event.previousStatus,
          detail: event.detail,
          timestamp: occurredAt,
        },
      }
    } else {
      record.exitCode = event.exitCode
      record.endedAt = occurredAt
      record.status =
        event.reason === 'cancelled'
          ? 'cancelled'
          : event.reason === 'crashed'
            ? 'crashed'
            : event.exitCode === 0
              ? 'succeeded'
              : 'failed'
      envelope = {
        ...base,
        eventType: 'execution.exited',
        payload: {
          executionId: record.executionId,
          sequenceNo,
          exitCode: event.exitCode,
          signal: event.signal,
          reason: event.reason,
          timestamp: occurredAt,
        },
      }
      record.unsubscribe?.()
      record.unsubscribe = null
    }

    this.hub.publish(envelope)
  }

  private raise(error: unknown): never {
    if (error instanceof RuntimeError) {
      throw new RpcMethodError(toRpcErrorCode(error.code), error.message)
    }
    throw error
  }
}

/**
 * Runtime SDK 错误码 → 协议错误码。
 * SDK 多出的 RUNTIME_ERROR 在协议层没有对应值，归入 INTERNAL（客户端只需知道不可重试的入参问题）。
 */
function toRpcErrorCode(code: RuntimeErrorCode): RpcErrorCode {
  return code === 'RUNTIME_ERROR' ? 'INTERNAL' : code
}
