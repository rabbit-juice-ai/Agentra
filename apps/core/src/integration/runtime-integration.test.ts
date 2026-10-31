import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Execution, RuntimeEvent } from '@agentra/protocol'
import { FAKE_CLAUDE_PATH } from '@agentra/runtime-cli'
import { type AgentraPaths, agentraPaths, ensureDirs } from '@agentra/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DaemonClient } from '../daemon/daemon-client'
import { ensureDaemon } from '../daemon-launcher'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { AgentService } from '../services/agent-service'
import { CoreEventHub } from '../services/event-hub'
import { ExecutionService } from '../services/execution-service'
import { ProviderRegistry } from '../services/provider-registry'
import { WorkdirLockService } from '../services/workdir-lock-service'
import { WorktreeService } from '../services/worktree-service'

/**
 * Core ↔ Daemon 集成：真实 daemon 进程 + 真实 NDJSON/UDS + fake CLI 夹具。
 * 覆盖：发现 → 启动 → 实时输出 → 正常完成 → kill -9 崩溃检测。
 */
describe('core ↔ daemon runtime integration', () => {
  let home: string
  let paths: AgentraPaths
  let db: Database
  let runtime: DaemonClient
  let service: ExecutionService
  let agentId: string
  let daemonPid: number | null = null
  const received: RuntimeEvent[] = []

  beforeAll(async () => {
    // 短前缀：macOS 临时目录较长，UDS 路径必须留在 sun_path 预算内。
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-int-'))
    paths = agentraPaths(home)
    ensureDirs(paths)
    const env = {
      ...process.env,
      AGENTRA_DATA_DIR: home,
      AGENTRA_CLAUDE_PATH: FAKE_CLAUDE_PATH,
    }
    await ensureDaemon(paths, env)
    try {
      const pidFile = JSON.parse(fs.readFileSync(paths.daemonPid, 'utf8')) as { pid: number }
      daemonPid = pidFile.pid
    } catch {
      daemonPid = null
    }

    db = openDatabase(paths.database)
    migrate(db)
    const providerRepository = new ProviderRepository(db)
    const agentRepository = new AgentRepository(db)
    runtime = new DaemonClient(paths.daemonSocket)
    const registry = new ProviderRegistry(providerRepository, runtime)
    await registry.refresh()

    const agentService = new AgentService(db, agentRepository, providerRepository)
    agentId = agentService.create({
      name: 'Integration Worker',
      role: 'engineer',
      toolPermissions: { version: 1, allow: ['Read'], deny: [] },
    }).id

    service = new ExecutionService({
      db,
      runtime,
      registry,
      works: new WorkRepository(db),
      worktrees: new WorktreeService(db, new WorkRepository(db), path.join(home, 'worktrees')),
      locks: new WorkdirLockService(db),
      agents: agentRepository,
      sessions: new SessionRepository(db),
      executions: new ExecutionRepository(db),
      logs: new ExecutionLogRepository(db),
      hub: new CoreEventHub(),
      scratchRoot: paths.scratch,
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon subscription timeout')), 10_000)
      runtime.subscribe(
        (event) => {
          received.push(event)
          service.handleRuntimeEvent(event)
        },
        () => {
          clearTimeout(timer)
          resolve()
          void service.reconcile()
        },
      )
    })
  }, 30_000)

  afterAll(() => {
    runtime?.close()
    try {
      db?.close()
    } catch {
      // 忽略。
    }
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM')
      } catch {
        // 已退出。
      }
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function waitForTerminal(executionId: string, timeoutMs = 20_000): Promise<Execution> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const execution = service.get(executionId)
      if (['succeeded', 'failed', 'cancelled', 'crashed'].includes(execution.status)) {
        return execution
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`execution ${executionId} did not finish within ${timeoutMs}ms`)
  }

  it('discovers the provider through the daemon and persists runtime_providers', () => {
    const provider = new ProviderRepository(db).get('claude-code')
    expect(provider).toMatchObject({
      providerName: 'Claude Code',
      executablePath: path.resolve(FAKE_CLAUDE_PATH),
      version: '9.9.9',
      healthStatus: 'healthy',
      capabilities: expect.objectContaining({ checkpoint: 'unsupported', interrupt: 'native' }),
    })
  })

  it('runs an execution end-to-end: output captured, exit_code=0, status succeeded', async () => {
    const execution = await service.start({ agentId, prompt: 'hello integration' })
    const finished = await waitForTerminal(execution.id)

    expect(finished.status).toBe('succeeded')
    expect(finished.exitCode).toBe(0)
    expect(finished.agentId).toBe(agentId)

    const logs = service.logsFor({ executionId: execution.id })
    const stdout = logs.filter((log) => log.stream === 'stdout')
    expect(stdout.length).toBeGreaterThanOrEqual(1)
    expect(stdout.some((log) => log.content.includes('echo:hello integration'))).toBe(true)

    const systemLogs = logs.filter((log) => log.stream === 'system').map((log) => log.content)
    expect(systemLogs.some((content) => content.includes('execution.exited'))).toBe(true)
    expect(systemLogs.some((content) => content.includes('execution.state'))).toBe(true)

    // 事件确实经由 daemon 订阅连接到达 Core。
    expect(received.some((event) => event.aggregateId === execution.id)).toBe(true)
  }, 30_000)

  it('detects a SIGKILLed execution process within 10 seconds and records crashed', async () => {
    const started = Date.now()
    const execution = await service.start({ agentId, prompt: 'CRASH' })
    const finished = await waitForTerminal(execution.id, 10_000)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(finished.status).toBe('crashed')
    expect(finished.exitCode).toBeNull()

    const logs = service.logsFor({ executionId: execution.id })
    const systemLogs = logs.filter((log) => log.stream === 'system').map((log) => log.content)
    const exitedLog = systemLogs.find((content) => content.includes('execution.exited'))
    expect(exitedLog).toBeDefined()
    expect(exitedLog).toContain('SIGKILL')
  }, 30_000)

  it('cancels a long-running execution through the daemon', async () => {
    const execution = await service.start({ agentId, prompt: 'HANG' })
    const cancelled = await service.cancel({ executionId: execution.id })
    expect(cancelled.status).toBe('cancelled')
    const finished = await waitForTerminal(execution.id, 10_000)
    expect(finished.status).toBe('cancelled')
  }, 30_000)
})
