import type { Execution, ExecutionLog, RuntimeEvent } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import {
  consoleReducer,
  initialConsoleState,
  isTerminalStatus,
  terminalExecutionId,
} from './console-reducer'

const CAPABILITIES = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'native',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
} as const

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'exe-1',
    sessionId: 'ses-1',
    providerId: 'claude-code',
    agentId: 'agt-1',
    externalExecutionId: 'ext-1',
    processId: 1,
    status: 'running',
    workingDirectory: '/tmp/scratch/exe-1',
    startedAt: '2026-10-30T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    capabilities: CAPABILITIES,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  }
}

function outputEvent(
  executionId: string,
  sequenceNo: number,
  content: string,
  logSequenceNo = sequenceNo,
): RuntimeEvent {
  return {
    eventId: `evt-${executionId}-${sequenceNo}`,
    protocolVersion: '1',
    eventType: 'execution.output',
    occurredAt: '2026-10-30T00:00:01.000Z',
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: {
      executionId,
      sequenceNo,
      stream: 'stdout',
      content,
      timestamp: '2026-10-30T00:00:01.000Z',
      logSequenceNo,
    },
    correlationId: executionId,
  }
}

function stateEvent(executionId: string, status: string): RuntimeEvent {
  return {
    eventId: `evt-state-${executionId}-${status}`,
    protocolVersion: '1',
    eventType: 'execution.state',
    occurredAt: '2026-10-30T00:00:02.000Z',
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: {
      executionId,
      sequenceNo: 2,
      status,
      previousStatus: 'running',
      timestamp: '2026-10-30T00:00:02.000Z',
    },
    correlationId: executionId,
  }
}

function exitedEvent(executionId: string, exitCode: number | null, reason: string): RuntimeEvent {
  return {
    eventId: `evt-exit-${executionId}`,
    protocolVersion: '1',
    eventType: 'execution.exited',
    occurredAt: '2026-10-30T00:00:03.000Z',
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: {
      executionId,
      sequenceNo: 3,
      exitCode,
      signal: reason === 'crashed' ? 'SIGKILL' : null,
      reason,
      timestamp: '2026-10-30T00:00:03.000Z',
    },
    correlationId: executionId,
  }
}

function log(sequenceNo: number, content: string): ExecutionLog {
  return {
    id: `log-${sequenceNo}`,
    executionId: 'exe-1',
    sequenceNo,
    stream: 'stdout',
    content,
    timestamp: '2026-10-30T00:00:00.000Z',
  }
}

describe('consoleReducer', () => {
  it('loads executions and selects the first one', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution({ id: 'exe-1' }), execution({ id: 'exe-2' })],
    })
    expect(state.selectedId).toBe('exe-1')
    expect(state.executions).toHaveLength(2)
  })

  it('keeps the current selection when it still exists', () => {
    const first = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution({ id: 'exe-1' }), execution({ id: 'exe-2' })],
    })
    const selected = consoleReducer(first, { type: 'select', executionId: 'exe-2' })
    const reloaded = consoleReducer(selected, {
      type: 'executionsLoaded',
      executions: [execution({ id: 'exe-1' }), execution({ id: 'exe-2' })],
    })
    expect(reloaded.selectedId).toBe('exe-2')
  })

  it('upserts executions without duplicating', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution()],
    })
    const updated = consoleReducer(state, {
      type: 'executionUpserted',
      execution: execution({ status: 'succeeded', exitCode: 0 }),
    })
    expect(updated.executions).toHaveLength(1)
    expect(updated.executions[0]).toMatchObject({ status: 'succeeded', exitCode: 0 })
  })

  it('appends output logs and deduplicates by log sequence number', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution()],
    })
    const once = consoleReducer(state, { type: 'event', event: outputEvent('exe-1', 1, 'hello') })
    const twice = consoleReducer(once, { type: 'event', event: outputEvent('exe-1', 1, 'hello') })
    expect(twice.logs['exe-1']).toHaveLength(1)
    expect(twice.logs['exe-1']?.[0]?.content).toBe('hello')

    const next = consoleReducer(twice, { type: 'event', event: outputEvent('exe-1', 2, 'world') })
    expect(next.logs['exe-1']?.map((entry) => entry.content)).toEqual(['hello', 'world'])
  })

  it('sorts loaded logs by sequence number', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'logsLoaded',
      executionId: 'exe-1',
      logs: [log(2, 'b'), log(1, 'a')],
    })
    expect(state.logs['exe-1']?.map((entry) => entry.content)).toEqual(['a', 'b'])
  })

  it('updates status from state events', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution()],
    })
    const running = consoleReducer(state, {
      type: 'event',
      event: stateEvent('exe-1', 'running'),
    })
    expect(running.executions[0]?.status).toBe('running')
  })

  it('derives terminal status from exited events', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution()],
    })
    const succeeded = consoleReducer(state, {
      type: 'event',
      event: exitedEvent('exe-1', 0, 'exited'),
    })
    expect(succeeded.executions[0]).toMatchObject({ status: 'succeeded', exitCode: 0 })

    const crashed = consoleReducer(state, {
      type: 'event',
      event: exitedEvent('exe-1', null, 'crashed'),
    })
    expect(crashed.executions[0]?.status).toBe('crashed')
  })

  it('ignores malformed payloads and unknown executions', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'executionsLoaded',
      executions: [execution()],
    })
    const malformed = consoleReducer(state, {
      type: 'event',
      event: { ...outputEvent('exe-1', 1, 'x'), payload: { nope: true } },
    })
    expect(malformed).toBe(state)

    const unknown = consoleReducer(state, {
      type: 'event',
      event: stateEvent('exe-other', 'succeeded'),
    })
    expect(unknown.executions[0]?.status).toBe('running')
  })
})

describe('terminalExecutionId', () => {
  it('reports terminal ids for exited and terminal state events', () => {
    expect(terminalExecutionId(exitedEvent('exe-1', 0, 'exited'))).toBe('exe-1')
    expect(terminalExecutionId(stateEvent('exe-1', 'failed'))).toBe('exe-1')
    expect(terminalExecutionId(stateEvent('exe-1', 'running'))).toBeNull()
    expect(terminalExecutionId(outputEvent('exe-1', 1, 'x'))).toBeNull()
  })

  it('classifies terminal statuses', () => {
    expect(isTerminalStatus('succeeded')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
  })
})
