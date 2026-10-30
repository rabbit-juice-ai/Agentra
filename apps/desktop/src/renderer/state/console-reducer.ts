import {
  type Execution,
  ExecutionExitedPayload,
  type ExecutionLog,
  ExecutionOutputPayload,
  type ExecutionState,
  ExecutionStatePayload,
  type RuntimeEvent,
} from '@agentra/protocol'

/** 执行控制台的纯状态机：所有事件 → UI 状态的推导都在这里，组件只负责渲染。 */
export type ConsoleState = {
  executions: Execution[]
  selectedId: string | null
  logs: Record<string, ExecutionLog[]>
  lastError: string | null
}

export type ConsoleAction =
  | { type: 'executionsLoaded'; executions: Execution[] }
  | { type: 'executionUpserted'; execution: Execution }
  | { type: 'logsLoaded'; executionId: string; logs: ExecutionLog[] }
  | { type: 'select'; executionId: string | null }
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'error'; message: string | null }

export const initialConsoleState: ConsoleState = {
  executions: [],
  selectedId: null,
  logs: {},
  lastError: null,
}

const TERMINAL: ReadonlySet<ExecutionState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'crashed',
])

export function isTerminalStatus(status: ExecutionState): boolean {
  return TERMINAL.has(status)
}

function upsertExecution(executions: Execution[], execution: Execution): Execution[] {
  const index = executions.findIndex((item) => item.id === execution.id)
  if (index === -1) return [execution, ...executions]
  const next = [...executions]
  next[index] = execution
  return next
}

function patchExecution(
  executions: Execution[],
  executionId: string,
  patch: Partial<Execution>,
): Execution[] {
  return executions.map((item) => (item.id === executionId ? { ...item, ...patch } : item))
}

function sortLogs(logs: ExecutionLog[]): ExecutionLog[] {
  return [...logs].sort((a, b) => a.sequenceNo - b.sequenceNo)
}

function applyEvent(state: ConsoleState, event: RuntimeEvent): ConsoleState {
  switch (event.eventType) {
    case 'execution.output': {
      const parsed = ExecutionOutputPayload.safeParse(event.payload)
      if (!parsed.success) return state
      const payload = parsed.data
      // Core 转发时带持久化后的 log 序号；缺失时退回 Daemon 事件序号。
      const sequenceNo = payload.logSequenceNo ?? payload.sequenceNo
      const existing = state.logs[payload.executionId] ?? []
      if (existing.some((log) => log.sequenceNo === sequenceNo)) return state
      const entry: ExecutionLog = {
        id: event.eventId,
        executionId: payload.executionId,
        sequenceNo,
        stream: payload.stream,
        content: payload.content,
        timestamp: payload.timestamp,
      }
      return {
        ...state,
        logs: { ...state.logs, [payload.executionId]: [...existing, entry] },
      }
    }
    case 'execution.state': {
      const parsed = ExecutionStatePayload.safeParse(event.payload)
      if (!parsed.success) return state
      return {
        ...state,
        executions: patchExecution(state.executions, parsed.data.executionId, {
          status: parsed.data.status,
        }),
      }
    }
    case 'execution.exited': {
      const parsed = ExecutionExitedPayload.safeParse(event.payload)
      if (!parsed.success) return state
      const payload = parsed.data
      const status: ExecutionState =
        payload.reason === 'cancelled'
          ? 'cancelled'
          : payload.reason === 'crashed'
            ? 'crashed'
            : payload.exitCode === 0
              ? 'succeeded'
              : 'failed'
      return {
        ...state,
        executions: patchExecution(state.executions, payload.executionId, {
          status,
          exitCode: payload.exitCode,
        }),
      }
    }
    default:
      return state
  }
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'executionsLoaded': {
      const selectedId =
        state.selectedId && action.executions.some((item) => item.id === state.selectedId)
          ? state.selectedId
          : (action.executions[0]?.id ?? null)
      return { ...state, executions: action.executions, selectedId }
    }
    case 'executionUpserted':
      return { ...state, executions: upsertExecution(state.executions, action.execution) }
    case 'logsLoaded':
      return {
        ...state,
        logs: { ...state.logs, [action.executionId]: sortLogs(action.logs) },
      }
    case 'select':
      return { ...state, selectedId: action.executionId }
    case 'event':
      return applyEvent(state, action.event)
    case 'error':
      return { ...state, lastError: action.message }
    default:
      return state
  }
}

/** 事件是否代表执行进入终态（hooks 据此拉取最终快照与完整日志）。 */
export function terminalExecutionId(event: RuntimeEvent): string | null {
  if (event.eventType === 'execution.exited') return event.aggregateId
  if (event.eventType === 'execution.state') {
    const parsed = ExecutionStatePayload.safeParse(event.payload)
    if (parsed.success && isTerminalStatus(parsed.data.status)) return parsed.data.executionId
  }
  return null
}
