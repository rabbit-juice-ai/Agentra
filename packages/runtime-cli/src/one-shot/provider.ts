import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import {
  type ExecutionHandle,
  type ExecutionState,
  type ExecutionStatus,
  type InterruptResult,
  type ProviderCapabilities,
  RuntimeError,
  type RuntimeEventListener,
  type RuntimeHealth,
  type RuntimeInfo,
  type RuntimeProvider,
  type StartExecutionConfig,
  type Unsubscribe,
} from '@agentra/runtime-sdk'
import { buildChildEnv } from '../claude-code/args'

const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'crashed',
])
const KILL_GRACE_MS = 3000
const RETENTION_MS = 5 * 60 * 1000

type ManagedExecution = {
  executionId: string
  child: ChildProcessWithoutNullStreams
  status: ExecutionState
  processId: number | null
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  listeners: Set<RuntimeEventListener>
  cancelRequested: boolean
  interrupted: boolean
  stdoutRest: string
  stderrRest: string
  text: string
  error: string | null
  timers: NodeJS.Timeout[]
}

export type OneShotParseState = {
  appendText: (text: string) => void
  setText: (text: string) => void
  markError: (message: string) => void
}

/**
 * 单回合 CLI Provider 基类（Codex / Gemini 等）。
 *
 * 这些 CLI 的 headless 模式是「启动 → 输出 JSONL → 退出」，没有 Claude Code 的
 * 双向 stream-json 会话，因此 sendMessage/resume 明确不支持；能力声明必须如实反映。
 * 进程生命周期、事件分发与取消逻辑在这里统一实现，子类只负责发现、参数和输出解析。
 */
export abstract class OneShotCliProvider implements RuntimeProvider {
  abstract readonly id: string
  abstract readonly name: string
  protected abstract readonly capabilities: ProviderCapabilities
  protected abstract readonly installHint: string
  protected executablePath: string | null

  private readonly executions = new Map<string, ManagedExecution>()
  private readonly pendingListeners = new Map<string, Set<RuntimeEventListener>>()

  constructor(executablePath: string | null) {
    this.executablePath = executablePath
  }

  abstract discover(): Promise<RuntimeInfo[]>

  async inspect(config: {
    providerId: string
    executablePath: string | null
  }): Promise<RuntimeHealth> {
    const [info] = await this.discover()
    if (!info) {
      return {
        status: 'unavailable',
        detail: this.installHint,
        checkedAt: new Date().toISOString(),
      }
    }
    if (config.executablePath && info.executablePath !== config.executablePath) {
      return {
        status: 'unavailable',
        detail: `executable mismatch: expected ${config.executablePath}, found ${info.executablePath ?? 'none'}`,
        checkedAt: info.discoveredAt,
      }
    }
    return {
      status: info.healthStatus,
      detail: info.healthDetail,
      checkedAt: info.discoveredAt,
    }
  }

  protected abstract argsFor(config: StartExecutionConfig): string[]

  protected abstract parseLine(line: string, state: OneShotParseState): void

  async start(config: StartExecutionConfig): Promise<ExecutionHandle> {
    if (this.executions.has(config.executionId)) {
      throw new RuntimeError('RUNTIME_ERROR', `execution already started: ${config.executionId}`)
    }
    const executablePath = this.executablePath
    if (!executablePath) throw new RuntimeError('CLI_UNAVAILABLE', this.installHint)

    const child = spawn(executablePath, this.argsFor(config), {
      cwd: config.workingDirectory,
      env: buildChildEnv(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    const managed: ManagedExecution = {
      executionId: config.executionId,
      child,
      status: 'pending',
      processId: child.pid ?? null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      listeners: new Set(),
      cancelRequested: false,
      interrupted: false,
      stdoutRest: '',
      stderrRest: '',
      text: '',
      error: null,
      timers: [],
    }
    const pending = this.pendingListeners.get(config.executionId)
    if (pending) {
      for (const listener of pending) managed.listeners.add(listener)
      this.pendingListeners.delete(config.executionId)
    }
    this.executions.set(config.executionId, managed)
    this.attach(managed)

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (error) => {
          this.executions.delete(config.executionId)
          reject(
            new RuntimeError(
              'CLI_UNAVAILABLE',
              `无法启动 ${executablePath}：${error.message}。请检查安装与执行权限。`,
            ),
          )
        })
      })
    } catch (error) {
      this.clearTimers(managed)
      throw error
    }

    managed.startedAt = new Date().toISOString()
    this.transition(managed, 'running', 'process spawned')
    // 单回合模式：prompt 已通过 argv 传入，不需要 stdin。
    child.stdin.end()
    return {
      executionId: config.executionId,
      providerId: this.id,
      processId: managed.processId,
      startedAt: managed.startedAt,
    }
  }

  async sendMessage(): Promise<void> {
    throw new RuntimeError(
      'CAPABILITY_UNSUPPORTED',
      `${this.name} headless 模式不支持在单次执行中追加消息；请启动新的执行。`,
    )
  }

  async interrupt(executionId: string): Promise<InterruptResult> {
    const managed = this.require(executionId)
    if (managed.status !== 'running')
      return { interrupted: false, detail: 'execution already finished' }
    managed.interrupted = true
    managed.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!TERMINAL_STATES.has(managed.status)) managed.child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref()
    managed.timers.push(timer)
    return { interrupted: true, detail: 'SIGTERM sent to the CLI process' }
  }

  async resume(): Promise<ExecutionHandle> {
    throw new RuntimeError(
      'CAPABILITY_UNSUPPORTED',
      `${this.name} 不声明会话恢复能力；请启动新的执行。`,
    )
  }

  async cancel(executionId: string): Promise<void> {
    const managed = this.require(executionId)
    if (TERMINAL_STATES.has(managed.status)) return
    managed.cancelRequested = true
    managed.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!TERMINAL_STATES.has(managed.status)) managed.child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref()
    managed.timers.push(timer)
  }

  async getStatus(executionId: string): Promise<ExecutionStatus> {
    const managed = this.require(executionId)
    return {
      executionId,
      status: managed.status,
      processId: managed.processId,
      exitCode: managed.exitCode,
      startedAt: managed.startedAt,
      endedAt: managed.endedAt,
    }
  }

  subscribe(executionId: string, listener: RuntimeEventListener): Unsubscribe {
    const managed = this.executions.get(executionId)
    if (managed) {
      managed.listeners.add(listener)
      return () => {
        managed.listeners.delete(listener)
      }
    }
    const pending = this.pendingListeners.get(executionId) ?? new Set<RuntimeEventListener>()
    pending.add(listener)
    this.pendingListeners.set(executionId, pending)
    return () => {
      const current = this.pendingListeners.get(executionId)
      current?.delete(listener)
      if (current && current.size === 0) this.pendingListeners.delete(executionId)
    }
  }

  listActive(): string[] {
    return [...this.executions.values()]
      .filter((managed) => !TERMINAL_STATES.has(managed.status))
      .map((managed) => managed.executionId)
  }

  private require(executionId: string): ManagedExecution {
    const managed = this.executions.get(executionId)
    if (!managed) {
      throw new RuntimeError('EXECUTION_NOT_FOUND', `unknown execution: ${executionId}`)
    }
    return managed
  }

  private attach(managed: ManagedExecution): void {
    const { child } = managed
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const { lines, rest } = splitLines(managed.stdoutRest, chunk)
      managed.stdoutRest = rest
      for (const line of lines) this.handleStdoutLine(managed, line)
    })
    child.stderr.on('data', (chunk: string) => {
      const { lines, rest } = splitLines(managed.stderrRest, chunk)
      managed.stderrRest = rest
      for (const line of lines) this.emitOutput(managed, 'stderr', line)
    })
    child.stdin.on('error', () => {
      // 子进程提前退出时写 stdin 会 EPIPE；由 exit 收尾。
    })
    child.once('exit', (code, signal) => {
      if (managed.stdoutRest.trim().length > 0) {
        this.handleStdoutLine(managed, managed.stdoutRest)
        managed.stdoutRest = ''
      }
      if (managed.stderrRest.trim().length > 0) {
        this.emitOutput(managed, 'stderr', managed.stderrRest)
        managed.stderrRest = ''
      }
      this.finalize(managed, code, signal)
    })
  }

  private handleStdoutLine(managed: ManagedExecution, line: string): void {
    if (line.trim().length === 0) return
    // 原始 JSONL 保留为 structured 诊断日志；最终 Agent 文本会单独以 stdout 输出，
    // 这样 ArtifactExchange 只读取一次正式输出，不会被中间事件污染。
    this.emitOutput(managed, 'structured', line)
    try {
      this.parseLine(line, {
        appendText: (text) => {
          managed.text += text
        },
        setText: (text) => {
          managed.text = text
        },
        markError: (message) => {
          managed.error = message
        },
      })
    } catch {
      // 解析失败不终止进程；最终以 exit code 与已收集文本判定。
    }
  }

  private finalize(managed: ManagedExecution, code: number | null, signal: string | null): void {
    if (TERMINAL_STATES.has(managed.status)) return
    const text = managed.text.trim()
    if (text.length > 0) this.emitOutput(managed, 'stdout', text)
    managed.exitCode = code
    managed.endedAt = new Date().toISOString()
    const cancelled = managed.cancelRequested || managed.interrupted
    const status: ExecutionState = cancelled
      ? 'cancelled'
      : managed.error !== null || code !== 0
        ? 'failed'
        : 'succeeded'
    if (managed.error && status === 'failed') {
      this.emitOutput(managed, 'stderr', managed.error)
    }
    this.transition(
      managed,
      status,
      managed.error ?? (signal ? `signal ${signal}` : 'process exited'),
    )
    for (const listener of managed.listeners) {
      try {
        listener({
          type: 'exited',
          exitCode: code,
          signal,
          reason: cancelled ? 'cancelled' : 'exited',
          timestamp: managed.endedAt,
        })
      } catch {
        // 单个订阅者异常不影响其他订阅者。
      }
    }
    this.clearTimers(managed)
    const timer = setTimeout(() => {
      this.executions.delete(managed.executionId)
    }, RETENTION_MS)
    timer.unref()
    managed.timers.push(timer)
  }

  private transition(managed: ManagedExecution, status: ExecutionState, detail?: string): void {
    const previous = managed.status
    if (previous === status) return
    managed.status = status
    for (const listener of managed.listeners) {
      try {
        listener({
          type: 'state',
          status,
          previousStatus: previous,
          ...(detail ? { detail } : {}),
          timestamp: new Date().toISOString(),
        })
      } catch {
        // 单个订阅者异常不影响其他订阅者。
      }
    }
  }

  private emitOutput(
    managed: ManagedExecution,
    stream: 'stdout' | 'stderr' | 'structured',
    content: string,
  ): void {
    for (const listener of managed.listeners) {
      try {
        listener({ type: 'output', stream, content, timestamp: new Date().toISOString() })
      } catch {
        // 单个订阅者异常不影响其他订阅者。
      }
    }
  }

  private clearTimers(managed: ManagedExecution): void {
    for (const timer of managed.timers) clearTimeout(timer)
    managed.timers = []
  }
}

function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const combined = rest + chunk
  const parts = combined.split('\n')
  const nextRest = parts.pop() ?? ''
  return { lines: parts, rest: nextRest }
}
