import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeEvent } from '@agentra/runtime-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCodeProvider } from './claude-code/provider'
import { FAKE_CLAUDE_PATH } from './test-fixtures'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-provider-'))
  tempDirs.push(dir)
  return dir
}

function newExecutionId(): string {
  return `exe-${crypto.randomUUID()}`
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Collected = {
  events: RuntimeEvent[]
  terminal: Promise<void>
}

/** start 之前订阅，确保不丢失 running/output/exited 事件。 */
function collect(provider: ClaudeCodeProvider, executionId: string): Collected {
  const events: RuntimeEvent[] = []
  let resolveTerminal!: () => void
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve
  })
  provider.subscribe(executionId, (event) => {
    events.push(event)
    if (
      event.type === 'state' &&
      ['succeeded', 'failed', 'cancelled', 'crashed'].includes(event.status)
    ) {
      resolveTerminal()
    }
  })
  return { events, terminal }
}

function withTimeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

function makeProvider(): ClaudeCodeProvider {
  return new ClaudeCodeProvider({ executablePath: FAKE_CLAUDE_PATH })
}

async function start(
  provider: ClaudeCodeProvider,
  executionId: string,
  prompt: string,
): Promise<void> {
  await provider.start({
    executionId,
    prompt,
    workingDirectory: tempDir(),
    sessionId: crypto.randomUUID(),
  })
}

describe('ClaudeCodeProvider with fake CLI', () => {
  it('runs a turn, captures stdout/structured output and exits 0', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'hello')
    await withTimeout(terminal)

    const stdout = events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event.type === 'output' ? event.content : ''))
    expect(stdout).toContain('echo:hello')
    expect(events.some((event) => event.type === 'output' && event.stream === 'structured')).toBe(
      true,
    )
    const exited = events.find((event) => event.type === 'exited')
    expect(exited).toMatchObject({ type: 'exited', exitCode: 0, reason: 'exited' })
    expect(events.some((event) => event.type === 'state' && event.status === 'running')).toBe(true)
    expect(events.some((event) => event.type === 'state' && event.status === 'succeeded')).toBe(
      true,
    )

    const status = await provider.getStatus(executionId)
    expect(status).toMatchObject({ status: 'succeeded', exitCode: 0 })
    expect(status.processId).toBeGreaterThan(0)
  })

  it('reports a result error with exit code 0 as failed before exited', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'FAIL this turn')
    await withTimeout(terminal)

    const failedIndex = events.findIndex(
      (event) => event.type === 'state' && event.status === 'failed',
    )
    const exitedIndex = events.findIndex((event) => event.type === 'exited')
    expect(failedIndex).toBeGreaterThanOrEqual(0)
    // 状态必须先于 exited，否则消费方会按 exitCode=0 误判成功并丢弃 failed。
    expect(exitedIndex).toBeGreaterThan(failedIndex)
    expect(events[exitedIndex]).toMatchObject({ type: 'exited', exitCode: 0 })
    expect((await provider.getStatus(executionId)).status).toBe('failed')
  })

  it('marks an execution crashed when the process is killed with SIGKILL', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'CRASH now')
    await withTimeout(terminal)

    const exited = events.find((event) => event.type === 'exited')
    expect(exited).toMatchObject({ type: 'exited', reason: 'crashed', signal: 'SIGKILL' })
    expect(events.some((event) => event.type === 'state' && event.status === 'crashed')).toBe(true)
    expect((await provider.getStatus(executionId)).status).toBe('crashed')
  })

  it('cancels a long-running execution', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'HANG')
    await provider.cancel(executionId)
    await withTimeout(terminal)

    expect(events.find((event) => event.type === 'exited')).toMatchObject({
      reason: 'cancelled',
    })
    expect((await provider.getStatus(executionId)).status).toBe('cancelled')
  })

  it('interrupts natively via control_request and finishes as cancelled', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'HANG')
    const result = await provider.interrupt(executionId)
    expect(result.interrupted).toBe(true)
    await withTimeout(terminal)

    expect(
      events.some(
        (event) =>
          event.type === 'output' &&
          event.stream === 'structured' &&
          event.content.includes('interrupt_received'),
      ),
    ).toBe(true)
    expect((await provider.getStatus(executionId)).status).toBe('cancelled')
  })

  it('sends a follow-up message while the turn is running', async () => {
    const provider = makeProvider()
    const executionId = newExecutionId()
    const { events, terminal } = collect(provider, executionId)

    await start(provider, executionId, 'HANG')
    await provider.sendMessage(executionId, { role: 'user', content: 'follow up' })
    await withTimeout(terminal)

    const stdout = events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event.type === 'output' ? event.content : ''))
    expect(stdout).toContain('echo:follow up')
    expect((await provider.getStatus(executionId)).status).toBe('succeeded')
  })

  it('rejects unknown executions and missing executables with typed errors', async () => {
    const provider = makeProvider()
    await expect(provider.getStatus('exe-missing')).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    })

    const unavailable = new ClaudeCodeProvider({ executablePath: null })
    await expect(
      unavailable.start({
        executionId: newExecutionId(),
        prompt: 'hello',
        workingDirectory: tempDir(),
        sessionId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' })
  })
})
