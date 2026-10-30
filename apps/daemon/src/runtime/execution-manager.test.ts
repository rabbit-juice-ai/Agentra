import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type DaemonExecutionStartParams,
  type RuntimeEvent,
  RuntimeEvent as RuntimeEventSchema,
} from '@agentra/protocol'
import { ClaudeCodeProvider, FAKE_CLAUDE_PATH } from '@agentra/runtime-cli'
import { ProviderCapabilities } from '@agentra/runtime-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimeEventHub } from './event-hub'
import { ExecutionManager } from './execution-manager'

const dirs: string[] = []
let scratchRoot: string
let hub: RuntimeEventHub
let manager: ExecutionManager
let provider: ClaudeCodeProvider
let events: RuntimeEvent[]

const CAPABILITIES = ProviderCapabilities.parse({
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'native',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
})

function newExecutionId(): string {
  return `exe-${crypto.randomUUID()}`
}

function startParams(
  overrides: Partial<DaemonExecutionStartParams> = {},
): DaemonExecutionStartParams {
  return {
    executionId: newExecutionId(),
    providerId: 'claude-code',
    executablePath: FAKE_CLAUDE_PATH,
    capabilities: CAPABILITIES,
    prompt: 'hello',
    workingDirectory: path.join(scratchRoot, overrides.executionId ?? 'placeholder'),
    sessionId: crypto.randomUUID(),
    ...overrides,
  } as DaemonExecutionStartParams
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error('waitFor timeout'))
      }
    }, 25)
  })
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-daemon-runtime-'))
  dirs.push(dir)
  scratchRoot = path.join(dir, 'scratch')
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 })
  provider = new ClaudeCodeProvider({ executablePath: FAKE_CLAUDE_PATH })
  hub = new RuntimeEventHub()
  manager = new ExecutionManager({
    scratchRoot,
    providers: new Map([['claude-code', provider]]),
    hub,
  })
  events = []
  hub.subscribe((event) => events.push(event))
})

afterEach(async () => {
  await manager.shutdown()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ExecutionManager', () => {
  it('runs an execution and broadcasts protocol event envelopes', async () => {
    const executionId = newExecutionId()
    const workingDirectory = path.join(scratchRoot, executionId)
    const handle = await manager.start(
      startParams({ executionId, workingDirectory, prompt: 'hello' }),
    )
    expect(handle.processId).toBeGreaterThan(0)

    await waitFor(() => manager.listActive().length === 0)

    const types = events.map((event) => event.eventType)
    expect(types).toContain('execution.output')
    expect(types).toContain('execution.state')
    expect(types).toContain('execution.exited')

    for (const event of events) {
      // 每个事件都必须是合法的协议层信封。
      expect(RuntimeEventSchema.safeParse(event).success).toBe(true)
      expect(event.aggregateType).toBe('execution')
      expect(event.aggregateId).toBe(executionId)
      expect(event.correlationId).toBe(executionId)
      expect(event.eventId.length).toBeGreaterThanOrEqual(8)
    }
    const sequences = events.map((event) => (event.payload as { sequenceNo: number }).sequenceNo)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)

    const stdout = events
      .filter(
        (event) =>
          event.eventType === 'execution.output' &&
          (event.payload as { stream: string }).stream === 'stdout',
      )
      .map((event) => (event.payload as { content: string }).content)
    expect(stdout).toContain('echo:hello')

    const exited = events.find((event) => event.eventType === 'execution.exited')
    expect(exited?.payload).toMatchObject({ exitCode: 0, reason: 'exited' })

    const status = await manager.status(executionId)
    expect(status).toMatchObject({ status: 'succeeded', exitCode: 0 })
  })

  it('detects a SIGKILLed process and reports crashed', async () => {
    const executionId = newExecutionId()
    await manager.start(
      startParams({
        executionId,
        workingDirectory: path.join(scratchRoot, executionId),
        prompt: 'CRASH',
      }),
    )
    await waitFor(() => manager.listActive().length === 0)

    const exited = events.find((event) => event.eventType === 'execution.exited')
    expect(exited?.payload).toMatchObject({ reason: 'crashed', signal: 'SIGKILL' })
    expect((await manager.status(executionId)).status).toBe('crashed')
  })

  it('rejects interrupt when the capability snapshot declares unsupported and keeps state', async () => {
    const executionId = newExecutionId()
    await manager.start(
      startParams({
        executionId,
        workingDirectory: path.join(scratchRoot, executionId),
        prompt: 'HANG',
        capabilities: { ...CAPABILITIES, interrupt: 'unsupported' },
      }),
    )
    expect((await manager.status(executionId)).status).toBe('running')

    await expect(manager.interrupt(executionId)).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    })
    expect((await manager.status(executionId)).status).toBe('running')

    await manager.cancel(executionId)
    await waitFor(() => manager.listActive().length === 0)
    expect((await manager.status(executionId)).status).toBe('cancelled')
  })

  it('interrupts a native-capability execution', async () => {
    const executionId = newExecutionId()
    await manager.start(
      startParams({
        executionId,
        workingDirectory: path.join(scratchRoot, executionId),
        prompt: 'HANG',
      }),
    )
    await expect(manager.interrupt(executionId)).resolves.toEqual({ interrupted: true })
    await waitFor(() => manager.listActive().length === 0)
    expect((await manager.status(executionId)).status).toBe('cancelled')
  })

  it('rejects a working directory outside the scratch root', async () => {
    const executionId = newExecutionId()
    await expect(
      manager.start(startParams({ executionId, workingDirectory: '/tmp' })),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(manager.listActive()).toEqual([])
  })

  it('rejects unknown providers and executions with typed codes', async () => {
    await expect(
      manager.start(startParams({ providerId: 'no-such-provider' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    await expect(manager.status('exe-unknown')).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    })
    await expect(manager.interrupt('exe-unknown')).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    })
    await expect(manager.cancel('exe-unknown')).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    })
  })

  it('discovers the provider through the manager', async () => {
    const infos = await manager.discover()
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      providerId: 'claude-code',
      executablePath: path.resolve(FAKE_CLAUDE_PATH),
    })
  })
})
