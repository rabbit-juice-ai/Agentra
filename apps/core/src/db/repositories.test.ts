import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile, Execution, RuntimeInfo } from '@agentra/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase, transaction } from './database'
import { migrate } from './migrations'
import { AgentRepository } from './repositories/agent-repository'
import { ExecutionLogRepository } from './repositories/execution-log-repository'
import { ExecutionRepository } from './repositories/execution-repository'
import { ProviderRepository } from './repositories/provider-repository'
import { SessionRepository } from './repositories/session-repository'

const dirs: string[] = []
let db: Database
let agents: AgentRepository
let providers: ProviderRepository
let sessions: SessionRepository
let executions: ExecutionRepository
let logs: ExecutionLogRepository

const NOW = '2026-10-30T00:00:00.000Z'
const LATER = '2026-10-30T00:01:00.000Z'

function capabilities() {
  return {
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
}

function providerInfo(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    providerId: 'claude-code',
    providerType: 'cli',
    providerName: 'Claude Code',
    executablePath: '/usr/local/bin/claude',
    version: '2.1.314',
    capabilities: capabilities(),
    healthStatus: 'healthy',
    healthDetail: '',
    authMethod: 'oauth_token',
    discoveredAt: NOW,
    ...overrides,
  }
}

function agentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agt-1',
    name: 'Frontend Engineer',
    role: 'engineer',
    description: 'builds UI',
    systemPrompt: 'be precise',
    skills: ['react', 'css'],
    toolPermissions: { version: 1, allow: ['Read', 'Edit'], deny: ['Bash'] },
    defaultProviderId: null,
    maxConcurrency: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  }
}

function executionRecord(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'exe-11111111-2222-4333-8444-555555555555',
    sessionId: 'ses-1',
    providerId: 'claude-code',
    agentId: 'agt-1',
    externalExecutionId: '11111111-2222-4333-8444-555555555555',
    processId: null,
    status: 'pending',
    workingDirectory: '/tmp/agentra/scratch/exe-1',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    capabilities: capabilities(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-repo-'))
  dirs.push(dir)
  db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  agents = new AgentRepository(db)
  providers = new ProviderRepository(db)
  sessions = new SessionRepository(db)
  executions = new ExecutionRepository(db)
  logs = new ExecutionLogRepository(db)
})

afterEach(() => {
  db.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function seedProvider(): void {
  providers.upsertDiscovered(providerInfo(), NOW)
}

describe('ProviderRepository', () => {
  it('upserts discovery results and updates health without losing created_at', () => {
    seedProvider()
    const first = providers.get('claude-code')
    expect(first).toMatchObject({
      providerName: 'Claude Code',
      executablePath: '/usr/local/bin/claude',
      version: '2.1.314',
      healthStatus: 'healthy',
      capabilities: capabilities(),
      createdAt: NOW,
    })

    providers.upsertDiscovered(
      providerInfo({ version: '2.1.315', healthStatus: 'unauthenticated', discoveredAt: LATER }),
      LATER,
    )
    const second = providers.get('claude-code')
    expect(second).toMatchObject({
      version: '2.1.315',
      healthStatus: 'unauthenticated',
      createdAt: NOW,
      updatedAt: LATER,
      lastDiscoveredAt: LATER,
    })
    expect(providers.list()).toHaveLength(1)
  })

  it('rejects corrupted capabilities JSON on read', () => {
    seedProvider()
    db.prepare('UPDATE runtime_providers SET capabilities_json = ? WHERE id = ?').run(
      '{"streaming":"native"}',
      'claude-code',
    )
    expect(() => providers.get('claude-code')).toThrow(/capabilities_json/)
  })
})

describe('AgentRepository', () => {
  it('creates, reads, updates and archives an agent', () => {
    seedProvider()
    agents.insert(agentProfile())
    expect(agents.get('agt-1')).toEqual(agentProfile())
    expect(agents.list()).toHaveLength(1)

    agents.update(agentProfile({ name: 'Senior FE', updatedAt: LATER, skills: ['react'] }))
    expect(agents.get('agt-1')).toMatchObject({ name: 'Senior FE', skills: ['react'] })

    agents.update(agentProfile({ status: 'archived', archivedAt: LATER, updatedAt: LATER }))
    expect(agents.list()).toHaveLength(0)
    expect(agents.list(true)).toHaveLength(1)
    expect(agents.get('agt-1')?.archivedAt).toBe(LATER)
  })

  it('keeps exactly one default binding per agent', () => {
    seedProvider()
    providers.upsertDiscovered(
      providerInfo({
        providerId: 'other-cli',
        providerName: 'Other',
        executablePath: '/bin/other',
      }),
      NOW,
    )
    agents.insert(agentProfile())

    transaction(db, () => {
      agents.syncDefaultBinding('agt-1', 'claude-code', NOW)
      db.prepare('UPDATE agent_profiles SET default_provider_id = ? WHERE id = ?').run(
        'claude-code',
        'agt-1',
      )
    })
    expect(agents.defaultProviderId('agt-1')).toBe('claude-code')

    transaction(db, () => {
      agents.syncDefaultBinding('agt-1', 'other-cli', LATER)
    })
    expect(agents.defaultProviderId('agt-1')).toBe('other-cli')
    const defaults = db
      .prepare(
        'SELECT COUNT(*) AS c FROM agent_runtime_bindings WHERE agent_id = ? AND is_default = 1',
      )
      .get('agt-1') as { c: number }
    expect(defaults.c).toBe(1)

    transaction(db, () => {
      agents.syncDefaultBinding('agt-1', null, LATER)
    })
    expect(agents.defaultProviderId('agt-1')).toBeNull()
  })

  it('rejects corrupted skills JSON on read', () => {
    seedProvider()
    agents.insert(agentProfile())
    db.prepare('UPDATE agent_profiles SET skills_json = ? WHERE id = ?').run('not json', 'agt-1')
    expect(() => agents.get('agt-1')).toThrow(/skills_json/)
  })

  it('rejects a duplicate agent id (primary key)', () => {
    seedProvider()
    agents.insert(agentProfile())
    expect(() => agents.insert(agentProfile())).toThrow()
  })

  it('rolls back inserts inside a failed transaction', () => {
    seedProvider()
    expect(() =>
      transaction(db, () => {
        agents.insert(agentProfile())
        throw new Error('abort')
      }),
    ).toThrow('abort')
    expect(agents.get('agt-1')).toBeNull()
  })
})

describe('Session and Execution repositories', () => {
  function seedSession(): void {
    seedProvider()
    agents.insert(agentProfile())
    sessions.create({
      id: 'ses-1',
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: '11111111-2222-4333-8444-555555555555',
      contextRef: 'agt-1',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })
  }

  it('creates an execution and derives agentId from the session context', () => {
    seedSession()
    executions.create(executionRecord())
    const execution = executions.get('exe-11111111-2222-4333-8444-555555555555')
    expect(execution).toMatchObject({
      id: 'exe-11111111-2222-4333-8444-555555555555',
      sessionId: 'ses-1',
      providerId: 'claude-code',
      agentId: 'agt-1',
      status: 'pending',
      capabilities: capabilities(),
    })
    expect(executions.list()).toHaveLength(1)
    expect(executions.listActive()).toHaveLength(1)
  })

  it('enforces foreign keys on executions.session_id', () => {
    seedProvider()
    expect(() => executions.create(executionRecord({ sessionId: 'ses-missing' }))).toThrow()
  })

  it('transitions pending → running → succeeded and keeps terminal states immutable', () => {
    seedSession()
    const id = 'exe-11111111-2222-4333-8444-555555555555'
    executions.create(executionRecord())
    expect(executions.markRunning(id, { processId: 4242, startedAt: NOW, updatedAt: NOW })).toBe(
      true,
    )
    expect(executions.get(id)).toMatchObject({ status: 'running', processId: 4242 })

    expect(executions.finish(id, { status: 'succeeded', exitCode: 0, endedAt: LATER })).toBe(true)
    expect(executions.get(id)).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      endedAt: LATER,
    })
    expect(executions.listActive()).toHaveLength(0)

    // 终态不可被后续事件改写；只补全缺失元数据。
    expect(executions.finish(id, { status: 'crashed', exitCode: 137, endedAt: LATER })).toBe(false)
    expect(executions.get(id)).toMatchObject({ status: 'succeeded', exitCode: 0 })
  })

  it('does not resurrect a terminal execution via markRunning', () => {
    seedSession()
    const id = 'exe-11111111-2222-4333-8444-555555555555'
    executions.create(executionRecord())
    executions.finish(id, { status: 'cancelled', endedAt: LATER })
    expect(executions.markRunning(id, { processId: 1, startedAt: LATER, updatedAt: LATER })).toBe(
      false,
    )
    expect(executions.get(id)?.status).toBe('cancelled')
  })
})

describe('ExecutionLogRepository', () => {
  it('assigns monotonic sequence numbers per execution', () => {
    providers.upsertDiscovered(providerInfo(), NOW)
    agents.insert(agentProfile())
    sessions.create({
      id: 'ses-1',
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: null,
      contextRef: 'agt-1',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })
    executions.create(executionRecord())

    const first = logs.append('exe-11111111-2222-4333-8444-555555555555', 'system', 'created', NOW)
    const second = logs.append('exe-11111111-2222-4333-8444-555555555555', 'stdout', 'OK', NOW)
    const third = logs.append('exe-11111111-2222-4333-8444-555555555555', 'structured', '{}', NOW)
    expect([first.sequenceNo, second.sequenceNo, third.sequenceNo]).toEqual([1, 2, 3])

    expect(logs.list('exe-11111111-2222-4333-8444-555555555555')).toHaveLength(3)
    expect(
      logs.list('exe-11111111-2222-4333-8444-555555555555', 1).map((log) => log.sequenceNo),
    ).toEqual([2, 3])
    expect(logs.list('exe-11111111-2222-4333-8444-555555555555', 0, 1)).toHaveLength(1)
  })
})
