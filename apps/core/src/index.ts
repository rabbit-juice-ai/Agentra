import fs from 'node:fs'
import { PROTOCOL_VERSION } from '@agentra/protocol'
import { agentraHome, agentraPaths, createLogger, ensureDirs, isDirectRun } from '@agentra/shared'
import { assertCoreSocketAvailable } from './core-instance-guard'
import { DaemonClient } from './daemon/daemon-client'
import { ensureDaemon } from './daemon-launcher'
import { openDatabase } from './db/database'
import { migrate } from './db/migrations'
import { AgentRepository } from './db/repositories/agent-repository'
import { ApprovalRepository } from './db/repositories/approval-repository'
import { AssignmentRepository } from './db/repositories/assignment-repository'
import { AuditRepository } from './db/repositories/audit-repository'
import { BranchRunRepository } from './db/repositories/branch-run-repository'
import { ExecutionLogRepository } from './db/repositories/execution-log-repository'
import { ExecutionRepository } from './db/repositories/execution-repository'
import { NodeRunRepository } from './db/repositories/node-run-repository'
import { ProviderRepository } from './db/repositories/provider-repository'
import { ReworkRequestRepository } from './db/repositories/rework-request-repository'
import { SessionRepository } from './db/repositories/session-repository'
import { TeamRepository } from './db/repositories/team-repository'
import { WorkRepository } from './db/repositories/work-repository'
import { WorkflowEventRepository } from './db/repositories/workflow-event-repository'
import { WorkflowRepository } from './db/repositories/workflow-repository'
import { WorkflowRunRepository } from './db/repositories/workflow-run-repository'
import { coreMethods } from './rpc/methods'
import { startWsServer } from './rpc/ws-server'
import { AgentService } from './services/agent-service'
import { AssignmentService } from './services/assignment-service'
import { CoreEventHub } from './services/event-hub'
import { ExecutionService } from './services/execution-service'
import { ProviderRegistry } from './services/provider-registry'
import { TeamService } from './services/team-service'
import { WorkService } from './services/work-service'
import { WorkdirLockService } from './services/workdir-lock-service'
import { WorkflowDefinitionService } from './services/workflow-definition-service'
import { WorktreeService } from './services/worktree-service'
import { ApprovalService } from './workflow/approval-service'
import { WorkflowAssignmentResolver } from './workflow/assignment-resolver'
import { defaultDispatchGates } from './workflow/dispatch-gates'
import { WorkflowEngine } from './workflow/engine'
import { WorkflowEventRecorder } from './workflow/event-recorder'
import { WorkflowExecutionBridge } from './workflow/execution-bridge'
import {
  createAgentCapacityPort,
  createProviderAvailabilityPort,
  createWorkdirAvailabilityPort,
} from './workflow/ports'
import { PublishedDefinitionProvider } from './workflow/published-definition-provider'
import { WorkflowRecoveryService } from './workflow/recovery-service'
import { ReworkService } from './workflow/rework-service'
import { WorkflowRunQueryService } from './workflow/run-query-service'
import { WorkflowRunService } from './workflow/run-service'
import { WorkflowScheduler } from './workflow/scheduler'

const VERSION = '0.1.0'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('core')

  // Core 单实例守卫：已有活 Core 就拒绝启动，绝不 unlink 掉别人的 socket。
  // 产品路径由 Electron 单实例锁保护；这里覆盖 dev:core / QA 脚本 / 非 Electron 部署。
  try {
    await assertCoreSocketAvailable(paths.coreSocket)
  } catch (error) {
    logger.error('core refused to start: another instance is live', {
      socket: paths.coreSocket,
      error: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  }

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
  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const auditRepository = new AuditRepository(db)
  const providerRepository = new ProviderRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const executionLogRepository = new ExecutionLogRepository(db)
  const workflowRepository = new WorkflowRepository(db)
  const workflowRunRepository = new WorkflowRunRepository(db)
  const branchRunRepository = new BranchRunRepository(db)
  const nodeRunRepository = new NodeRunRepository(db)
  const reworkRequestRepository = new ReworkRequestRepository(db)
  const approvalRepository = new ApprovalRepository(db)
  const workflowEventRepository = new WorkflowEventRepository(db)

  const hub = new CoreEventHub()
  const runtime = new DaemonClient(paths.daemonSocket, logger)
  const registry = new ProviderRegistry(providerRepository, runtime, logger)
  await registry.refreshQuietly()

  const agentService = new AgentService(db, agentRepository, providerRepository)
  const locks = new WorkdirLockService(db)
  // Core 启动即回收陈旧锁（上一次 Core 被 kill -9 之后留下的）。
  // 身份不可读时只按 holder_pid 死亡回收，并在日志里标明 degraded。
  const purged = locks.purgeStale()
  logger.info('workdir locks purged', {
    reclaimed: purged.reclaimed,
    retained: purged.retained,
    identityStatus: purged.identity.status,
  })
  if (purged.identity.status === 'unknown') {
    logger.warn('workdir lock boot identity unavailable; identity-based reclaim disabled', {
      reason: purged.identity.reason,
    })
  }

  const worktrees = new WorktreeService(
    db,
    workRepository,
    new AssignmentRepository(db),
    paths.worktrees,
  )
  const teamService = new TeamService(db, teamRepository, agentRepository)
  const workService = new WorkService(db, workRepository, teamRepository, auditRepository)
  const assignmentService = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    sessionRepository,
  )
  const workflowService = new WorkflowDefinitionService(db, workflowRepository)
  const workflowRunQuery = new WorkflowRunQueryService(
    workflowRunRepository,
    branchRunRepository,
    nodeRunRepository,
  )
  let workflowEngine: WorkflowEngine | undefined
  const executionService = new ExecutionService({
    db,
    runtime,
    registry,
    works: workRepository,
    worktrees,
    locks,
    assignments: assignmentRepository,
    agents: agentRepository,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: executionLogRepository,
    hub,
    scratchRoot: paths.scratch,
    logger,
    onExecutionFinished: (execution) => workflowEngine?.onExecutionFinished(execution),
  })

  // ---- Workflow Engine 内部装配（S4-7；执行入口仍不暴露 RPC） ----
  const workflowAssignmentResolver = new WorkflowAssignmentResolver(assignmentRepository)
  const publishedDefinitions = new PublishedDefinitionProvider(workflowRepository)
  const workflowRunService = new WorkflowRunService(
    db,
    workflowRunRepository,
    branchRunRepository,
    nodeRunRepository,
    workRepository,
    publishedDefinitions,
    workflowAssignmentResolver,
  )
  const workflowEventRecorder = new WorkflowEventRecorder(
    workflowEventRepository,
    undefined,
    logger,
  )
  const reworkService = new ReworkService({
    db,
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    reworks: reworkRequestRepository,
    approvals: approvalRepository,
    definitions: publishedDefinitions,
    events: { publish: (event) => workflowEventRecorder.publishRework(event) },
  })
  const approvalService = new ApprovalService(
    db,
    approvalRepository,
    nodeRunRepository,
    branchRunRepository,
    undefined,
    reworkService,
  )
  const workflowBridge = new WorkflowExecutionBridge({
    runs: workflowRunRepository,
    nodes: nodeRunRepository,
    works: workRepository,
    worktrees,
    definitions: publishedDefinitions,
    resolver: workflowAssignmentResolver,
    executions: executionService,
    logger,
  })
  const workflowScheduler = new WorkflowScheduler({
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    definitions: publishedDefinitions,
    gates: defaultDispatchGates({
      agentCapacity: createAgentCapacityPort({
        resolver: workflowAssignmentResolver,
        agents: agentRepository,
        executions: executionRepository,
      }),
      providerAvailability: createProviderAvailabilityPort(registry),
      workdirAvailability: createWorkdirAvailabilityPort({
        works: workRepository,
        locks,
      }),
      inputArtifacts: { isAvailable: () => true },
    }),
    onNodeStarted: (context) => workflowEngine?.onNodeStarted(context),
    logger,
  })
  workflowEngine = new WorkflowEngine({
    db,
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    definitions: publishedDefinitions,
    approvals: approvalService,
    scheduler: workflowScheduler,
    bridge: workflowBridge,
    rework: reworkService,
    runService: workflowRunService,
    executions: executionService,
    eventSink: workflowEventRecorder,
    logger,
  })
  const workflowRecovery = new WorkflowRecoveryService(
    workflowRunRepository,
    branchRunRepository,
    nodeRunRepository,
    executionRepository,
    workflowScheduler,
    (execution) => workflowEngine?.onExecutionFinished(execution),
    logger,
  )

  // 上次运行遗留的排队任务：丢弃并标记，不自动恢复（从未启动过进程，补跑等于静默产生副作用）。
  const discardedQueued = executionService.discardQueuedOnStartup()
  if (discardedQueued > 0) {
    logger.info('discarded queued executions on startup', { count: discardedQueued })
  }

  // 先订阅再对外提供 RPC：避免漏掉启动瞬间的执行事件。
  runtime.subscribe(
    (event) => executionService.handleRuntimeEvent(event),
    () => {
      void (async () => {
        try {
          await executionService.reconcile()
          const report = await workflowRecovery.recover()
          logger.info('workflow recovery completed', {
            runs: report.runs,
            branches: report.branches,
            reconciliationRequired: report.nodesMarkedReconciliationRequired.length,
            runsKicked: report.runsKicked.length,
          })
        } catch (error) {
          logger.error('workflow recovery failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
  )

  fs.writeFileSync(
    paths.corePid,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
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
      teams: teamService,
      works: workService,
      assignments: assignmentService,
      worktrees,
      workflows: workflowService,
      workflowRuns: workflowRunQuery,
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
