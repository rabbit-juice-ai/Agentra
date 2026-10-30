import { describe, expect, it } from 'vitest'
import {
  AgentCreateParams,
  AgentProfile,
  DaemonExecutionStartParams,
  EventFrame,
  Execution,
  ExecutionStartParams,
  PROTOCOL_VERSION,
  RpcMethodError,
  RpcResponse,
  RuntimeEvent,
  rpcFailure,
} from './index'

const capabilities = {
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

const agent = {
  id: 'agt-1',
  name: 'Frontend',
  role: 'engineer',
  description: '',
  systemPrompt: '',
  skills: ['react'],
  toolPermissions: { version: 1, allow: ['Read'], deny: [] },
  defaultProviderId: null,
  maxConcurrency: 1,
  status: 'active',
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  archivedAt: null,
} as const

const execution = {
  id: 'exe-1',
  sessionId: 'ses-1',
  providerId: 'claude-code',
  agentId: 'agt-1',
  externalExecutionId: '11111111-2222-4333-8444-555555555555',
  processId: 4242,
  status: 'running',
  workingDirectory: '/tmp/scratch/exe-1',
  startedAt: '2026-10-30T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  capabilities,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
} as const

describe('phase 1 error codes', () => {
  it('accepts the CLI failure codes required by acceptance item 6', () => {
    for (const code of ['CLI_UNAVAILABLE', 'CLI_NOT_AUTHENTICATED'] as const) {
      const response = rpcFailure('req-12345678', code, 'hint')
      expect(RpcResponse.parse(response)).toEqual(response)
    }
  })

  it('accepts CAPABILITY_UNSUPPORTED for unsupported provider capabilities', () => {
    expect(rpcFailure('req-12345678', 'CAPABILITY_UNSUPPORTED', 'no interrupt').ok).toBe(false)
  })

  it('rejects an undefined error code', () => {
    expect(() => rpcFailure('req-12345678', 'NOPE' as never, 'x')).toThrow()
  })

  it('RpcMethodError carries a protocol code', () => {
    const error = new RpcMethodError('CLI_UNAVAILABLE', 'missing')
    expect(error.code).toBe('CLI_UNAVAILABLE')
    expect(error.message).toBe('missing')
  })
})

describe('DTO schemas', () => {
  it('parses an agent profile', () => {
    expect(AgentProfile.parse(agent)).toEqual(agent)
  })

  it('rejects an agent with an unknown status', () => {
    expect(AgentProfile.safeParse({ ...agent, status: 'deleted' }).success).toBe(false)
  })

  it('parses an execution with declared capabilities', () => {
    expect(Execution.parse(execution)).toEqual(execution)
  })

  it('rejects an execution with an unknown state', () => {
    expect(Execution.safeParse({ ...execution, status: 'paused' }).success).toBe(false)
  })
})

describe('event envelope', () => {
  const event = {
    eventId: 'evt-12345678',
    protocolVersion: PROTOCOL_VERSION,
    eventType: 'execution.output',
    occurredAt: '2026-10-30T00:00:00.000Z',
    aggregateType: 'execution',
    aggregateId: 'exe-1',
    payload: {
      executionId: 'exe-1',
      sequenceNo: 1,
      stream: 'stdout',
      content: 'hi',
      timestamp: 't',
    },
    correlationId: 'corr-1',
  }

  it('accepts a protocol-layer event with the ARCHITECTURE §7 fields', () => {
    expect(RuntimeEvent.parse(event)).toEqual(event)
  })

  it('requires eventId, occurredAt and aggregate identity', () => {
    for (const key of ['eventId', 'occurredAt', 'aggregateType', 'aggregateId', 'payload']) {
      const copy: Record<string, unknown> = { ...event }
      delete copy[key]
      expect(RuntimeEvent.safeParse(copy).success).toBe(false)
    }
  })

  it('rejects unknown event types', () => {
    expect(RuntimeEvent.safeParse({ ...event, eventType: 'execution.exploded' }).success).toBe(
      false,
    )
  })

  it('wraps events in a distinguishable push frame', () => {
    expect(EventFrame.parse({ type: 'event', event })).toEqual({ type: 'event', event })
    expect(EventFrame.safeParse({ type: 'response', event }).success).toBe(false)
  })
})

describe('method params', () => {
  it('requires a prompt for execution.start', () => {
    expect(ExecutionStartParams.safeParse({ agentId: 'agt-1', prompt: 'hi' }).success).toBe(true)
    expect(ExecutionStartParams.safeParse({ agentId: 'agt-1' }).success).toBe(false)
    expect(ExecutionStartParams.safeParse({ agentId: 'agt-1', prompt: '' }).success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(
      ExecutionStartParams.safeParse({ agentId: 'agt-1', prompt: 'hi', shell: 'rm -rf /' }).success,
    ).toBe(false)
  })

  it('validates tool permissions (U3)', () => {
    const base = { name: 'A', role: 'engineer' }
    const ok = { version: 1, allow: ['Read', 'Edit'], deny: ['Bash'] }
    expect(AgentCreateParams.safeParse({ ...base, toolPermissions: ok }).success).toBe(true)

    // allow 与 deny 冲突：写入时拒绝
    const conflict = { version: 1, allow: ['Bash'], deny: ['Bash'] }
    expect(AgentCreateParams.safeParse({ ...base, toolPermissions: conflict }).success).toBe(false)

    // 单项超过 200 字符
    const longName = { version: 1, allow: ['x'.repeat(201)], deny: [] }
    expect(AgentCreateParams.safeParse({ ...base, toolPermissions: longName }).success).toBe(false)

    // 单清单超过 100 项
    const tooMany = {
      version: 1,
      allow: Array.from({ length: 101 }, (_, i) => `tool-${i}`),
      deny: [],
    }
    expect(AgentCreateParams.safeParse({ ...base, toolPermissions: tooMany }).success).toBe(false)

    // 未知版本
    expect(
      AgentCreateParams.safeParse({ ...base, toolPermissions: { version: 2, allow: [], deny: [] } })
        .success,
    ).toBe(false)
  })

  it('validates agent creation input', () => {
    expect(AgentCreateParams.safeParse({ name: 'A', role: 'engineer' }).success).toBe(true)
    expect(AgentCreateParams.safeParse({ name: '', role: 'engineer' }).success).toBe(false)
    expect(AgentCreateParams.safeParse({ name: 'A', role: 'r', maxConcurrency: 0 }).success).toBe(
      false,
    )
  })

  it('requires all nine capabilities on daemon start', () => {
    const base = {
      executionId: 'exe-1',
      providerId: 'claude-code',
      executablePath: '/usr/local/bin/claude',
      capabilities,
      prompt: 'hi',
      workingDirectory: '/tmp/x',
      sessionId: '11111111-2222-4333-8444-555555555555',
    }
    expect(DaemonExecutionStartParams.safeParse(base).success).toBe(true)
    const { checkpoint: _omitted, ...partial } = capabilities
    expect(DaemonExecutionStartParams.safeParse({ ...base, capabilities: partial }).success).toBe(
      false,
    )
  })
})
