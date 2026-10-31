import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type DaemonExecutionStartParams,
  type DaemonExecutionStartResult,
  type DaemonExecutionStatusResult,
  type ExecutionState,
  PROTOCOL_VERSION,
  type RuntimeEvent,
  type RuntimeInfo,
} from '@agentra/protocol'
import { buildClaudeArgs, FAKE_CLAUDE_PATH } from '@agentra/runtime-cli'
import { ProviderCapabilities } from '@agentra/runtime-sdk'
import { newId } from '@agentra/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../daemon/daemon-client'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { AgentService } from './agent-service'
import { CoreEventHub } from './event-hub'
import { ExecutionService } from './execution-service'
import { ProviderRegistry } from './provider-registry'
import { WorkService } from './work-service'
import { WorkdirLockService } from './workdir-lock-service'
import { WorktreeService } from './worktree-service'

const NOW = '2026-10-30T00:00:00.000Z'

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

class FakeRuntimeClient implements RuntimeClient {
  readonly starts: DaemonExecutionStartParams[] = []
  readonly messages: { executionId: string; message: string }[] = []
  readonly interrupts: string[] = []
  readonly cancels: string[] = []
  active: string[] = []
  startError: Error | null = null
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  async discover(): Promise<RuntimeInfo[]> {
    return [
      {
        providerId: 'claude-code',
        providerType: 'cli',
        providerName: 'Claude Code',
        executablePath: FAKE_CLAUDE_PATH,
        version: '9.9.9',
        capabilities: CAPABILITIES,
        healthStatus: 'healthy',
        healthDetail: '',
        authMethod: 'fake',
        discoveredAt: NOW,
      },
    ]
  }

  async start(params: DaemonExecutionStartParams): Promise<DaemonExecutionStartResult> {
    if (this.startError) throw this.startError
    this.starts.push(params)
    this.active.push(params.executionId)
    return { processId: 4242, startedAt: NOW }
  }

  async sendMessage(executionId: string, message: string): Promise<void> {
    this.messages.push({ executionId, message })
  }

  async interrupt(executionId: string): Promise<{ interrupted: boolean }> {
    this.interrupts.push(executionId)
    return { interrupted: true }
  }

  async cancel(executionId: string): Promise<void> {
    this.cancels.push(executionId)
    this.active = this.active.filter((id) => id !== executionId)
  }

  async status(executionId: string): Promise<DaemonExecutionStatusResult> {
    return {
      executionId,
      status: 'running',
      processId: 4242,
      exitCode: null,
      startedAt: NOW,
      endedAt: null,
    }
  }

  async listActive(): Promise<string[]> {
    return [...this.active]
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.listeners.clear()
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function outputEvent(executionId: string, content: string, sequenceNo = 1): RuntimeEvent {
  return {
    eventId: newId('evt'),
    protocolVersion: PROTOCOL_VERSION,
    eventType: 'execution.output',
    occurredAt: NOW,
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: { executionId, sequenceNo, stream: 'stdout', content, timestamp: NOW },
    correlationId: executionId,
  }
}

function stateEvent(
  executionId: string,
  status: ExecutionState,
  previousStatus: ExecutionState | null,
  sequenceNo = 2,
): RuntimeEvent {
  return {
    eventId: newId('evt'),
    protocolVersion: PROTOCOL_VERSION,
    eventType: 'execution.state',
    occurredAt: NOW,
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: { executionId, sequenceNo, status, previousStatus, timestamp: NOW },
    correlationId: executionId,
  }
}

function exitedEvent(
  executionId: string,
  patch: {
    exitCode: number | null
    signal: string | null
    reason: 'exited' | 'crashed' | 'cancelled'
  },
  sequenceNo = 3,
): RuntimeEvent {
  return {
    eventId: newId('evt'),
    protocolVersion: PROTOCOL_VERSION,
    eventType: 'execution.exited',
    occurredAt: NOW,
    aggregateType: 'execution',
    aggregateId: executionId,
    payload: { executionId, sequenceNo, ...patch, timestamp: NOW },
    correlationId: executionId,
  }
}

type Harness = {
  db: Database
  dir: string
  agents: AgentService
  providers: ProviderRepository
  executions: ExecutionService
  runtime: FakeRuntimeClient
  hub: CoreEventHub
  logs: ExecutionLogRepository
  repository: ExecutionRepository
  agentId: string
  works: WorkService
  worktrees: WorktreeService
  locks: WorkdirLockService
}

const dirs: string[] = []

async function harness(
  options: {
    health?: 'healthy' | 'unavailable' | 'unauthenticated'
    executablePath?: string | null
    capabilities?: typeof CAPABILITIES
  } = {},
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-exec-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)

  const providerRepository = new ProviderRepository(db)
  const workRepository = new WorkRepository(db)
  const teamRepository = new TeamRepository(db)
  const auditRepository = new AuditRepository(db)
  const agentRepository = new AgentRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const logRepository = new ExecutionLogRepository(db)
  const runtime = new FakeRuntimeClient()
  const hub = new CoreEventHub()

  const [info] = await runtime.discover()
  if (!info) throw new Error('fake runtime returned no provider')
  providerRepository.upsertDiscovered(
    {
      ...info,
      healthStatus: options.health ?? 'healthy',
      executablePath:
        options.executablePath === undefined ? FAKE_CLAUDE_PATH : options.executablePath,
      capabilities: options.capabilities ?? CAPABILITIES,
    },
    NOW,
  )

  const registry = new ProviderRegistry(providerRepository, runtime)
  const worktrees = new WorktreeService(db, workRepository, path.join(dir, 'worktrees'), () => NOW)
  const locks = new WorkdirLockService(db, () => NOW)
  const works = new WorkService(db, workRepository, teamRepository, auditRepository, () => NOW)
  const agents = new AgentService(db, agentRepository, providerRepository, () => NOW)
  const agent = agents.create({
    name: 'Worker',
    role: 'engineer',
    toolPermissions: { version: 1, allow: ['Read'], deny: ['Bash'] },
  })
  const executions = new ExecutionService({
    db,
    runtime,
    registry,
    works: workRepository,
    worktrees,
    locks,
    agents: agentRepository,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: logRepository,
    hub,
    scratchRoot: path.join(dir, 'scratch'),
    now: () => NOW,
  })
  return {
    db,
    dir,
    agents,
    works,
    worktrees,
    locks,
    providers: providerRepository,
    executions,
    runtime,
    hub,
    logs: logRepository,
    repository: executionRepository,
    agentId: agent.id,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ExecutionService.start', () => {
  it('persists session, execution and system log, then marks running', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })

    expect(execution).toMatchObject({
      agentId: h.agentId,
      providerId: 'claude-code',
      status: 'running',
      processId: 4242,
    })
    expect(execution.workingDirectory).toBe(path.join(h.dir, 'scratch', execution.id))
    expect(fs.existsSync(execution.workingDirectory)).toBe(true)
    expect(h.runtime.starts).toHaveLength(1)
    expect(h.runtime.starts[0]).toMatchObject({ prompt: 'hello', permissionMode: 'dontAsk' })

    const logs = h.logs.list(execution.id)
    expect(logs.map((log) => log.stream)).toContain('system')
    expect(logs.some((log) => log.content.includes('execution.created'))).toBe(true)
  })

  it('rejects an unknown or inactive agent', async () => {
    const h = await harness()
    await expect(h.executions.start({ agentId: 'agt-missing', prompt: 'x' })).rejects.toMatchObject(
      {
        code: 'AGENT_NOT_FOUND',
      },
    )
    h.agents.archive(h.agentId)
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('rejects blank prompts', async () => {
    const h = await harness()
    await expect(h.executions.start({ agentId: h.agentId, prompt: '   ' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
    expect(h.executions.list()).toHaveLength(0)
  })

  it('returns CLI_UNAVAILABLE without creating an execution when the CLI is unavailable', async () => {
    const h = await harness({ health: 'unavailable' })
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'CLI_UNAVAILABLE',
    })
    expect(h.executions.list()).toHaveLength(0)
    expect(h.runtime.starts).toHaveLength(0)
  })

  it('returns CLI_NOT_AUTHENTICATED without creating an execution when not authenticated', async () => {
    const h = await harness({ health: 'unauthenticated' })
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'CLI_NOT_AUTHENTICATED',
    })
    expect(h.executions.list()).toHaveLength(0)
    expect(h.runtime.starts).toHaveLength(0)
  })

  it('returns CLI_UNAVAILABLE and downgrades health when the executable disappeared', async () => {
    const h = await harness({ executablePath: '/nonexistent/claude' })
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'CLI_UNAVAILABLE',
    })
    expect(h.executions.list()).toHaveLength(0)
    expect(h.providers.get('claude-code')?.healthStatus).toBe('unavailable')
  })

  it('marks the execution failed when the daemon rejects the start', async () => {
    const h = await harness()
    h.runtime.startError = new Error('spawn failed')
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toThrow(
      'spawn failed',
    )
    const [execution] = h.executions.list()
    expect(execution).toMatchObject({ status: 'failed' })
  })
})

describe('ExecutionService event handling', () => {
  it('persists output and broadcasts it to desktop subscribers', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    const received: RuntimeEvent[] = []
    h.hub.subscribe((event) => received.push(event))

    h.executions.handleRuntimeEvent(outputEvent(execution.id, 'OK'))
    const logs = h.logs.list(execution.id).filter((log) => log.stream === 'stdout')
    expect(logs).toHaveLength(1)
    expect(logs[0]?.content).toBe('OK')
    expect(received).toHaveLength(1)
  })

  it('deduplicates the same eventId (no duplicate logs)', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    const event = outputEvent(execution.id, 'OK')
    h.executions.handleRuntimeEvent(event)
    h.executions.handleRuntimeEvent(event)
    expect(h.logs.list(execution.id).filter((log) => log.stream === 'stdout')).toHaveLength(1)
  })

  it('records started → succeeded with exit code 0', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(stateEvent(execution.id, 'running', 'pending'))
    h.executions.handleRuntimeEvent(outputEvent(execution.id, 'OK'))
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )

    const stored = h.executions.get(execution.id)
    expect(stored).toMatchObject({ status: 'succeeded', exitCode: 0 })
    expect(stored.endedAt).not.toBeNull()
    const systemLogs = h.logs
      .list(execution.id)
      .filter((log) => log.stream === 'system')
      .map((log) => log.content)
    expect(systemLogs.some((content) => content.includes('execution.exited'))).toBe(true)
  })

  it('records crashed when the process dies from a signal', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: null, signal: 'SIGKILL', reason: 'crashed' }),
    )
    expect(h.executions.get(execution.id)).toMatchObject({ status: 'crashed', exitCode: null })
  })

  it('ignores duplicate terminal state events after exit', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    const logsBefore = h.logs.list(execution.id).length
    h.executions.handleRuntimeEvent(stateEvent(execution.id, 'succeeded', 'running'))
    expect(h.logs.list(execution.id)).toHaveLength(logsBefore)
    expect(h.executions.get(execution.id).status).toBe('succeeded')
  })

  it('does not let an exited event resurrect a cancelled execution', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await h.executions.cancel({ executionId: execution.id })
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    expect(h.executions.get(execution.id).status).toBe('cancelled')
  })
})

describe('ExecutionService lifecycle RPCs', () => {
  it('cancels a running execution and records the request', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    const cancelled = await h.executions.cancel({ executionId: execution.id })
    expect(cancelled.status).toBe('cancelled')
    expect(h.runtime.cancels).toContain(execution.id)
    expect(
      h.logs.list(execution.id).some((log) => log.content.includes('execution.cancel_requested')),
    ).toBe(true)
  })

  it('is idempotent when cancelling a terminal execution', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await h.executions.cancel({ executionId: execution.id })
    const again = await h.executions.cancel({ executionId: execution.id })
    expect(again.status).toBe('cancelled')
    expect(h.runtime.cancels).toHaveLength(1)
  })

  it('forwards interrupt for native capabilities', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await expect(h.executions.interrupt({ executionId: execution.id })).resolves.toEqual({
      interrupted: true,
    })
    expect(h.runtime.interrupts).toContain(execution.id)
    expect(h.executions.get(execution.id).status).toBe('running')
  })

  it('rejects interrupt for unsupported capabilities without changing state', async () => {
    const h = await harness({
      capabilities: { ...CAPABILITIES, interrupt: 'unsupported' },
    })
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await expect(h.executions.interrupt({ executionId: execution.id })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    })
    expect(h.executions.get(execution.id).status).toBe('running')
    expect(h.runtime.interrupts).toHaveLength(0)
  })

  it('rejects sendMessage for unsupported streaming and forwards it otherwise', async () => {
    const h = await harness({ capabilities: { ...CAPABILITIES, streaming: 'unsupported' } })
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await expect(
      h.executions.sendMessage({ executionId: execution.id, message: 'more' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })

    const h2 = await harness()
    const execution2 = await h2.executions.start({ agentId: h2.agentId, prompt: 'hello' })
    await expect(
      h2.executions.sendMessage({ executionId: execution2.id, message: 'more' }),
    ).resolves.toEqual({ sent: true })
    expect(h2.runtime.messages).toEqual([{ executionId: execution2.id, message: 'more' }])
  })

  it('reports EXECUTION_NOT_FOUND for unknown executions', async () => {
    const h = await harness()
    expect(() => h.executions.get('exe-missing')).toThrow(
      expect.objectContaining({ code: 'EXECUTION_NOT_FOUND' }),
    )
    await expect(h.executions.cancel({ executionId: 'exe-missing' })).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    })
  })

  it('lists executions and returns logs after a sequence', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(outputEvent(execution.id, 'one', 1))
    h.executions.handleRuntimeEvent(outputEvent(execution.id, 'two', 2))
    expect(h.executions.list()).toHaveLength(1)
    const logs = h.executions.logsFor({ executionId: execution.id, afterSequence: 1 })
    expect(logs.every((log) => log.sequenceNo > 1)).toBe(true)
    expect(logs.some((log) => log.content === 'two')).toBe(true)
  })
})

describe('ExecutionService.reconcile', () => {
  it('marks executions the daemon no longer knows as crashed', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.runtime.active = []
    await h.executions.reconcile()
    const stored = h.executions.get(execution.id)
    expect(stored.status).toBe('crashed')
    expect(h.logs.list(execution.id).some((log) => log.content.includes('reconciliation'))).toBe(
      true,
    )
  })

  it('keeps executions the daemon still tracks as running', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    await h.executions.reconcile()
    expect(h.executions.get(execution.id).status).toBe('running')
  })
})

describe('AgentService', () => {
  it('creates, updates and archives agents with provider validation', async () => {
    const h = await harness()
    expect(() => h.agents.create({ name: 'X', role: 'r', defaultProviderId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_NOT_FOUND' }),
    )

    const created = h.agents.create({
      name: '  Backend  ',
      role: 'engineer',
      defaultProviderId: 'claude-code',
    })
    expect(created.name).toBe('Backend')
    expect(created.defaultProviderId).toBe('claude-code')

    const updated = h.agents.update({ id: created.id, maxConcurrency: 2, skills: ['go'] })
    expect(updated).toMatchObject({ maxConcurrency: 2, skills: ['go'], name: 'Backend' })

    const archived = h.agents.archive(created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBe(NOW)
    expect(h.agents.list().map((agent) => agent.id)).not.toContain(created.id)
    expect(h.agents.list(true).map((agent) => agent.id)).toContain(created.id)
    expect(h.agents.archive(created.id).status).toBe('archived')
  })
})

describe('工具权限强制（U3）', () => {
  it('拒绝 allow 为空的 Agent，且不创建 Execution', async () => {
    const h = await harness()
    const unconfigured = h.agents.create({ name: 'NoTools', role: 'engineer' })
    expect(unconfigured.toolPermissions).toEqual({ version: 1, allow: [], deny: [] })

    await expect(
      h.executions.start({ agentId: unconfigured.id, prompt: 'hello' }),
    ).rejects.toMatchObject({ name: 'RpcMethodError', code: 'AGENT_TOOLS_NOT_CONFIGURED' })

    // 拦截发生在创建之前：没有 Execution 落库，也没有向 Daemon 发起启动
    expect(h.repository.list(100).some((item) => item.agentId === unconfigured.id)).toBe(false)
    expect(h.runtime.starts).toHaveLength(0)
  })

  it('拒绝迁移前遗留、未配置工具的 Agent（v2 默认值为空 allow，不回填）', async () => {
    const h = await harness()
    // 模拟 v2 之前写入的旧行：INSERT 不显式给 tool_permissions_json，由列默认值兜底
    h.db
      .prepare(
        `INSERT INTO agent_profiles (
          id, name, role, description, system_prompt, skills_json,
          default_provider_id, max_concurrency, status, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('agt-legacy', 'Legacy', 'engineer', '', '', '[]', null, 1, 'active', NOW, NOW, null)

    expect(h.agents.get('agt-legacy').toolPermissions).toEqual({
      version: 1,
      allow: [],
      deny: [],
    })
    await expect(
      h.executions.start({ agentId: 'agt-legacy', prompt: 'hello' }),
    ).rejects.toMatchObject({ code: 'AGENT_TOOLS_NOT_CONFIGURED' })
  })

  it('正常授权放行：保存 → 读取 → Core → Daemon → CLI 参数五段一致', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })

    // 读取回来的是落库值
    expect(h.agents.get(h.agentId).toolPermissions).toEqual({
      version: 1,
      allow: ['Read'],
      deny: ['Bash'],
    })
    // Core → Daemon
    const start = h.runtime.starts[0]
    expect(start).toMatchObject({ allowedTools: ['Read'], disallowedTools: ['Bash'] })
    // Daemon → CLI 参数
    const args = buildClaudeArgs({
      executionId: execution.id,
      prompt: 'hello',
      workingDirectory: execution.workingDirectory,
      sessionId: 'ses-1',
      allowedTools: start?.allowedTools,
      disallowedTools: start?.disallowedTools,
    })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read')
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash')

    // 审计：execution_logs 里有一条 tool_policy 记录
    const policyLog = h.logs
      .list(execution.id)
      .find((log) => log.content.includes('execution.tool_policy'))
    expect(policyLog).toBeDefined()
    expect(policyLog?.content).toContain('Read')
  })

  it('保存时 trim 生效、空白项被过滤、顺序保留（不因空白产生拒绝）', async () => {
    const h = await harness()
    const created = h.agents.create({
      name: 'Trim',
      role: 'engineer',
      toolPermissions: { version: 1, allow: [' Read ', 'Edit', ' '], deny: [' Bash '] },
    })
    expect(h.agents.get(created.id).toolPermissions).toEqual({
      version: 1,
      allow: ['Read', 'Edit'],
      deny: ['Bash'],
    })
  })

  it('保存时拒绝重复项，比较前先 trim（A-23 ②）', async () => {
    const h = await harness()
    for (const allow of [
      ['Read', 'Read'],
      [' Read', 'Read'],
      ['Read', 'Read '],
    ]) {
      expect(() =>
        h.agents.create({
          name: 'Dup',
          role: 'engineer',
          toolPermissions: { version: 1, allow, deny: [] },
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    }
    expect(h.agents.list().some((agent) => agent.name === 'Dup')).toBe(false)
  })

  it('保存时拒绝 trim 后才冲突的 allow/deny（同一工具不同空白）', async () => {
    const h = await harness()
    expect(() =>
      h.agents.create({
        name: 'Conflict',
        role: 'engineer',
        toolPermissions: { version: 1, allow: ['Read'], deny: [' Read '] },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  })
})

describe('阶段 2 B3：工作目录锁与 Worktree 隔离', () => {
  it('WORKDIR_LOCKED：两个 Work 指向同一非 Worktree 目录时第二个启动被拒且不创建 Execution', async () => {
    const h = await harness()
    const shared = path.join(h.dir, 'shared-workdir')

    const workA = h.works.create({ name: 'A', rootPath: shared })
    h.works.activate(workA.id)
    const workB = h.works.create({ name: 'B', rootPath: shared })
    h.works.activate(workB.id)

    const first = await h.executions.start({
      agentId: h.agentId,
      prompt: 'first',
      workId: workA.id,
    })
    expect(first.workingDirectory).toBe(shared)
    expect(h.locks.get(shared)?.executionId).toBe(first.id)

    const before = h.repository.list(100).length
    await expect(
      h.executions.start({ agentId: h.agentId, prompt: 'second', workId: workB.id }),
    ).rejects.toMatchObject({ code: 'WORKDIR_LOCKED' })
    expect(h.repository.list(100).length).toBe(before)
    expect(h.runtime.starts).toHaveLength(1)
  })

  it('Worktree 隔离时不阻塞：两个 Work 各自的 worktree 目录不同，可以同时启动', async () => {
    const h = await harness()
    // 两个 Work 指向同一个仓库，但各自用不同的 worktree 目录
    const repo = path.join(h.dir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    const workA = h.works.create({ name: 'A', rootPath: repo, repositoryPath: repo })
    h.works.activate(workA.id)
    const workB = h.works.create({ name: 'B', rootPath: repo, repositoryPath: repo })
    h.works.activate(workB.id)

    const wtA = h.worktrees.create({ workId: workA.id, branchName: 'agentra/a' })
    const wtB = h.worktrees.create({ workId: workB.id, branchName: 'agentra/b' })
    expect(wtA.worktreePath).not.toBe(wtB.worktreePath)

    const exA = await h.executions.start({
      agentId: h.agentId,
      prompt: 'a',
      workId: workA.id,
      worktreeId: wtA.id,
    })
    const exB = await h.executions.start({
      agentId: h.agentId,
      prompt: 'b',
      workId: workB.id,
      worktreeId: wtB.id,
    })
    expect(exA.workingDirectory).toBe(path.resolve(wtA.worktreePath))
    expect(exB.workingDirectory).toBe(path.resolve(wtB.worktreePath))
    expect(exA.workingDirectory).not.toBe(exB.workingDirectory)
  })

  it('执行终结后释放目录锁，同一目录可以再次启动', async () => {
    const h = await harness()
    const shared = path.join(h.dir, 'shared-2')
    const work = h.works.create({ name: 'W', rootPath: shared })
    h.works.activate(work.id)

    const first = await h.executions.start({ agentId: h.agentId, prompt: 'x', workId: work.id })
    expect(h.locks.get(shared)?.executionId).toBe(first.id)

    // 直接喂事件：本 harness 没有把 runtime 订阅到 service（生产由 index.ts 订阅）
    h.executions.handleRuntimeEvent({
      eventId: newId('evt'),
      protocolVersion: PROTOCOL_VERSION,
      eventType: 'execution.exited',
      occurredAt: NOW,
      aggregateType: 'execution',
      aggregateId: first.id,
      payload: {
        executionId: first.id,
        sequenceNo: 9,
        exitCode: 0,
        signal: null,
        reason: 'exited',
        timestamp: NOW,
      },
      correlationId: first.id,
    })

    expect(h.locks.get(shared)).toBeNull()
    const second = await h.executions.start({ agentId: h.agentId, prompt: 'y', workId: work.id })
    expect(second.id).not.toBe(first.id)
  })
})
