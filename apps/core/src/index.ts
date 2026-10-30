import fs from 'node:fs'
import { agentraHome, agentraPaths, createLogger, ensureDirs, isDirectRun } from '@agentra/shared'
import { DaemonClient } from './daemon/daemon-client'
import { ensureDaemon } from './daemon-launcher'
import { openDatabase } from './db/database'
import { migrate } from './db/migrations'
import { AgentRepository } from './db/repositories/agent-repository'
import { ExecutionLogRepository } from './db/repositories/execution-log-repository'
import { ExecutionRepository } from './db/repositories/execution-repository'
import { ProviderRepository } from './db/repositories/provider-repository'
import { SessionRepository } from './db/repositories/session-repository'
import { coreMethods } from './rpc/methods'
import { startWsServer } from './rpc/ws-server'
import { AgentService } from './services/agent-service'
import { CoreEventHub } from './services/event-hub'
import { ExecutionService } from './services/execution-service'
import { ProviderRegistry } from './services/provider-registry'

const VERSION = '0.1.0'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('core', paths.coreLog)

  // 启动链：Core 负责 Daemon 存活（探活优先，附着已有实例）。
  const daemon = await ensureDaemon(paths, env)
  logger.info('daemon ensured', { spawned: daemon.spawned, socket: paths.daemonSocket })

  // 数据库：Core 独占业务库（Daemon 不访问），启动即迁移。
  const db = openDatabase(paths.database)
  const migration = migrate(db)
  logger.info('database ready', {
    file: paths.database,
    fromVersion: migration.from,
    toVersion: migration.to,
    applied: migration.applied,
  })

  const agentRepository = new AgentRepository(db)
  const providerRepository = new ProviderRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const executionLogRepository = new ExecutionLogRepository(db)

  const hub = new CoreEventHub()
  const runtime = new DaemonClient(paths.daemonSocket, logger)
  const registry = new ProviderRegistry(providerRepository, runtime, logger)
  await registry.refreshQuietly()

  const agentService = new AgentService(db, agentRepository, providerRepository)
  const executionService = new ExecutionService({
    db,
    runtime,
    registry,
    agents: agentRepository,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: executionLogRepository,
    hub,
    scratchRoot: paths.scratch,
    logger,
  })

  // 先订阅再对外提供 RPC：避免漏掉启动瞬间的执行事件。
  runtime.subscribe(
    (event) => executionService.handleRuntimeEvent(event),
    () => {
      void executionService.reconcile().catch((error: unknown) => {
        logger.error('execution reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
  )

  fs.writeFileSync(
    paths.corePid,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: '1',
      socketPath: paths.coreSocket,
    }),
    { mode: 0o600 },
  )

  const server = await startWsServer(
    paths.coreSocket,
    coreMethods(VERSION, paths.daemonSocket, {
      agents: agentService,
      registry,
      executions: executionService,
      hub,
    }),
  )
  logger.info('core started', {
    socketPath: server.socketPath,
    pid: process.pid,
    version: VERSION,
    daemonSpawned: daemon.spawned,
  })

  const shutdown = (signal: string) => {
    logger.info('core shutting down', { signal })
    runtime.close()
    server.close()
    try {
      db.close()
    } catch (error) {
      logger.warn('database close failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      fs.unlinkSync(paths.corePid)
    } catch {
      // 忽略。
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 被直接运行时启动（tsx 源码 / esbuild 打包产物）；被测试导入时不自动启动。
if (isDirectRun(import.meta.url)) {
  void main()
}
