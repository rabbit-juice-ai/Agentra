import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type DaemonExecutionStartParams,
  type DaemonExecutionStartResult,
  type DaemonExecutionStatusResult,
  type Execution,
  type ExecutionState,
  PROTOCOL_VERSION,
  RpcMethodError,
  type RuntimeEvent,
  type RuntimeInfo,
} from '@agentra/protocol'
import { buildClaudeArgs, FAKE_CLAUDE_PATH } from '@agentra/runtime-cli'
import { ProviderCapabilities } from '@agentra/runtime-sdk'
import { newId } from '@agentra/shared'
import {
  computeChecksum,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../daemon/daemon-client'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { SkillRepository } from '../db/repositories/skill-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { WorkflowAssignmentResolver } from '../workflow/assignment-resolver'
import { checkWorkflowConsistency } from '../workflow/consistency'
import { WorkflowExecutionBridge } from '../workflow/execution-bridge'
import { PublishedDefinitionProvider } from '../workflow/published-definition-provider'
import { AgentService } from './agent-service'
import { AssignmentService } from './assignment-service'
import type { CheckpointService } from './checkpoint-service'
import { CoreEventHub } from './event-hub'
import { ExecutionService } from './execution-service'
import { ProviderRegistry } from './provider-registry'
import { TaskMemoryService } from './task-memory-service'
import { WorkService } from './work-service'
import { WorkdirLockService } from './workdir-lock-service'
import { WorktreeService } from './worktree-service'

const TEST_BOOT = { status: 'known' as const, uuid: '11111111-1111-4111-8111-111111111111' }
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
  /** S55-2B-1B：status() 可注入结果/错误，覆盖 A2/A3 分类场景。 */
  statusResult: DaemonExecutionStatusResult | null = null
  statusError: Error | null = null
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
    if (this.statusError) throw this.statusError
    if (this.statusResult) return this.statusResult
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
  skills: SkillRepository
  teams: TeamRepository
  providers: ProviderRepository
  executions: ExecutionService
  runtime: FakeRuntimeClient
  hub: CoreEventHub
  logs: ExecutionLogRepository
  repository: ExecutionRepository
  agentId: string
  works: WorkService
  workRepository: WorkRepository
  taskMemoryService: TaskMemoryService
  assignments: AssignmentService
  sessions: SessionRepository
  worktrees: WorktreeService
  locks: WorkdirLockService
  workflow?: {
    bridge: WorkflowExecutionBridge
    nodeRunId: string
    nodes: NodeRunRepository
  }
  warnings: string[]
}

const dirs: string[] = []

async function harness(
  options: {
    health?: 'healthy' | 'unavailable' | 'unauthenticated'
    executablePath?: string | null
    capabilities?: typeof CAPABILITIES
    /** 真实接线：ExecutionService.cancel → WorkflowExecutionBridge（O-2 集成测试用）。 */
    workflow?: boolean
    /** S55-2B-1B：工作流默认重试次数（R1 重试路径测试用；默认 1）。 */
    maxAttempts?: number
    maintenance?: { isExecutionStartAllowed(): boolean }
    drain?: DrainCoordinator
    checkpoints?: Pick<CheckpointService, 'createForExecution' | 'assertCanStart'>
    recoveries?: {
      markRunning: (
        id: string,
        link: { executionId: string; sessionId: string; teamRunId: string | null },
        now: string,
      ) => boolean
    }
  } = {},
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-exec-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)

  const providerRepository = new ProviderRepository(db)
  const workRepository = new WorkRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const teamRepository = new TeamRepository(db)
  const auditRepository = new AuditRepository(db)
  const taskMemoryService = new TaskMemoryService({
    db,
    memories: new TaskMemoryRepository(db),
    audit: auditRepository,
    now: () => NOW,
  })
  const agentRepository = new AgentRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const nodeRunRepository = new NodeRunRepository(db)
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
  const worktrees = new WorktreeService(
    db,
    workRepository,
    new AssignmentRepository(db),
    path.join(dir, 'worktrees'),
    () => NOW,
  )
  const locks = new WorkdirLockService(db, () => NOW, undefined, TEST_BOOT)
  const works = new WorkService(
    db,
    workRepository,
    teamRepository,
    auditRepository,
    () => NOW,
    undefined,
    undefined,
    taskMemoryService,
  )
  const assignments = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    sessionRepository,
    () => NOW,
  )
  const skillRepository = new SkillRepository(db)
  const agents = new AgentService(
    db,
    agentRepository,
    providerRepository,
    skillRepository,
    () => NOW,
  )
  const agent = agents.create({
    name: 'Worker',
    defaultProviderId: 'claude-code',
    // 并发/排队用例依赖单槽位；新 Agent 的产品默认值是 5（见 AgentService 用例）。
    maxConcurrency: 1,
  })
  let workflowBridge: WorkflowExecutionBridge | null = null
  const warnings: string[] = []
  const executions = new ExecutionService({
    db,
    runtime,
    registry,
    works: workRepository,
    assignments: assignmentRepository,
    worktrees,
    locks,
    agents: agentRepository,
    skills: skillRepository,
    teams: teamRepository,
    taskMemories: taskMemoryService,
    checkpoints: options.checkpoints,
    recoveries: options.recoveries,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: logRepository,
    nodeRuns: nodeRunRepository,
    hub,
    scratchRoot: path.join(dir, 'scratch'),
    logger: {
      info: () => {},
      warn: (message, data) => warnings.push(`${message} ${JSON.stringify(data ?? {})}`),
      error: (message, data) => warnings.push(`${message} ${JSON.stringify(data ?? {})}`),
    },
    maintenance: options.maintenance,
    drain: options.drain,
    now: () => NOW,
    ...(options.workflow
      ? {
          // S55-2B-1B：补偿链直调桥接；engine 包装保留为运行期 kick 路径。
          onTerminalBridge: (execution) => workflowBridge?.onExecutionFinished(execution),
          onExecutionFinished: (execution) => workflowBridge?.onExecutionFinished(execution),
          workflowRuns: new WorkflowRunRepository(db),
        }
      : {}),
  })

  let workflow: Harness['workflow']
  if (options.workflow) {
    const definition = {
      schemaVersion: 1,
      nodes: [
        { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
        {
          key: 'task_1',
          type: 'agent_task',
          label: '',
          position: { x: 0, y: 1 },
          config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'do it' },
        },
        { key: 'end', type: 'end', label: '', position: { x: 0, y: 2 }, config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'task_1' },
        { key: 'e2', source: 'task_1', target: 'end' },
      ],
      settings: {
        defaults: { timeoutSeconds: 1800, maxAttempts: options.maxAttempts ?? 1 },
        reworkPolicy: { maxRounds: 2 },
        failureStrategy: 'fail_branch',
        concurrency: { maxParallelNodes: 4 },
      },
    } as unknown as WorkflowDefinition
    const parsedDefinition = WorkflowDefinitionSchema.parse(definition)
    const definitionJson = JSON.stringify(parsedDefinition)
    db.prepare(
      `INSERT INTO works (id, name, description, objective, status, priority, root_path,
         repository_path, settings_json, created_at, updated_at, completed_at)
       VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
    ).run(NOW, NOW)
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
       VALUES ('wft-1', 'T', '', '', ?, ?, NULL)`,
    ).run(NOW, NOW)
    db.prepare(
      `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at)
       VALUES ('wfv-1', 'wft-1', 1, 1, ?, ?, 'published', ?, ?)`,
    ).run(definitionJson, computeChecksum(parsedDefinition), NOW, NOW)
    db.prepare(
      `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
       VALUES ('run-1', 'work-1', 'wfv-1', 'running', ?, '{}', ?, ?)`,
    ).run(NOW, NOW, NOW)
    db.prepare(
      `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, status, attempt, input_snapshot_json, created_at, updated_at)
       VALUES ('nrn-task-1', 'run-1', 'task_1', 'running', 1, '{}', ?, ?)`,
    ).run(NOW, NOW)

    const workflowRepo = new WorkflowRepository(db)
    const nodes = nodeRunRepository
    workflowBridge = new WorkflowExecutionBridge({
      db,
      runs: new WorkflowRunRepository(db),
      nodes,
      works: workRepository,
      worktrees,
      definitions: new PublishedDefinitionProvider(workflowRepo),
      resolver: new WorkflowAssignmentResolver(assignmentRepository),
      executions,
      now: () => NOW,
    })
    workflow = { bridge: workflowBridge, nodeRunId: 'nrn-task-1', nodes }
  }

  return {
    db,
    dir,
    agents,
    skills: skillRepository,
    teams: teamRepository,
    works,
    workRepository,
    taskMemoryService,
    assignments,
    sessions: sessionRepository,
    worktrees,
    locks,
    providers: providerRepository,
    executions,
    runtime,
    hub,
    logs: logRepository,
    repository: executionRepository,
    agentId: agent.id,
    warnings,
    ...(workflow ? { workflow } : {}),
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

  it('rejects new execution starts while maintenance gate is closed', async () => {
    const h = await harness({
      maintenance: { isExecutionStartAllowed: () => false },
    })
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'MAINTENANCE_ACTIVE',
    })
    expect(h.executions.list()).toHaveLength(0)
    expect(h.runtime.starts).toHaveLength(0)
  })

  it('aborts before Daemon start when maintenance closes between intent and spawn', async () => {
    let calls = 0
    const h = await harness({
      maintenance: {
        isExecutionStartAllowed: () => {
          calls += 1
          return calls === 1
        },
      },
    })
    await expect(h.executions.start({ agentId: h.agentId, prompt: 'x' })).rejects.toMatchObject({
      code: 'MAINTENANCE_ACTIVE',
    })
    expect(h.runtime.starts).toHaveLength(0)
    expect(h.executions.list()).toHaveLength(1)
    expect(h.executions.list()[0]?.status).toBe('failed')
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

  it('keeps a failed terminal state even if exited reports exit code 0 afterwards', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(stateEvent(execution.id, 'failed', 'running'))
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    expect(h.executions.get(execution.id)).toMatchObject({ status: 'failed', exitCode: 0 })
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

  it('refuses to start when checkpoint policy reports an unresolved high-risk failure', async () => {
    const calls: string[] = []
    const h = await harness({
      checkpoints: {
        assertCanStart: (workId) => {
          calls.push(workId)
          throw new RpcMethodError('INVALID_PARAMS', 'RECOVERY_REQUIRED: blocked', {
            code: 'RECOVERY_REQUIRED',
          })
        },
        createForExecution: () => ({
          outcome: 'skipped',
          checkpointId: null,
          blocked: false,
          riskLevel: 'low',
          evidenceStatus: 'not_required',
          sideEffectCompleteness: 'not_tracked',
          reasons: [],
        }),
      },
    })
    const work = h.works.create({
      name: 'checkpoint gate',
      rootPath: path.join(h.dir, 'checkpoint-gate'),
    })
    h.works.activate(work.id)
    h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'engineer' })
    await expect(
      h.executions.start({ agentId: h.agentId, workId: work.id, prompt: 'hello' }),
    ).rejects.toThrow(/RECOVERY_REQUIRED/)
    expect(calls).toEqual([work.id])
  })

  it('creates a new Session for recovery and links the attempt in the same start path', async () => {
    const links: Array<{
      attemptId: string
      executionId: string
      sessionId: string
      teamRunId: string | null
    }> = []
    const h = await harness({
      recoveries: {
        markRunning: (attemptId, link) => {
          links.push({ attemptId, ...link })
          return true
        },
      },
    })
    const work = h.works.create({
      name: 'recovery execution',
      rootPath: path.join(h.dir, 'recovery-execution'),
    })
    h.works.activate(work.id)
    h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'engineer' })
    const execution = await h.executions.startRecovery(
      { agentId: h.agentId, workId: work.id, prompt: 'recover' },
      { recovery: { attemptId: 'rec-1', checkpointId: 'chk-1' } },
    )
    expect(links).toEqual([
      {
        attemptId: 'rec-1',
        executionId: execution.id,
        sessionId: execution.sessionId,
        teamRunId: null,
      },
    ])
    expect(h.sessions.get(execution.sessionId)?.status).toBe('active')
  })

  it('rolls back the new Session when recovery attempt linking fails', async () => {
    const h = await harness({ recoveries: { markRunning: () => false } })
    const work = h.works.create({
      name: 'recovery linking failure',
      rootPath: path.join(h.dir, 'recovery-link-failure'),
    })
    h.works.activate(work.id)
    h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'engineer' })
    await expect(
      h.executions.startRecovery(
        { agentId: h.agentId, workId: work.id, prompt: 'recover' },
        { recovery: { attemptId: 'rec-1', checkpointId: 'chk-1' } },
      ),
    ).rejects.toThrow(/RECOVERY_ACTIVE_EXISTS/)
    expect(h.db.prepare('SELECT count(*) AS c FROM executions').get()).toEqual({ c: 0 })
    expect(h.db.prepare('SELECT count(*) AS c FROM agent_sessions').get()).toEqual({ c: 0 })
  })

  it('refreshes Task Memory to the current Work criteria before starting an execution', async () => {
    const h = await harness()
    const work = h.works.create({
      name: 'Task memory refresh',
      rootPath: path.join(h.dir, 'task-memory-refresh'),
      acceptanceCriteria: ['v1'],
    })
    h.works.activate(work.id)
    h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'engineer' })
    expect(h.workRepository.updateAcceptanceCriteria(work.id, 1, ['v2'], 2, NOW, NOW)).toBe(true)
    await h.executions.start({ agentId: h.agentId, workId: work.id, prompt: 'hello' })
    expect(h.taskMemoryService.get(work.id)?.acceptanceCriteria.workVersion).toBe(2)
    expect(h.taskMemoryService.get(work.id)?.acceptanceCriteria.items[0]?.statement).toBe('v2')
  })
})

describe('Work lifecycle execution races (injected RuntimeClient, real SQLite)', () => {
  function work(h: Harness) {
    const w = h.works.create({ name: 'Work race', rootPath: path.join(h.dir, 'work-race') })
    h.works.activate(w.id)
    h.assignments.create({ workId: w.id, agentId: h.agentId, workRole: 'engineer' })
    return w.id
  }

  it('termination while Daemon start awaits cancels the returned handle and preserves cancelled state', async () => {
    const h = await harness()
    const workId = work(h)
    let entered!: () => void
    const starting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalStart = h.runtime.start.bind(h.runtime)
    h.runtime.start = async (params) => {
      entered()
      await delayed
      return originalStart(params)
    }
    h.runtime.statusResult = {
      executionId: 'fixture',
      status: 'cancelled',
      processId: null,
      exitCode: null,
      startedAt: NOW,
      endedAt: NOW,
    }
    const spawn = h.executions.start({ agentId: h.agentId, workId, prompt: 'hello' })
    await starting
    h.works.terminate(workId)
    const terminate = h.executions.terminateWork(workId)
    release()
    await Promise.all([spawn, terminate])
    expect(h.runtime.starts).toHaveLength(1)
    expect(h.runtime.cancels).toEqual([h.runtime.starts[0]?.executionId])
    expect(h.repository.listByWork(workId)[0]?.status).toBe('cancelled')
    expect(h.runtime.active).toEqual([])
    await h.executions.terminateWork(workId)
    expect(h.runtime.cancels).toHaveLength(1)
  })

  it('failed cancellation remains durable and a repeat termination retries without duplicate terminal accounting', async () => {
    const h = await harness()
    const workId = work(h)
    const execution = await h.executions.start({ agentId: h.agentId, workId, prompt: 'hello' })
    const originalCancel = h.runtime.cancel.bind(h.runtime)
    h.runtime.cancel = async () => {
      throw new Error('injected daemon unavailable')
    }
    h.works.terminate(workId)
    await expect(h.executions.terminateWork(workId)).rejects.toThrow(/unconfirmed/)
    expect(h.repository.get(execution.id)?.status).toBe('cancelled')
    expect(JSON.parse(h.repository.getRecoveryStateRaw(execution.id).raw ?? '{}')).toMatchObject({
      cancellationPending: true,
    })
    h.runtime.cancel = originalCancel
    h.runtime.statusResult = {
      executionId: execution.id,
      status: 'cancelled',
      processId: null,
      exitCode: null,
      startedAt: NOW,
      endedAt: NOW,
    }
    await h.executions.terminateWork(workId)
    expect(h.runtime.cancels).toEqual([execution.id])
    expect(JSON.parse(h.repository.getRecoveryStateRaw(execution.id).raw ?? '{}')).toMatchObject({
      cancellationPending: false,
    })
    expect(
      h.logs.list(execution.id).filter((log) => log.content.includes('execution.cancel_requested')),
    ).toHaveLength(1)
  })

  it('restart cancellation uses durable queued intent without asking Daemon to cancel an unstarted process', async () => {
    const h = await harness()
    await h.executions.start({ agentId: h.agentId, prompt: 'occupy concurrency slot' })
    const workId = work(h)
    const queued = await h.executions.start({ agentId: h.agentId, workId, prompt: 'queued' })
    expect(queued.status).toBe('pending')
    h.works.terminate(workId)
    const restarted = new ExecutionService({
      db: h.db,
      runtime: h.runtime,
      registry: new ProviderRegistry(h.providers, h.runtime),
      works: new WorkRepository(h.db),
      worktrees: h.worktrees,
      locks: h.locks,
      assignments: new AssignmentRepository(h.db),
      agents: new AgentRepository(h.db),
      sessions: h.sessions,
      executions: h.repository,
      logs: h.logs,
      hub: h.hub,
      scratchRoot: path.join(h.dir, 'scratch'),
      now: () => NOW,
    })
    await restarted.terminateWork(workId)
    expect(h.runtime.cancels).toEqual([])
    expect(h.runtime.starts).toHaveLength(1)
    expect(h.repository.get(queued.id)?.status).toBe('cancelled')
    expect(JSON.parse(h.repository.getRecoveryStateRaw(queued.id).raw ?? '{}')).toMatchObject({
      cancellationPending: false,
    })
  })

  it('a natural exit racing cancellation cannot resurrect the cancelled Execution', async () => {
    const h = await harness()
    const workId = work(h)
    const execution = await h.executions.start({ agentId: h.agentId, workId, prompt: 'hello' })
    const originalCancel = h.runtime.cancel.bind(h.runtime)
    h.runtime.cancel = async (id) => {
      h.executions.handleRuntimeEvent(
        exitedEvent(id, { exitCode: 0, signal: null, reason: 'exited' }),
      )
      await originalCancel(id)
    }
    h.runtime.statusResult = {
      executionId: execution.id,
      status: 'succeeded',
      processId: null,
      exitCode: 0,
      startedAt: NOW,
      endedAt: NOW,
    }
    h.works.terminate(workId)
    await h.executions.terminateWork(workId)
    expect(h.repository.get(execution.id)?.status).toBe('cancelled')
    expect(h.runtime.cancels).toHaveLength(1)
    expect(h.locks.countByExecution(execution.id)).toBe(0)
  })

  it('no interrupt capability lets the current step finish while new paused-Work starts are denied', async () => {
    const h = await harness({ capabilities: { ...CAPABILITIES, interrupt: 'unsupported' } })
    const workId = work(h)
    const execution = await h.executions.start({ agentId: h.agentId, workId, prompt: 'hello' })
    h.works.pause(workId)
    await h.executions.pauseWork(workId)
    await h.executions.pauseWork(workId)
    expect(h.runtime.interrupts).toEqual([])
    await expect(
      h.executions.start({ agentId: h.agentId, workId, prompt: 'not allowed' }),
    ).rejects.toThrow(/not active/)
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    expect(h.repository.get(execution.id)?.status).toBe('succeeded')
    expect(h.runtime.starts).toHaveLength(1)
  })

  it('allows explicit team-collaboration starts on a paused work', async () => {
    const h = await harness()
    const workId = work(h)
    h.works.pause(workId)
    const execution = await h.executions.start(
      { agentId: h.agentId, workId, prompt: 'team reply' },
      { allowInactiveWork: true },
    )
    expect(execution.status).toBe('running')
    expect(h.runtime.starts).toHaveLength(1)
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

  it('moves the bound NodeRun out of running when the execution is cancelled (O-2)', async () => {
    const h = await harness({ workflow: true })
    if (!h.workflow) throw new Error('missing workflow harness')
    const execution = await h.executions.startForNode(h.workflow.nodeRunId, {
      agentId: h.agentId,
      prompt: 'hello',
    })
    expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('running')

    await h.executions.cancel({ executionId: execution.id })

    expect(h.executions.get(execution.id).status).toBe('cancelled')
    expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('cancelled')
    // C-03：取消后不得出现「终态节点仍挂着活跃执行」或「运行节点没有执行」。
    expect(checkWorkflowConsistency(h.db)).toEqual([])
    expect(h.warnings).toEqual([])
  })

  it('carries runId / branchRunId / nodeRunId in process_started diagnostics', async () => {
    const h = await harness({ workflow: true })
    if (!h.workflow) throw new Error('missing workflow harness')
    const execution = await h.executions.startForNode(h.workflow.nodeRunId, {
      agentId: h.agentId,
      prompt: 'hello',
    })
    const log = h.logs
      .list(execution.id)
      .find((entry) => entry.content.includes('execution.process_started'))
    if (!log) throw new Error('missing process_started log')
    expect(JSON.parse(log.content)).toMatchObject({
      event: 'execution.process_started',
      runId: 'run-1',
      branchRunId: null,
      nodeRunId: 'nrn-task-1',
    })
  })

  it('backfills a bound execution when the daemon reports a terminal state (A2)', async () => {
    const h = await harness({ workflow: true })
    if (!h.workflow) throw new Error('missing workflow harness')
    const execution = await h.executions.startForNode(h.workflow.nodeRunId, {
      agentId: h.agentId,
      prompt: 'hello',
    })
    expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('running')

    // Daemon 同进程明确报告终态（A2）：允许补记账，节点经桥接收尾。
    h.runtime.active = []
    h.runtime.statusResult = {
      executionId: execution.id,
      status: 'crashed',
      processId: null,
      exitCode: null,
      startedAt: NOW,
      endedAt: NOW,
    }
    const report = await h.executions.reconcile()

    expect(report.observedTerminal.map((entry) => entry.executionId)).toEqual([execution.id])
    expect(h.executions.get(execution.id).status).toBe('crashed')
    expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('failed')
    expect(checkWorkflowConsistency(h.db)).toEqual([])
    expect(h.warnings.filter((warning) => warning.includes('node state changed'))).toEqual([])
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
  it('classifies a pending execution with no daemon evidence and fails it as unstarted', async () => {
    const h = await harness()
    const sessionId = newId('ses')
    h.sessions.create({
      id: sessionId,
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: newId('ext'),
      contextRef: h.agentId,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })
    const execution: Execution = {
      id: newId('exe'),
      sessionId,
      providerId: 'claude-code',
      agentId: h.agentId,
      externalExecutionId: newId('ext'),
      processId: null,
      status: 'pending',
      workingDirectory: path.join(h.dir, 'pending-recovery'),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      capabilities: CAPABILITIES,
      createdAt: NOW,
      updatedAt: NOW,
    }
    h.repository.create(execution)
    h.runtime.active = []
    h.runtime.statusError = new RpcMethodError('EXECUTION_NOT_FOUND', 'not known')
    await expect(h.executions.classifyPendingStart(execution.id)).resolves.toBe('not_started')
    expect(h.executions.failUnstartedExecution(execution.id, 'START_INTERRUPTED')).toBe(true)
    expect(h.executions.get(execution.id).status).toBe('failed')
    expect(h.sessions.get(sessionId)?.status).toBe('ended')
  })

  it('does not misclassify a pending execution with start evidence as unstarted', async () => {
    const h = await harness()
    const sessionId = newId('ses')
    h.sessions.create({
      id: sessionId,
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: newId('ext'),
      contextRef: h.agentId,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })
    const execution: Execution = {
      id: newId('exe'),
      sessionId,
      providerId: 'claude-code',
      agentId: h.agentId,
      externalExecutionId: newId('ext'),
      processId: 4242,
      status: 'pending',
      workingDirectory: path.join(h.dir, 'pending-started'),
      startedAt: NOW,
      endedAt: null,
      exitCode: null,
      capabilities: CAPABILITIES,
      createdAt: NOW,
      updatedAt: NOW,
    }
    h.repository.create(execution)
    await expect(h.executions.classifyPendingStart(execution.id)).resolves.toBe('spawned')
    expect(h.executions.failUnstartedExecution(execution.id, 'START_INTERRUPTED')).toBe(false)
    expect(h.executions.get(execution.id).status).toBe('pending')
  })

  it('does not mark an execution crashed when the daemon no longer knows it (A3)', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.runtime.active = []
    h.runtime.statusError = new RpcMethodError(
      'EXECUTION_NOT_FOUND',
      'daemon does not know execution',
    )
    const report = await h.executions.reconcile()
    // R3：仅凭 Daemon 不可见不判死——行保持原状态，交由节点层 reconciliation_required。
    expect(report.unconfirmed).toEqual([execution.id])
    expect(h.executions.get(execution.id).status).toBe('running')
  })

  it('records a daemon-observed terminal state with reconciliation provenance (A2)', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.runtime.active = []
    h.runtime.statusResult = {
      executionId: execution.id,
      status: 'succeeded',
      processId: 4242,
      exitCode: 0,
      startedAt: NOW,
      endedAt: NOW,
    }
    const report = await h.executions.reconcile()
    expect(report.observedTerminal).toEqual([
      { executionId: execution.id, daemonStatus: 'succeeded' },
    ])
    const stored = h.executions.get(execution.id)
    expect(stored.status).toBe('succeeded')
    expect(stored.exitCode).toBe(0)
    // 持久化标志：terminalProcessing 完成，且来源为 reconciliation_observed。
    const row = h.db
      .prepare('SELECT recovery_state_json AS raw FROM executions WHERE id = ?')
      .get(execution.id) as { raw: string }
    const state = JSON.parse(row.raw) as {
      terminalProcessing?: { state?: string; source?: string }
      reason?: string
    }
    expect(state.terminalProcessing?.state).toBe('completed')
    expect(state.terminalProcessing?.source).toBe('reconciliation_observed')
    expect(state.reason).toBe('reconciliation_observed')
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
    expect(() => h.agents.create({ name: 'X', defaultProviderId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_NOT_FOUND' }),
    )

    const created = h.agents.create({
      name: '  Backend  ',
      defaultProviderId: 'claude-code',
      accessMode: 'edit',
    })
    expect(created.name).toBe('Backend')
    expect(created.defaultProviderId).toBe('claude-code')
    expect(created.avatar).toBe('🤖')
    expect(created.maxConcurrency).toBe(5)
    expect(created.accessMode).toBe('edit')

    const updated = h.agents.update({ id: created.id, maxConcurrency: 2, accessMode: 'analyze' })
    expect(updated).toMatchObject({ maxConcurrency: 2, accessMode: 'analyze', name: 'Backend' })
    expect(updated.toolPermissions.deny).toContain('Write')

    const archived = h.agents.archive(created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBe(NOW)
    expect(h.agents.list().map((agent) => agent.id)).not.toContain(created.id)
    expect(h.agents.list(true).map((agent) => agent.id)).toContain(created.id)
    expect(h.agents.archive(created.id).status).toBe('archived')
  })

  it('requires an explicit provider at the service boundary', async () => {
    const h = await harness()
    expect(() => h.agents.create({ name: 'NoProvider' } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('accepts image data URLs as avatars and rejects unsupported formats', async () => {
    const h = await harness()
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const created = h.agents.create({
      name: 'Pix',
      defaultProviderId: 'claude-code',
      avatar: dataUrl,
    })
    expect(created.avatar).toBe(dataUrl)

    expect(() =>
      h.agents.create({
        name: 'Bad Avatar',
        defaultProviderId: 'claude-code',
        avatar: 'data:image/svg+xml;base64,PHN2Zz4=',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    expect(() =>
      h.agents.create({
        name: 'Long Avatar',
        defaultProviderId: 'claude-code',
        avatar: 'x'.repeat(40),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  })

  it('derives the tool policy from access mode', async () => {
    const h = await harness()
    const analyze = h.agents.create({ name: 'Analyzer', defaultProviderId: 'claude-code' })
    expect(analyze.accessMode).toBe('analyze')
    expect(analyze.toolPermissions).toEqual({
      version: 1,
      allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      deny: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    })

    const editor = h.agents.create({
      name: 'Editor',
      defaultProviderId: 'claude-code',
      accessMode: 'edit',
    })
    expect(editor.toolPermissions.allow).toContain('Write')
    expect(editor.toolPermissions.allow).toContain('Edit')
    expect(editor.toolPermissions.deny).toEqual([])
  })
})

describe('工具权限强制（U3）', () => {
  it('拒绝 allow 为空的 Agent，且不创建 Execution', async () => {
    const h = await harness()
    const unconfigured = h.agents.create({ name: 'NoTools', defaultProviderId: 'claude-code' })
    // 模拟历史遗留行：新模型下 allow 由 accessMode 派生，这里直接改库以覆盖执行层兜底。
    h.db
      .prepare('UPDATE agent_profiles SET tool_permissions_json = ? WHERE id = ?')
      .run('{"version":1,"allow":[],"deny":[]}', unconfigured.id)
    expect(h.agents.get(unconfigured.id).toolPermissions).toEqual({
      version: 1,
      allow: [],
      deny: [],
    })

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
          id, name, avatar, description, system_prompt, skill_ids_json, access_mode,
          system_kind, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'agt-legacy',
        'Legacy',
        '🤖',
        '',
        '',
        '[]',
        'analyze',
        null,
        null,
        1,
        'active',
        NOW,
        NOW,
        null,
      )

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

    // 读取回来的是按 accessMode 派生的策略
    expect(h.agents.get(h.agentId).toolPermissions).toEqual({
      version: 1,
      allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      deny: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    })
    // Core → Daemon
    const start = h.runtime.starts[0]
    expect(start).toMatchObject({
      allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    })
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
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Write')

    // 审计：execution_logs 里有一条 tool_policy 记录
    const policyLog = h.logs
      .list(execution.id)
      .find((log) => log.content.includes('execution.tool_policy'))
    expect(policyLog).toBeDefined()
    expect(policyLog?.content).toContain('Read')
  })

  it('appends selected skill instructions to the system prompt', async () => {
    const h = await harness()
    h.skills.insert({
      id: 'skl-review',
      name: '代码评审清单',
      description: '',
      instructions: '先看错误路径，再看测试覆盖。',
      createdAt: NOW,
      updatedAt: NOW,
    })
    h.agents.update({ id: h.agentId, skillIds: ['skl-review'] })

    await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    const start = h.runtime.starts[0]
    expect(start?.systemPrompt).toContain('代码评审清单')
    expect(start?.systemPrompt).toContain('先看错误路径，再看测试覆盖。')
  })

  it('injects team instructions only for members of teams linked to the work', async () => {
    const h = await harness()
    const work = h.works.create({
      name: 'Team Work',
      rootPath: path.join(h.dir, 'team-work-root'),
    })
    h.works.activate(work.id)
    h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'dev' })
    h.db
      .prepare(
        `INSERT INTO teams (id, name, description, instructions, settings_json, status, created_at, updated_at, archived_at)
         VALUES ('team-1', 'Delivery', '', '团队规则：先写测试，再改实现。', '{}', 'active', ?, ?, NULL)`,
      )
      .run(NOW, NOW)
    h.db
      .prepare(
        `INSERT INTO team_members (id, team_id, agent_id, permissions_json, joined_at)
         VALUES ('tm-1', 'team-1', ?, '{}', ?)`,
      )
      .run(h.agentId, NOW)
    h.db
      .prepare('INSERT INTO work_teams (work_id, team_id, created_at) VALUES (?, ?, ?)')
      .run(work.id, 'team-1', NOW)

    await h.executions.start({ agentId: h.agentId, workId: work.id, prompt: 'hello' })
    const start = h.runtime.starts[0]
    expect(start?.systemPrompt).toContain('团队指引 · Delivery')
    expect(start?.systemPrompt).toContain('团队规则：先写测试，再改实现。')
  })
})

describe('阶段 2 B3：工作目录锁与 Worktree 隔离', () => {
  /** 建 Work + 激活 + 配一个 active assignment（D-1 起，带 workId 启动必须有 active 岗位）。 */
  function workWithAssignment(
    h: Awaited<ReturnType<typeof harness>>,
    name: string,
    rootPath: string,
    repositoryPath: string | null = null,
  ) {
    const work = h.works.create({ name, rootPath, repositoryPath })
    h.works.activate(work.id)
    const assignment = h.assignments.create({
      workId: work.id,
      agentId: h.agentId,
      workRole: 'engineer',
    })
    return { work, assignment }
  }

  it('WORKDIR_LOCKED：两个 Work 指向同一非 Worktree 目录时第二个启动被拒且不创建 Execution', async () => {
    const h = await harness()
    const shared = path.join(h.dir, 'shared-workdir')

    const workA = workWithAssignment(h, 'A', shared).work
    const workB = workWithAssignment(h, 'B', shared).work

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

    const workA = workWithAssignment(h, 'A', repo, repo).work
    const workB = workWithAssignment(h, 'B', repo, repo).work

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
    const work = workWithAssignment(h, 'W', shared).work

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

describe('阶段 2 B4：Agent 并发限制与排队', () => {
  function exitEvent(executionId: string) {
    return {
      eventId: newId('evt'),
      protocolVersion: PROTOCOL_VERSION,
      eventType: 'execution.exited' as const,
      occurredAt: NOW,
      aggregateType: 'execution' as const,
      aggregateId: executionId,
      payload: {
        executionId,
        sequenceNo: 9,
        exitCode: 0,
        signal: null,
        reason: 'exited' as const,
        timestamp: NOW,
      },
      correlationId: executionId,
    }
  }

  it('达到 maxConcurrency 时第二个任务进入排队且不启动进程', async () => {
    const h = await harness()
    expect(h.agents.get(h.agentId).maxConcurrency).toBe(1)

    const first = await h.executions.start({ agentId: h.agentId, prompt: 'first' })
    expect(first.status).toBe('running')
    expect(h.runtime.starts).toHaveLength(1)

    const second = await h.executions.start({ agentId: h.agentId, prompt: 'second' })
    expect(second.status).toBe('pending')
    expect(second.processId).toBeNull()
    // 关键证据：没有向 Daemon 发起第二次启动
    expect(h.runtime.starts).toHaveLength(1)

    const logs = h.logs.list(second.id).map((log) => log.content)
    expect(logs.some((content) => content.includes('execution.queued'))).toBe(true)
  })

  it('槽位释放后自动调度排队任务（新进程被创建）', async () => {
    const h = await harness()
    const first = await h.executions.start({ agentId: h.agentId, prompt: 'first' })
    const second = await h.executions.start({ agentId: h.agentId, prompt: 'second' })
    expect(second.status).toBe('pending')

    h.executions.handleRuntimeEvent(exitEvent(first.id))
    // drainQueue 是异步的，等它跑完
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(h.runtime.starts).toHaveLength(2)
    expect(h.executions.get(second.id)?.status).toBe('running')
    expect(h.executions.get(first.id)?.status).toBe('succeeded')
  })

  it('Core 重启后遗留的排队任务被丢弃并标记，锁随之释放', async () => {
    const h = await harness()
    // 两个 Work 用不同目录：这样第二个会卡在并发上限（而不是工作目录锁）
    const mkWork = (suffix: string) => {
      const work = h.works.create({ name: suffix, rootPath: path.join(h.dir, `queued-${suffix}`) })
      h.works.activate(work.id)
      h.assignments.create({ workId: work.id, agentId: h.agentId, workRole: 'engineer' })
      return work
    }
    const workA = mkWork('a')
    const workB = mkWork('b')

    await h.executions.start({ agentId: h.agentId, prompt: 'first', workId: workA.id })
    const queued = await h.executions.start({
      agentId: h.agentId,
      prompt: 'second',
      workId: workB.id,
    })
    expect(queued.status).toBe('pending')
    expect(h.locks.get(path.join(h.dir, 'queued-b'))).not.toBeNull()

    expect(h.executions.discardQueuedOnStartup()).toBe(1)
    const discarded = h.executions.get(queued.id)
    expect(discarded?.status).toBe('failed')
    const logs = h.logs.list(queued.id).map((log) => log.content)
    expect(logs.some((content) => content.includes('execution.queue_discarded'))).toBe(true)
    // 丢弃后排队的锁不再占着目录
    expect(h.locks.get(path.join(h.dir, 'queued-b'))).toBeNull()
  })
})

describe('阶段 2 D-1：Session 绑定 Assignment', () => {
  it('带 workId 启动：Session 绑到 active assignment，且能由 executionId 反查所属 Work', async () => {
    const h = await harness()
    const work = h.works.create({ name: 'W1', rootPath: path.join(h.dir, 'd1-a') })
    h.works.activate(work.id)
    const assignment = h.assignments.create({
      workId: work.id,
      agentId: h.agentId,
      workRole: 'engineer',
    })

    const execution = await h.executions.start({
      agentId: h.agentId,
      prompt: 'bound',
      workId: work.id,
    })

    expect(h.sessions.get(execution.sessionId)?.assignmentId).toBe(assignment.id)
    // 可追溯路径：execution → session → assignment → work
    expect(h.repository.findOwningWork(execution.id)).toEqual({
      workId: work.id,
      workName: 'W1',
    })
  })

  it('不带 workId 的阶段 1 模式保持 assignmentId=null', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'scratch' })
    expect(h.sessions.get(execution.sessionId)?.assignmentId).toBeNull()
    expect(h.repository.findOwningWork(execution.id)).toBeNull()
  })

  it('没有 active assignment：拒绝且零副作用（不建 Execution / 不建 Session / 不持锁）', async () => {
    const h = await harness()
    const work = h.works.create({ name: 'W1', rootPath: path.join(h.dir, 'd1-b') })
    h.works.activate(work.id)

    const countSessions = (): number =>
      (h.db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get() as { c: number }).c
    const before = {
      executions: h.repository.list(100).length,
      sessions: countSessions(),
      locks: h.locks.list().length,
    }

    await expect(
      h.executions.start({ agentId: h.agentId, prompt: 'no-assignment', workId: work.id }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })

    expect(h.repository.list(100).length).toBe(before.executions)
    expect(countSessions()).toBe(before.sessions)
    expect(h.locks.list().length).toBe(before.locks)
  })

  it('assignment 非 active 时拒绝启动', async () => {
    const h = await harness()
    const work = h.works.create({ name: 'W1', rootPath: path.join(h.dir, 'd1-c') })
    h.works.activate(work.id)
    const assignment = h.assignments.create({
      workId: work.id,
      agentId: h.agentId,
      workRole: 'engineer',
    })
    h.assignments.complete(assignment.id)

    await expect(
      h.executions.start({ agentId: h.agentId, prompt: 'inactive', workId: work.id }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('取消排队中的执行会清掉内存队列条目（D-2）', async () => {
    const h = await harness()
    const first = await h.executions.start({ agentId: h.agentId, prompt: 'a' })
    const queued = await h.executions.start({ agentId: h.agentId, prompt: 'b' })
    expect(queued.status).toBe('pending')

    const cancelled = await h.executions.cancel({ executionId: queued.id })
    expect(cancelled.status).toBe('cancelled')

    // 释放第一个后，被取消的排队任务不应被调度（新进程数仍为 1）
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
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.runtime.starts).toHaveLength(1)
    expect(h.executions.get(queued.id)?.status).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// S55-2B-1B：终态补偿（M1–M6 / S1–S8 / X1–X3 / 崩溃点）
// ---------------------------------------------------------------------------

type SeedOptions = {
  executionStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'crashed'
  nodeStatus?: string | null
  nodeRunId?: string
  nodeKey?: string
  recoveryState?: Record<string, unknown> | null
  corrupt?: boolean
  sessionEnded?: boolean
  withLock?: boolean
}

function seedExecution(
  h: Harness,
  options: SeedOptions = {},
): { executionId: string; sessionId: string; nodeRunId: string | null } {
  const executionId = `exe-${randomUUID()}`
  const sessionId = `ses-${randomUUID()}`
  const now = NOW
  h.db
    .prepare(
      `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
         context_ref, status, created_at, updated_at, last_active_at)
       VALUES (?, NULL, 'claude-code', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      randomUUID(),
      h.agentId,
      options.sessionEnded === false ? 'active' : 'ended',
      now,
      now,
      now,
    )
  let nodeRunId: string | null = null
  if (options.nodeStatus) {
    nodeRunId = options.nodeRunId ?? `nrn-${randomUUID()}`
    const exists = h.db.prepare('SELECT 1 FROM node_runs WHERE id = ?').get(nodeRunId)
    if (!exists)
      h.db
        .prepare(
          `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status,
           attempt, input_snapshot_json, created_at, updated_at)
         VALUES (?, 'run-1', ?, NULL, ?, 1, '{}', ?, ?)`,
        )
        .run(
          nodeRunId,
          options.nodeKey ?? `node_${randomUUID().slice(0, 8)}`,
          options.nodeStatus,
          now,
          now,
        )
  }
  const recovery =
    options.corrupt === true
      ? '{corrupt'
      : options.recoveryState === undefined
        ? null
        : JSON.stringify(options.recoveryState)
  h.db
    .prepare(
      `INSERT INTO executions (id, session_id, node_run_id, provider_id, external_execution_id,
         process_id, status, working_directory, started_at, ended_at, exit_code,
         capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
       VALUES (?, ?, ?, 'claude-code', NULL, NULL, ?, '/tmp/seed', ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      executionId,
      sessionId,
      nodeRunId,
      options.executionStatus ?? 'succeeded',
      now,
      now,
      JSON.stringify(CAPABILITIES),
      recovery,
      now,
      now,
    )
  if (options.withLock) {
    h.db
      .prepare(
        `INSERT INTO workdir_locks (workdir, execution_id, work_id, holder_pid, boot_uuid, acquired_at)
         VALUES (?, ?, NULL, ?, NULL, ?)`,
      )
      .run(`/tmp/lock-${executionId}`, executionId, process.pid, now)
  }
  return { executionId, sessionId, nodeRunId }
}

function readRecoveryState(h: Harness, executionId: string): Record<string, unknown> {
  const row = h.db
    .prepare('SELECT recovery_state_json AS raw FROM executions WHERE id = ?')
    .get(executionId) as { raw: string | null }
  if (row.raw === null) return {}
  return JSON.parse(row.raw) as Record<string, unknown>
}

describe('S55-2B-1B terminal compensation', () => {
  it('M1/M3: TX1 merges terminalProcessing.pending and preserves queued keys', async () => {
    const h = await harness()
    const { executionId } = seedExecution(h, {
      executionStatus: 'pending',
      recoveryState: { queued: true, queuedAt: NOW },
    })
    h.executions.discardQueuedOnStartup()
    const state = readRecoveryState(h, executionId)
    expect(state.queued).toBe(true)
    expect(state.queuedAt).toBe(NOW)
    expect(state.reason).toBe('queue_discarded_on_restart')
    expect(state.terminalProcessing).toMatchObject({
      state: 'completed',
      source: 'core_initiated',
    })
    expect(h.executions.get(executionId).status).toBe('failed')
  })

  it('M2: preserves every pre-existing recovery_state key', async () => {
    const h = await harness()
    const { executionId } = seedExecution(h, {
      executionStatus: 'pending',
      recoveryState: { queued: true, queuedAt: NOW, evidence: { x: 1 }, custom: 'keep' },
    })
    h.executions.discardQueuedOnStartup()
    const state = readRecoveryState(h, executionId)
    expect(state).toMatchObject({
      queued: true,
      queuedAt: NOW,
      evidence: { x: 1 },
      custom: 'keep',
    })
    expect((state.terminalProcessing as { state: string }).state).toBe('completed')
  })

  it('M4: corrupt recovery_state_json fails closed without overwriting', async () => {
    const h = await harness()
    // 运行中的执行 + 损坏 JSON：终态观察的 TX1 必须抛错回滚，事件处理器记录后丢弃该事件。
    const { executionId } = seedExecution(h, {
      executionStatus: 'running',
      nodeStatus: null,
      corrupt: true,
    })
    h.executions.handleRuntimeEvent(
      exitedEvent(executionId, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    const row = h.db
      .prepare('SELECT status, recovery_state_json AS raw FROM executions WHERE id = ?')
      .get(executionId) as { status: string; raw: string }
    expect(row.status).toBe('running')
    expect(row.raw).toBe('{corrupt')
    expect(h.warnings.some((warning) => warning.includes('corrupt'))).toBe(true)
  })

  it('M5: NULL recovery_state is written with pending then completed', async () => {
    const h = await harness()
    const execution = await h.executions.start({ agentId: h.agentId, prompt: 'hello' })
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 0, signal: null, reason: 'exited' }),
    )
    const state = readRecoveryState(h, execution.id)
    expect(state.terminalProcessing).toMatchObject({
      state: 'completed',
      source: 'event_observed',
    })
    expect(state.terminalProcessing).toMatchObject({ observedAt: NOW })
  })

  it('M6: BEGIN IMMEDIATE excludes a second SQLite writer (real lock)', async () => {
    const h = await harness()
    const second = new DatabaseSync(path.join(h.dir, 'agentra.db'))
    h.db.exec('BEGIN IMMEDIATE')
    try {
      expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i)
    } finally {
      h.db.exec('ROLLBACK')
      second.close()
    }
  })

  describe('S4 node status verification', () => {
    const allowed = [
      'succeeded',
      'failed',
      'cancelled',
      'skipped',
      'waiting_approval',
      'paused',
      'changes_requested',
      'rejected',
      'reconciliation_required',
    ]
    for (const nodeStatus of allowed) {
      it(`S: node ${nodeStatus} allows completed`, async () => {
        const h = await harness({ workflow: true })
        const { executionId } = seedExecution(h, {
          nodeStatus,
          recoveryState: {
            terminalProcessing: { state: 'pending', source: 'event_observed' },
          },
        })
        const result = h.executions.processTerminalBacklog()
        expect(result.failures).toEqual([])
        expect(result.completed).toBe(1)
        expect(
          (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
        ).toBe('completed')
      })
    }

    for (const nodeStatus of ['running', 'blocked', 'ready']) {
      it(`S: node ${nodeStatus} fails closed and stays pending`, async () => {
        const h = await harness({ workflow: true })
        const { executionId } = seedExecution(h, {
          nodeStatus,
          recoveryState: {
            terminalProcessing: { state: 'pending', source: 'event_observed' },
          },
        })
        const result = h.executions.processTerminalBacklog()
        expect(result.completed).toBe(0)
        expect(result.failures).toHaveLength(1)
        expect(
          (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
        ).toBe('pending')
      })
    }

    it('S7: scratch execution (node_run_id NULL) passes without node checks', async () => {
      const h = await harness()
      const { executionId } = seedExecution(h, {
        nodeStatus: null,
        recoveryState: { terminalProcessing: { state: 'pending', source: 'event_observed' } },
      })
      const result = h.executions.processTerminalBacklog()
      expect(result.failures).toEqual([])
      expect(result.completed).toBe(1)
      expect(
        (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
      ).toBe('completed')
    })

    it('S6: missing node run fails closed', async () => {
      const h = await harness({ workflow: true })
      const { executionId } = seedExecution(h, {
        nodeStatus: 'succeeded',
        recoveryState: { terminalProcessing: { state: 'pending', source: 'event_observed' } },
      })
      const original = (h.executions as unknown as { nodeRuns: unknown }).nodeRuns
      ;(h.executions as unknown as { nodeRuns: unknown }).nodeRuns = { get: () => null }
      try {
        const result = h.executions.processTerminalBacklog()
        expect(result.failures).toHaveLength(1)
        expect(
          (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
        ).toBe('pending')
      } finally {
        ;(h.executions as unknown as { nodeRuns: unknown }).nodeRuns = original
      }
    })

    it('S8: missing workflow run fails closed', async () => {
      const h = await harness({ workflow: true })
      const { executionId } = seedExecution(h, {
        nodeStatus: 'succeeded',
        recoveryState: { terminalProcessing: { state: 'pending', source: 'event_observed' } },
      })
      const original = (h.executions as unknown as { workflowRuns: unknown }).workflowRuns
      ;(h.executions as unknown as { workflowRuns: unknown }).workflowRuns = { get: () => null }
      try {
        const result = h.executions.processTerminalBacklog()
        expect(result.failures).toHaveLength(1)
        expect(
          (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
        ).toBe('pending')
      } finally {
        ;(h.executions as unknown as { workflowRuns: unknown }).workflowRuns = original
      }
    })

    it('S: corrupt JSON anywhere blocks the backlog sweep (precheck)', async () => {
      const h = await harness()
      seedExecution(h, { executionStatus: 'pending', corrupt: true })
      expect(() => h.executions.processTerminalBacklog()).toThrow(/corrupt/)
    })
  })

  describe('crash-point replay (K2/K6/K9)', () => {
    it('K2: terminal + pending + node running → backlog completes bridge and flag', async () => {
      const h = await harness({ workflow: true })
      const { executionId, nodeRunId } = seedExecution(h, {
        executionStatus: 'failed',
        nodeStatus: 'running',
        nodeKey: 'task_1',
        nodeRunId: 'nrn-task-1',
        recoveryState: {
          terminalProcessing: { state: 'pending', source: 'event_observed' },
        },
      })
      const result = h.executions.processTerminalBacklog()
      expect(result.failures).toEqual([])
      expect(h.workflow?.nodes.get(nodeRunId as string)?.status).toBe('failed')
      expect(
        (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
      ).toBe('completed')
    })

    it('K6: retry attempt survives; replay does not create a second attempt', async () => {
      const h = await harness({ workflow: true })
      const nodeKey = 'task_1'
      const { executionId, nodeRunId } = seedExecution(h, {
        executionStatus: 'failed',
        nodeStatus: 'running',
        nodeKey,
        nodeRunId: 'nrn-task-1',
        recoveryState: {
          terminalProcessing: { state: 'pending', source: 'event_observed' },
        },
      })
      // 模拟 K6：桥接已创建 attempt+1 的 ready 行。
      h.db
        .prepare(
          `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status,
             attempt, input_snapshot_json, created_at, updated_at)
           VALUES (?, 'run-1', ?, NULL, 'ready', 2, '{}', ?, ?)`,
        )
        .run(`nrn-${randomUUID()}`, nodeKey, NOW, NOW)

      const first = h.executions.processTerminalBacklog()
      expect(first.failures).toEqual([])
      const second = h.executions.processTerminalBacklog()
      expect(second.processed).toBe(0)
      const attempts = h.db
        .prepare(
          `SELECT COUNT(*) AS c FROM node_runs WHERE workflow_run_id = 'run-1'
             AND workflow_node_key = ? AND attempt = 2`,
        )
        .get(nodeKey) as { c: number }
      expect(attempts.c).toBe(1)
      expect(h.workflow?.nodes.get(nodeRunId as string)?.status).toBe('failed')
      expect(
        (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
      ).toBe('completed')
    })

    it('K9: all effects already applied + pending → replay is a no-op then completed', async () => {
      const h = await harness({ workflow: true })
      const { executionId, nodeRunId } = seedExecution(h, {
        executionStatus: 'succeeded',
        nodeStatus: 'succeeded',
        recoveryState: {
          terminalProcessing: { state: 'pending', source: 'event_observed' },
        },
      })
      const logsBefore = h.logs.list(executionId).length
      const result = h.executions.processTerminalBacklog()
      expect(result.failures).toEqual([])
      expect(h.logs.list(executionId)).toHaveLength(logsBefore)
      expect(h.workflow?.nodes.get(nodeRunId as string)?.status).toBe('succeeded')
      expect(
        (readRecoveryState(h, executionId).terminalProcessing as { state: string }).state,
      ).toBe('completed')
    })
  })

  it('X1: compensation chain runs synchronously (no event-loop yield)', async () => {
    const h = await harness()
    seedExecution(h, {
      executionStatus: 'pending',
      recoveryState: { queued: true },
    })
    let microtasks = 0
    queueMicrotask(() => {
      microtasks += 1
    })
    h.executions.discardQueuedOnStartup()
    // 补偿链（TX1 + 桥接 + 验证 + completed）在同一宏任务内完成。
    expect(microtasks).toBe(0)
  })

  it('X2: nested BEGIN is rejected — bridge must never run inside TX1', async () => {
    const h = await harness()
    h.db.exec('BEGIN IMMEDIATE')
    try {
      expect(() => h.db.exec('BEGIN IMMEDIATE')).toThrow(/within a transaction/)
    } finally {
      h.db.exec('ROLLBACK')
    }
  })

  it('X3: discard keeps queued keys and writes completed (merge semantics)', async () => {
    const h = await harness()
    const { executionId } = seedExecution(h, {
      executionStatus: 'pending',
      recoveryState: { queued: true, queuedAt: NOW },
    })
    h.executions.discardQueuedOnStartup()
    const state = readRecoveryState(h, executionId)
    expect(state.queued).toBe(true)
    expect(state.terminalProcessing).toMatchObject({ state: 'completed' })
    // 队列查询不再命中终态行。
    expect(h.executions.list().find((e) => e.id === executionId)?.status).toBe('failed')
  })

  it('R1: repeated bridge invocation creates the retry attempt exactly once', async () => {
    const h = await harness({ workflow: true, maxAttempts: 2 })
    if (!h.workflow) throw new Error('missing workflow harness')
    const execution = await h.executions.startForNode(h.workflow.nodeRunId, {
      agentId: h.agentId,
      prompt: 'hello',
    })
    h.executions.handleRuntimeEvent(
      exitedEvent(execution.id, { exitCode: 1, signal: null, reason: 'exited' }),
    )
    const failed = h.executions.get(execution.id)
    h.workflow.bridge.onExecutionFinished(failed)
    const attempts = h.db
      .prepare(
        `SELECT COUNT(*) AS c FROM node_runs WHERE workflow_run_id = 'run-1'
           AND workflow_node_key = 'task_1' AND attempt = 2`,
      )
      .get() as { c: number }
    expect(attempts.c).toBe(1)
  })

  it('R1: retry-attempt creation failure rolls back the node failure', async () => {
    const h = await harness({ workflow: true, maxAttempts: 2 })
    if (!h.workflow) throw new Error('missing workflow harness')
    const execution = await h.executions.startForNode(h.workflow.nodeRunId, {
      agentId: h.agentId,
      prompt: 'hello',
    })
    const nodes = h.workflow.nodes as unknown as { create: (...args: unknown[]) => unknown }
    const originalCreate = nodes.create
    nodes.create = () => {
      throw new Error('simulated create failure')
    }
    try {
      h.executions.handleRuntimeEvent(
        exitedEvent(execution.id, { exitCode: 1, signal: null, reason: 'exited' }),
      )
      // 事务回滚：节点仍在 running（补偿返回 pending，不伪造收尾）。
      expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('running')
    } finally {
      nodes.create = originalCreate
    }
    // 重放补偿：节点失败 + attempt 恰好一条。
    h.executions.processTerminalBacklog()
    expect(h.workflow.nodes.get(h.workflow.nodeRunId)?.status).toBe('failed')
    const attempts = h.db
      .prepare(
        `SELECT COUNT(*) AS c FROM node_runs WHERE workflow_run_id = 'run-1'
           AND workflow_node_key = 'task_1' AND attempt = 2`,
      )
      .get() as { c: number }
    expect(attempts.c).toBe(1)
  })
})
