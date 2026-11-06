import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import {
  type ExecutionHandle,
  type ExecutionState,
  type ExecutionStatus,
  type InterruptResult,
  type ProviderCapabilities,
  type RuntimeConfig,
  RuntimeError,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeHealth,
  type RuntimeInfo,
  type RuntimeMessage,
  type RuntimeProvider,
  type StartExecutionConfig,
  type Unsubscribe,
} from '@agentra/runtime-sdk'
import { buildChildEnv, buildClaudeArgs } from './args'
import { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_PROVIDER_ID } from './capabilities'
import { type DiscoveryOptions, discoverClaudeCode } from './discovery'
import {
  buildInterruptFrame,
  buildUserFrame,
  parseStderrLine,
  parseStdoutLine,
  readResultFrame,
  splitLines,
} from './stream-json'

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
  resultReceived: boolean
  resultIsError: boolean
  stdoutRest: string
  stderrRest: string
  stdinClosed: boolean
  timers: NodeJS.Timeout[]
}

const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'crashed',
])

const KILL_GRACE_MS = 3000
const INTERRUPT_GRACE_MS = 5000
const RETENTION_MS = 5 * 60 * 1000

/**
 * Claude Code CLI Provider（首个真实 Provider，决策 D-014）。
 * 进程生命周期由本适配器管理；业务状态由 Core 决定，这里只报告事实。
 */
export class ClaudeCodeProvider implements RuntimeProvider {
  readonly id: string = CLAUDE_CODE_PROVIDER_ID
  protected readonly capabilities: ProviderCapabilities = CLAUDE_CODE_CAPABILITIES
  protected readonly cliName: string = 'Claude Code'
  private readonly executions = new Map<string, ManagedExecution>()
  private readonly pendingListeners = new Map<string, Set<RuntimeEventListener>>()
  protected readonly discovery: DiscoveryOptions
  /** 构造时显式注入的路径（测试/自定义安装），发现时优先使用。 */
  protected readonly injectedPath: string | null
  protected executablePath: string | null

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    this.injectedPath = options.executablePath ?? null
    this.executablePath = this.injectedPath
    this.discovery = options.discovery ?? {}
  }

  async discover(): Promise<RuntimeInfo[]> {
    const info = await this.discoverInfo()
    this.executablePath = info.executablePath
    return [info]
  }

  protected async discoverInfo(): Promise<RuntimeInfo> {
    const discovery: DiscoveryOptions = this.injectedPath
      ? {
          ...this.discovery,
          env: { ...(this.discovery.env ?? process.env), AGENTRA_CLAUDE_PATH: this.injectedPath },
        }
      : this.discovery
    return discoverClaudeCode(discovery)
  }

  protected buildArgs(config: StartExecutionConfig): string[] {
    return buildClaudeArgs(config)
  }

  async inspect(config: RuntimeConfig): Promise<RuntimeHealth> {
    const [info] = await this.discover()
    if (!info) {
      return {
        status: 'unknown',
        detail: 'discovery returned no provider',
        checkedAt: new Date().toISOString(),
      }
    }
    if (config.executablePath && info.executablePath !== config.executablePath) {
      return {
        status: 'unavailable',
        detail: `executable mismatch: expected ${config.executablePath}, found ${info.executablePath ?? 'none'}`,
        checkedAt: new Date().toISOString(),
      }
    }
    return {
      status: info.healthStatus,
      detail: info.healthDetail,
      checkedAt: info.discoveredAt,
    }
  }

  async start(config: StartExecutionConfig): Promise<ExecutionHandle> {
    if (this.executions.has(config.executionId)) {
      throw new RuntimeError('RUNTIME_ERROR', `execution already started: ${config.executionId}`)
    }
    const executablePath = this.executablePath
    if (!executablePath) {
      throw new RuntimeError(
        'CLI_UNAVAILABLE',
        `${this.cliName} 可执行文件未知。请先运行 Provider 发现，或设置对应路径环境变量。`,
      )
    }

    const child = spawn(executablePath, this.buildArgs(config), {
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
      resultReceived: false,
      resultIsError: false,
      stdoutRest: '',
      stderrRest: '',
      stdinClosed: false,
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
    try {
      child.stdin.write(buildUserFrame(config.prompt))
    } catch (error) {
      throw new RuntimeError(
        'RUNTIME_ERROR',
        `无法写入初始 prompt：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return {
      executionId: config.executionId,
      providerId: this.id,
      processId: managed.processId,
      startedAt: managed.startedAt,
    }
  }

  async sendMessage(executionId: string, message: RuntimeMessage): Promise<void> {
    if (this.capabilities.streaming === 'unsupported') {
      throw new RuntimeError('CAPABILITY_UNSUPPORTED', 'provider does not support streaming input')
    }
    const managed = this.require(executionId)
    if (managed.status !== 'running') {
      throw new RuntimeError('RUNTIME_ERROR', `execution ${executionId} is not running`)
    }
    if (managed.resultReceived) {
      throw new RuntimeError(
        'RUNTIME_ERROR',
        'execution turn already completed; start a new execution (resume is not exposed in phase 1)',
      )
    }
    this.writeStdin(managed, buildUserFrame(message.content))
  }

  async interrupt(executionId: string): Promise<InterruptResult> {
    if (this.capabilities.interrupt === 'unsupported') {
      throw new RuntimeError('CAPABILITY_UNSUPPORTED', 'provider does not support interrupt')
    }
    const managed = this.require(executionId)
    if (managed.status !== 'running')
      return { interrupted: false, detail: 'execution already finished' }
    managed.interrupted = true
    this.writeStdin(managed, buildInterruptFrame(crypto.randomUUID()))
    // 中断后 CLI 应返回 result 帧；若未返回，宽限期后关闭 stdin 让进程退出。
    const timer = setTimeout(() => {
      if (managed.status === 'running') this.closeStdin(managed)
    }, INTERRUPT_GRACE_MS)
    timer.unref()
    managed.timers.push(timer)
    return { interrupted: true }
  }

  async resume(): Promise<ExecutionHandle> {
    // 与 CLAUDE_CODE_CAPABILITIES.resume=unsupported 一致：未实现即不得提供可用路径。
    throw new RuntimeError(
      'CAPABILITY_UNSUPPORTED',
      `${this.cliName} declares resume=unsupported; start a new execution instead`,
    )
  }

  async cancel(executionId: string): Promise<void> {
    const managed = this.require(executionId)
    if (TERMINAL_STATES.has(managed.status)) return
    managed.cancelRequested = true
    managed.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!TERMINAL_STATES.has(managed.status)) {
        managed.child.kill('SIGKILL')
      }
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
    // 允许宿主在 start 之前预注册：避免丢失启动瞬间的 running/output/exited 事件。
    const pending = this.pendingListeners.get(executionId) ?? new Set<RuntimeEventListener>()
    pending.add(listener)
    this.pendingListeners.set(executionId, pending)
    return () => {
      const current = this.pendingListeners.get(executionId)
      current?.delete(listener)
      if (current && current.size === 0) this.pendingListeners.delete(executionId)
    }
  }

  /** 进程仍在运行（未终结）的执行 ID 列表：Core 重连后据此对账。 */
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
      for (const line of lines) this.handleStderrLine(managed, line)
    })

    child.stdin.on('error', () => {
      // 子进程提前退出时写 stdin 会 EPIPE；由 exit 处理收尾，这里不吞其他错误类型。
    })

    child.once('exit', (code, signal) => {
      // 冲刷半行缓冲，避免丢失最后一段无换行输出。
      if (managed.stdoutRest.trim().length > 0) {
        this.handleStdoutLine(managed, managed.stdoutRest)
        managed.stdoutRest = ''
      }
      if (managed.stderrRest.trim().length > 0) {
        this.handleStderrLine(managed, managed.stderrRest)
        managed.stderrRest = ''
      }
      this.finalize(managed, code, signal)
    })
  }

  private handleStdoutLine(managed: ManagedExecution, line: string): void {
    const result = readResultFrame(line)
    if (result) {
      managed.resultReceived = true
      managed.resultIsError = result.isError
    }
    for (const parsed of parseStdoutLine(line)) {
      this.emit(managed, {
        type: 'output',
        stream: parsed.stream,
        content: parsed.content,
        timestamp: new Date().toISOString(),
      })
    }
    if (result) {
      // 单回合执行模型：回合结束后关闭 stdin，让 CLI 正常退出并留下 exit_code。
      this.closeStdin(managed)
    }
  }

  private handleStderrLine(managed: ManagedExecution, line: string): void {
    for (const parsed of parseStderrLine(line)) {
      this.emit(managed, {
        type: 'output',
        stream: parsed.stream,
        content: parsed.content,
        timestamp: new Date().toISOString(),
      })
    }
  }

  private finalize(
    managed: ManagedExecution,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (TERMINAL_STATES.has(managed.status)) return
    this.clearTimers(managed)
    managed.exitCode = code
    managed.endedAt = new Date().toISOString()
    const status: ExecutionState =
      managed.cancelRequested || managed.interrupted
        ? 'cancelled'
        : signal
          ? 'crashed'
          : code === 0 && !managed.resultIsError
            ? 'succeeded'
            : 'failed'
    const reason =
      status === 'cancelled' ? 'cancelled' : status === 'crashed' ? 'crashed' : 'exited'
    managed.status = status
    this.emit(managed, {
      type: 'exited',
      exitCode: code,
      signal,
      reason,
      timestamp: managed.endedAt,
    })
    this.emit(managed, {
      type: 'state',
      status,
      previousStatus: 'running',
      detail: signal ? `terminated by ${signal}` : `exit code ${code}`,
      timestamp: managed.endedAt,
    })
    // 保留一段时间供状态查询；到期后释放，避免长期占用内存。
    const timer = setTimeout(() => {
      this.executions.delete(managed.executionId)
    }, RETENTION_MS)
    timer.unref()
  }

  private transition(managed: ManagedExecution, status: ExecutionState, detail?: string): void {
    const previousStatus = managed.status
    if (previousStatus === status) return
    managed.status = status
    this.emit(managed, {
      type: 'state',
      status,
      previousStatus,
      detail,
      timestamp: new Date().toISOString(),
    })
  }

  private emit(managed: ManagedExecution, event: RuntimeEvent): void {
    for (const listener of managed.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅者异常不得影响执行与其他订阅者。
      }
    }
  }

  private writeStdin(managed: ManagedExecution, frame: string): void {
    if (managed.stdinClosed || managed.child.stdin.destroyed) {
      throw new RuntimeError('RUNTIME_ERROR', `execution ${managed.executionId} stdin is closed`)
    }
    managed.child.stdin.write(frame)
  }

  private closeStdin(managed: ManagedExecution): void {
    if (managed.stdinClosed) return
    managed.stdinClosed = true
    try {
      managed.child.stdin.end()
    } catch {
      // 进程已退出：忽略。
    }
  }

  private clearTimers(managed: ManagedExecution): void {
    for (const timer of managed.timers.splice(0)) clearTimeout(timer)
  }
}

export { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_PROVIDER_ID }
