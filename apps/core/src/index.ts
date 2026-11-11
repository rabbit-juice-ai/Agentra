import fs from 'node:fs'
import { PROTOCOL_VERSION } from '@agentra/protocol'
import { agentraHome, agentraPaths, createLogger, ensureDirs, isDirectRun } from '@agentra/shared'
import { assertCoreSocketAvailable } from './core-instance-guard'
import { DaemonClient } from './daemon/daemon-client'
import { ensureDaemon } from './daemon-launcher'
import { openDatabase } from './db/database'
import { MIGRATIONS, migrate } from './db/migrations'
import { AgentRepository } from './db/repositories/agent-repository'
import { ApprovalRepository } from './db/repositories/approval-repository'
import { ArtifactRepository } from './db/repositories/artifact-repository'
import { AssignmentRepository } from './db/repositories/assignment-repository'
import { AuditRepository } from './db/repositories/audit-repository'
import { BackupRepository } from './db/repositories/backup-repository'
import { BranchRunRepository } from './db/repositories/branch-run-repository'
import { CheckpointRepository } from './db/repositories/checkpoint-repository'
import {
  PlannerMessageRepository,
  TeamTaskMessageRepository,
  TeamTaskRunRepository,
  TeamTaskRunStepRepository,
  TeamTaskSubtaskRepository,
} from './db/repositories/collaboration-repository'
import { ExecutionLogRepository } from './db/repositories/execution-log-repository'
import { ExecutionRepository } from './db/repositories/execution-repository'
import { NodeAssignmentOverrideRepository } from './db/repositories/node-assignment-override-repository'
import { NodeRunRepository } from './db/repositories/node-run-repository'
import {
  PlanDispatchRepository,
  PlanStartAttemptRepository,
  PlanTaskAssignmentRepository,
} from './db/repositories/plan-dispatch-repository'
import {
  PlanCommentRepository,
  PlanRepository,
  PlanThreadRepository,
  PlanVersionRepository,
} from './db/repositories/plan-repository'
import { ProjectRepository } from './db/repositories/project-repository'
import { ProviderRepository } from './db/repositories/provider-repository'
import { RecoveryAttemptRepository } from './db/repositories/recovery-attempt-repository'
import { ReworkRequestRepository } from './db/repositories/rework-request-repository'
import { SessionRepository } from './db/repositories/session-repository'
import { SkillRepository } from './db/repositories/skill-repository'
import { TaskMemoryRepository } from './db/repositories/task-memory-repository'
import { TeamRepository } from './db/repositories/team-repository'
import { WorkRepository } from './db/repositories/work-repository'
import { WorkflowEventRepository } from './db/repositories/workflow-event-repository'
import { WorkflowRepository } from './db/repositories/workflow-repository'
import { WorkflowRunRepository } from './db/repositories/workflow-run-repository'
import { BootLock, BootLockError } from './lifecycle/boot-lock'
import { DrainCoordinator, type DrainResult } from './lifecycle/drain-coordinator'
import { MaintenanceController } from './lifecycle/maintenance-controller'
import { PersistenceGate } from './lifecycle/persistence-gate'
import { type RestoreJournal, RestoreJournalStore } from './lifecycle/restore-journal'
import { startBootSocket } from './rpc/boot-socket'
import { coreMethods } from './rpc/methods'
import { startWsServer } from './rpc/ws-server'
import { AgentDesignerService } from './services/agent-designer-service'
import { AgentService } from './services/agent-service'
import { ApprovalRpcService } from './services/approval-rpc-service'
import { ArtifactRpcService } from './services/artifact-rpc-service'
import { ArtifactService } from './services/artifact-service'
import { AssignmentService } from './services/assignment-service'
import { BackupRestorePrecheckService } from './services/backup-restore-precheck-service'
import { BackupRpcService } from './services/backup-rpc-service'
import { BackupService } from './services/backup-service'
import { CheckpointService } from './services/checkpoint-service'
import { CoreEventHub } from './services/event-hub'
import { ExecutionService } from './services/execution-service'
import { proxyDaemonHealth } from './services/health'
import { PlanAssignmentService } from './services/plan-assignment-service'
import { PlanService } from './services/plan-service'
import { PlanStartService } from './services/plan-start-service'
import { PlannerChatService } from './services/planner-chat-service'
import { PlannerService } from './services/planner-service'
import { ProjectService } from './services/project-service'
import { ProviderRegistry } from './services/provider-registry'
import { RecoveryService } from './services/recovery-service'
import { RestoreArchiveService } from './services/restore-archive-service'
import { RestoreBootService } from './services/restore-boot-service'
import { RestoreCoordinator } from './services/restore-coordinator'
import { RestoreExecutor } from './services/restore-executor'
import { SkillService } from './services/skill-service'
import { TaskMemoryService } from './services/task-memory-service'
import { TeamCollaborationService } from './services/team-collaboration-service'
import { TeamDispatchService } from './services/team-dispatch-service'
import { TeamService } from './services/team-service'
import { WorkService } from './services/work-service'
import { currentBootUuid, WorkdirLockService } from './services/workdir-lock-service'
import { WorkflowDefinitionService } from './services/workflow-definition-service'
import { WorkspaceFilesService } from './services/workspace-files-service'
import { WorktreeService } from './services/worktree-service'
import { createApprovalGateChecker } from './workflow/approval-gate'
import { ApprovalService } from './workflow/approval-service'
import { ArtifactExchange } from './workflow/artifact-exchange'
import { WorkflowAssignmentResolver } from './workflow/assignment-resolver'
import { approvalGate, defaultDispatchGates } from './workflow/dispatch-gates'
import { WorkflowEngine } from './workflow/engine'
import { WorkflowEventRecorder } from './workflow/event-recorder'
import { WorkflowExecutionBridge } from './workflow/execution-bridge'
import { WorkflowFairDispatcher } from './workflow/fair-dispatcher'
import { WorkflowNodeRecoveryService } from './workflow/node-recovery-service'
import {
  createAgentCapacityPort,
  createProviderAvailabilityPort,
  createWorkdirAvailabilityPort,
} from './workflow/ports'
import { PublishedDefinitionProvider } from './workflow/published-definition-provider'
import { WorkflowRecoveryService } from './workflow/recovery-service'
import { WorkflowRecoveryWorktreeService } from './workflow/recovery-worktree'
import { ReworkService } from './workflow/rework-service'
import { WorkflowRunQueryService } from './workflow/run-query-service'
import { WorkflowRunService } from './workflow/run-service'
import { WorkflowScheduler } from './workflow/scheduler'

const VERSION = '0.1.0'

/** S55-2B-1A（P1-1）：SIGTERM 排空在途写的 deadline。不等待 Agent Task 自然结束。 */
const SHUTDOWN_DRAIN_DEADLINE_MS = 5_000

/** S55-2B-1B：启动期等待 Daemon 订阅 ACK 的总预算。 */
const DAEMON_CONNECT_TIMEOUT_MS = 30_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type ShutdownDeps = {
  signal: string
  maintenance: Pick<MaintenanceController, 'beginShuttingDown'>
  drain: Pick<DrainCoordinator, 'close' | 'drain'>
  closeRuntime: () => void
  closeServer: () => void
  /** S55-2B-1B：最小 health/status socket（recovery_locked 期间保留，退出时关闭）。 */
  closeBootSocket?: () => void
  closeDb: () => void
  removePidFile: () => void
  /** S55-2B-1B：释放 O_EXLOCK fd（只 close，不 unlink 锁文件）。 */
  releaseLock?: () => void
  exit: (code: number) => void
  logger: {
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
    error: (message: string, data?: Record<string, unknown>) => void
  }
  drainDeadlineMs?: number
}

/**
 * S55-2B-1A（P1-1）：正常 SIGTERM 的关闭序列。
 *
 * 顺序：shutting_down 门禁 → 关闭新 lease → 等 deadline 排空在途写 →
 * 依次关闭 Runtime / RPC Server / DB → 清理 pid 文件 → 退出。
 * 不等待 Agent Task、不干预 Daemon、不 cancel / retry Execution。
 * drain 异常或超时按失败记录并输出诊断快照，但不伪装成成功、不无限等待，
 * 仍按既定策略继续执行全部清理步骤（CTO 行为要求 3 / 4 / 5 / 7）。
 */
export async function shutdownWithDrain(deps: ShutdownDeps): Promise<void> {
  const {
    signal,
    maintenance,
    drain,
    closeRuntime,
    closeServer,
    closeBootSocket,
    closeDb,
    removePidFile,
    releaseLock,
    exit,
    logger,
    drainDeadlineMs = SHUTDOWN_DRAIN_DEADLINE_MS,
  } = deps

  logger.info('core shutting down', { signal })
  maintenance.beginShuttingDown(signal)
  drain.close()

  let drainResult: DrainResult | null = null
  try {
    drainResult = await drain.drain(drainDeadlineMs)
  } catch (error) {
    // 排空本身失败不能伪装成成功；记录后按既定策略继续退出（不无限等待）。
    logger.error('shutdown drain failed', { signal, error: errorMessage(error) })
  }
  if (drainResult && !drainResult.ok) {
    logger.error('shutdown drain timed out; in-flight operations may be interrupted', {
      signal,
      deadlineMs: drainDeadlineMs,
      timedOut: drainResult.timedOut,
      snapshot: drainResult.snapshot,
    })
  } else if (drainResult) {
    logger.info('shutdown drain completed', { signal, snapshot: drainResult.snapshot })
  }

  closeRuntime()
  closeServer()
  try {
    closeBootSocket?.()
  } catch (error) {
    logger.warn('boot socket close failed', { error: errorMessage(error) })
  }
  try {
    closeDb()
  } catch (error) {
    logger.warn('database close failed', { error: errorMessage(error) })
  }
  try {
    removePidFile()
  } catch {
    // 清理失败不阻止退出；pid 文件残留由启动守卫按 pid 存活判断处理。
  }
  try {
    releaseLock?.()
  } catch (error) {
    logger.warn('boot lock release failed', { error: errorMessage(error) })
  }
  exit(0)
}

/**
 * S55-2B-1A（P1-1）：shutdown 去重包装。第一个信号触发执行，后续信号只记录日志。
 * 重复触发不会重复进入关闭序列（CTO 行为要求 6）。
 */
export function createShutdownHandler(
  run: (signal: string) => Promise<void>,
  logger: ShutdownDeps['logger'],
): (signal: string) => void {
  let started = false
  return (signal: string) => {
    if (started) {
      logger.warn('shutdown already in progress; ignoring repeated signal', { signal })
      return
    }
    started = true
    void run(signal)
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('core')
  const maintenance = new MaintenanceController()
  const drain = new DrainCoordinator()
  // S55-2C：Artifact/Backup/Worktree 文件写入的统一 lease 门禁；Restore 编排在
  // pre_restore 完成后 close + closeAndDrain，然后才允许 checkpoint/handoff。
  const persistence = new PersistenceGate(drain)

  // S55-2B-1B：启动即进入 booting。normal 是业务 RPC 唯一放行态；
  // booting/recovering 与 recovery_locked 同为 lockdown 授权。
  maintenance.enterBooting('boot')

  // 1) BootLock（O_EXLOCK 内核锁）：同一数据根唯一 Core；文件永不 unlink。
  const bootLock = new BootLock(paths.coreLock)
  try {
    const identity = currentBootUuid()
    const owner = bootLock.acquire({
      startedAt: new Date().toISOString(),
      bootUuid: identity.status === 'known' ? identity.uuid : null,
      protocolVersion: PROTOCOL_VERSION,
    })
    logger.info('core boot lock acquired', {
      lockPath: paths.coreLock,
      pid: owner.pid,
      bootUuid: owner.bootUuid,
    })
  } catch (error) {
    if (error instanceof BootLockError) {
      logger.error('core refused to start: boot lock unavailable', {
        code: error.code,
        error: error.message,
        detail: error.detail,
      })
    } else {
      logger.error('core refused to start: boot lock failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    process.exit(1)
  }

  // 2) 旧版 Core（无 boot lock）仍活着的防御：业务 socket 探活。
  // 产品路径由 Electron 单实例锁保护；这里覆盖 dev:core / QA 脚本 / 非 Electron 部署。
  try {
    await assertCoreSocketAvailable(paths.coreSocket)
  } catch (error) {
    logger.error('core refused to start: another instance is live', {
      socket: paths.coreSocket,
      error: error instanceof Error ? error.message : String(error),
    })
    bootLock.release()
    process.exit(1)
  }

  // 3) 最小 health/status socket：从此刻起可探活并查询启动阶段；
  //    物理方法表只有 core.health / core.maintenance.status。
  let bootServer: Awaited<ReturnType<typeof startBootSocket>>
  try {
    bootServer = await startBootSocket(
      paths.coreBootSocket,
      VERSION,
      paths.daemonSocket,
      maintenance,
      drain,
    )
  } catch (error) {
    logger.error('core refused to start: boot socket bind failed', {
      socket: paths.coreBootSocket,
      error: error instanceof Error ? error.message : String(error),
    })
    bootLock.release()
    process.exit(1)
  }

  // 4) PID 文件：覆盖整个启动窗口（Desktop 以 pidAlive 判定启动中）。
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

  // 4.5) S55-2C：恢复启动模式。必须在 openDatabase 之前完成判定与文件替换；
  //      active marker / Journal 是唯一事务依据，任何无法证明的现场一律 recovery_locked。
  const restoreJournalPaths = {
    restoreRoot: paths.restore,
    journalA: paths.restoreJournalA,
    journalB: paths.restoreJournalB,
    activeMarker: paths.restoreActiveMarker,
    archiveRoot: paths.restoreArchive,
  }
  const restoreStore = new RestoreJournalStore(restoreJournalPaths)
  const restoreArchive = new RestoreArchiveService(restoreStore, paths.restoreRetired)
  const restoreBoot = new RestoreBootService(
    restoreStore,
    restoreArchive,
    paths.restoreArchive,
    logger,
  )
  let restoredJournal: RestoreJournal | null = null
  try {
    const scene = restoreBoot.detect()
    if (scene.kind === 'locked') {
      logger.error('restore boot scene requires manual recovery', { reason: scene.reason })
      maintenance.enterRecoveryLocked(`restore_boot_${scene.reason}`)
      return
    }
    if (scene.kind === 'abandoned') {
      restoreBoot.archiveAbandoned(scene.journal)
      logger.warn('unactivated restore journal archived; continuing normal boot', {
        journalId: scene.journal.journalId,
      })
    } else if (scene.kind === 'aborted') {
      restoreBoot.abortBeforeReplacement(scene.journal)
      logger.warn('restore aborted before replacement; continuing normal boot', {
        journalId: scene.journal.journalId,
      })
    } else if (scene.kind === 'terminal') {
      restoreBoot.finalizeTerminal(scene.journal)
      logger.info('restore terminal scene finalized', {
        journalId: scene.journal.journalId,
        phase: scene.phase,
      })
    } else if (scene.kind === 'forward') {
      const executor = new RestoreExecutor(paths, restoreStore, scene.journal, logger)
      const result = executor.execute()
      if (result.rolledBack) {
        restoreBoot.finalizeTerminal(result.journal)
        logger.warn('restore rolled back during boot recovery', {
          journalId: result.journal.journalId,
        })
      } else {
        restoredJournal = result.journal
        logger.info('restore file replacement completed during boot', {
          journalId: result.journal.journalId,
          phase: result.journal.phase,
        })
      }
    } else if (scene.kind === 'rollback') {
      const executor = new RestoreExecutor(paths, restoreStore, scene.journal, logger)
      const rolledBack = executor.resumeRollback()
      restoreBoot.finalizeTerminal(rolledBack)
      logger.warn('restore rollback completed during boot recovery', {
        journalId: rolledBack.journalId,
      })
    } else if (scene.kind === 'reconcile') {
      restoredJournal = scene.journal
      logger.info('restore boot resuming at reconciliation', {
        journalId: scene.journal.journalId,
        phase: scene.journal.phase,
      })
    }
  } catch (error) {
    logger.error('restore boot recovery failed; entering recovery_locked', {
      error: error instanceof Error ? error.message : String(error),
    })
    maintenance.enterRecoveryLocked('restore_boot_failed')
    return
  }

  // 5) Daemon / DB / migration。失败只清理本进程创建的资源（boot socket、pid、锁）。
  let daemon: Awaited<ReturnType<typeof ensureDaemon>>
  let db: ReturnType<typeof openDatabase>
  try {
    // 启动链：Core 负责 Daemon 存活（探活优先，附着已有实例）。
    daemon = await ensureDaemon(paths, env)
    logger.info('daemon ensured', { spawned: daemon.spawned, socket: paths.daemonSocket })

    // 数据库：Core 独占业务库（Daemon 不访问），启动即迁移。
    db = openDatabase(paths.database)
    const migration = migrate(db)
    logger.info('database ready', {
      file: paths.database,
      fromVersion: migration.from,
      toVersion: migration.to,
      applied: migration.applied,
    })
  } catch (error) {
    logger.error('core boot failed before services assembly', {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      bootServer.close()
    } catch {
      // 清理失败不掩盖原始错误。
    }
    try {
      fs.unlinkSync(paths.corePid)
    } catch {
      // 不存在即目标状态。
    }
    bootLock.release()
    process.exit(1)
  }

  const agentRepository = new AgentRepository(db)
  const skillRepository = new SkillRepository(db)
  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const taskMemoryRepository = new TaskMemoryRepository(db)
  const recoveryAttemptRepository = new RecoveryAttemptRepository(db)
  const projectRepository = new ProjectRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const auditRepository = new AuditRepository(db)
  const artifactRepository = new ArtifactRepository(db)
  const providerRepository = new ProviderRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const executionLogRepository = new ExecutionLogRepository(db)
  const workflowRepository = new WorkflowRepository(db)
  const workflowRunRepository = new WorkflowRunRepository(db)
  const branchRunRepository = new BranchRunRepository(db)
  const nodeRunRepository = new NodeRunRepository(db)
  const reworkRequestRepository = new ReworkRequestRepository(db)
  const planRepository = new PlanRepository(db)
  const planVersionRepository = new PlanVersionRepository(db)
  const planThreadRepository = new PlanThreadRepository(db)
  const planCommentRepository = new PlanCommentRepository(db)
  const planTaskAssignmentRepository = new PlanTaskAssignmentRepository(db)
  const planDispatchRepository = new PlanDispatchRepository(db)
  const planStartAttemptRepository = new PlanStartAttemptRepository(db)
  const plannerMessageRepository = new PlannerMessageRepository(db)
  const teamTaskMessageRepository = new TeamTaskMessageRepository(db)
  const teamTaskSubtaskRepository = new TeamTaskSubtaskRepository(db)
  const teamTaskRunRepository = new TeamTaskRunRepository(db)
  const teamTaskRunStepRepository = new TeamTaskRunStepRepository(db)
  const nodeAssignmentOverrideRepository = new NodeAssignmentOverrideRepository(db)
  const approvalRepository = new ApprovalRepository(db)
  const workflowEventRepository = new WorkflowEventRepository(db)

  const hub = new CoreEventHub()
  const runtime = new DaemonClient(paths.daemonSocket, logger, drain)
  const registry = new ProviderRegistry(providerRepository, runtime, logger, undefined, drain)
  await registry.refreshQuietly()

  const agentService = new AgentService(db, agentRepository, providerRepository, skillRepository)
  const skillService = new SkillService(db, skillRepository, agentRepository)
  const locks = new WorkdirLockService(db, undefined, undefined, undefined, auditRepository)
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
  const taskMemoryService = new TaskMemoryService({
    db,
    memories: taskMemoryRepository,
    audit: auditRepository,
  })
  const recoveryResultSink: { target: RecoveryService | null } = { target: null }
  const checkpointService = new CheckpointService({
    db,
    checkpoints: new CheckpointRepository(db),
    works: workRepository,
    executions: executionRepository,
    sessions: sessionRepository,
    assignments: assignmentRepository,
    nodes: nodeRunRepository,
    teamRuns: teamTaskRunRepository,
    workflowRuns: workflowRunRepository,
    artifacts: artifactRepository,
    logs: executionLogRepository,
    audit: auditRepository,
    agents: agentRepository,
    taskMemories: taskMemoryService,
    worktrees,
    teamMessages: teamTaskMessageRepository,
    artifactsRoot: paths.artifacts,
    onCheckpointResult: (event) => recoveryResultSink.target?.onCheckpointResult(event),
    logger,
  })
  try {
    checkpointService.retryPending(20)
  } catch (error) {
    logger.warn('checkpoint startup retry failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const workService = new WorkService(
    db,
    workRepository,
    teamRepository,
    auditRepository,
    undefined,
    (id, to, now) => {
      workflowEngine?.syncWorkState(id, to, now)
      if (to === 'cancelled')
        for (const run of workflowRunRepository.listByWork(id)) {
          for (const rework of reworkRequestRepository.listByRun(run.id)) {
            if (rework.status === 'requested' || rework.status === 'in_rework')
              reworkRequestRepository.transition(rework.id, [rework.status], 'cancelled', now)
          }
        }
    },
    projectRepository,
    taskMemoryService,
    (id, to, now) => {
      if (to !== 'completed') return
      try {
        checkpointService.createFinalDelivery(id, now)
      } catch (error) {
        logger.warn('final delivery checkpoint failed', {
          workId: id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )
  const projectService = new ProjectService(projectRepository, auditRepository)
  const assignmentService = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    sessionRepository,
  )
  const planAssignmentService = new PlanAssignmentService({
    db,
    assignments: planTaskAssignmentRepository,
    dispatches: planDispatchRepository,
    startAttempts: planStartAttemptRepository,
    teams: teamRepository,
    agents: agentRepository,
    threads: planThreadRepository,
    comments: planCommentRepository,
    audit: auditRepository,
  })
  const planStartEventSink: {
    target: PlanService | null
  } = { target: null }
  const workflowService = new WorkflowDefinitionService(db, workflowRepository)
  const workflowRunQuery = new WorkflowRunQueryService(
    workflowRunRepository,
    branchRunRepository,
    nodeRunRepository,
  )
  let workflowEngine: WorkflowEngine | undefined
  let workflowBridge: WorkflowExecutionBridge | undefined
  const executionService = new ExecutionService({
    db,
    runtime,
    registry,
    works: workRepository,
    worktrees,
    locks,
    assignments: assignmentRepository,
    agents: agentRepository,
    skills: skillRepository,
    teams: teamRepository,
    taskMemories: taskMemoryService,
    checkpoints: checkpointService,
    recoveries: recoveryAttemptRepository,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: executionLogRepository,
    nodeRuns: nodeRunRepository,
    hub,
    scratchRoot: paths.scratch,
    logger,
    maintenance,
    drain,
    audit: auditRepository,
    // S55-2B-1B：补偿链直调桥接（同步、无 kick）；engine 包装仅用于运行期 kick。
    onTerminalBridge: (execution) => workflowBridge?.onExecutionFinished(execution),
    onExecutionFinished: (execution) => workflowEngine?.onExecutionFinished(execution),
    workflowRuns: workflowRunRepository,
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
  const planThreadSink: { target: PlanService | null } = { target: null }
  const reworkService = new ReworkService({
    db,
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    reworks: reworkRequestRepository,
    approvals: approvalRepository,
    definitions: publishedDefinitions,
    audit: auditRepository,
    events: {
      publish: (event) => {
        workflowEventRecorder.publishRework(event)
        planThreadSink.target?.recordReworkEvent(event)
      },
    },
  })
  const approvalService = new ApprovalService(
    db,
    approvalRepository,
    nodeRunRepository,
    branchRunRepository,
    undefined,
    reworkService,
    auditRepository,
    {
      // S5-1：approval.decided 领域事件落 workflow_events；event_id 确定性，重复决策不重复写。
      // occurredAt 用载荷值（决策时刻，注入时钟），不用 sink 执行时刻。
      publish: (event) => {
        workflowEventRepository.append({
          eventId: `approval:${event.approvalId}:approval.decided:${event.round}`,
          workflowRunId: event.runId,
          nodeRunId: event.nodeRunId,
          eventType: 'approval.decided',
          payload: { decision: event.decision, round: event.round },
          occurredAt: event.occurredAt,
        })
      },
    },
    (runId) => {
      const run = workflowRunRepository.get(runId)
      return (
        !!run &&
        !['cancelled', 'completed', 'failed'].includes(run.status) &&
        ['active', 'paused'].includes(workRepository.get(run.workId)?.status ?? '')
      )
    },
  )
  const approvalRpc = new ApprovalRpcService(approvalService, approvalRepository)
  const artifactService = new ArtifactService(db, new ArtifactRepository(db), paths.artifacts, {
    get: (id) => workRepository.get(id),
  })
  const artifactRpc = new ArtifactRpcService(artifactService)
  const backupRepository = new BackupRepository(db)
  const backupService = new BackupService(
    db,
    backupRepository,
    new ArtifactRepository(db),
    auditRepository,
    paths.backups,
    paths.artifacts,
  )
  const backupRpc = new BackupRpcService(backupService)
  const backupPrecheck = new BackupRestorePrecheckService(
    backupRepository,
    paths.backups,
    paths.artifacts,
    Math.max(...MIGRATIONS.map((migration) => migration.version)),
  )
  const artifactExchange = new ArtifactExchange(
    executionLogRepository,
    artifactService,
    nodeRunRepository,
  )
  artifactExchange.nodesForExecution = (id) => {
    const nodeId = executionRepository.getNodeRunId(id)
    if (!nodeId) throw new Error('Execution has no node binding')
    return nodeId
  }
  artifactExchange.workIdForRun = (id) => {
    const run = workflowRunRepository.get(id)
    if (!run) throw new Error('Workflow Run missing')
    return run.workId
  }
  const plannerService = new PlannerService({
    agents: agentService,
    executions: executionService,
    works: workService,
    providers: registry,
    skills: skillRepository,
    teams: teamRepository,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    logger,
  })
  // Planner 是产品级系统 Agent：默认在 Core 启动时就创建/校正，不要求老板先去设置页手动创建。
  try {
    const plannerAgent = plannerService.ensureAgent()
    logger.info('planner agent ready', {
      id: plannerAgent.id,
      providerId: plannerAgent.defaultProviderId,
      model: plannerAgent.model,
    })
  } catch (error) {
    logger.warn('planner agent bootstrap failed; settings/chat will retry on demand', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const plannerEscalationSink: { target: PlannerChatService | null } = { target: null }
  const teamTaskCreationSink: { target: TeamCollaborationService | null } = { target: null }
  const teamCollaborationService = new TeamCollaborationService({
    db,
    works: workService,
    workRepository,
    taskMemories: taskMemoryService,
    checkpoints: checkpointService,
    teams: teamRepository,
    agents: agentRepository,
    assignments: assignmentService,
    executions: executionService,
    providers: registry,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    executionLogs: executionLogRepository,
    messages: teamTaskMessageRepository,
    subtasks: teamTaskSubtaskRepository,
    runs: teamTaskRunRepository,
    steps: teamTaskRunStepRepository,
    planner: {
      escalateFromTeam: (input) =>
        plannerEscalationSink.target?.escalateFromTeam(input) ?? Promise.resolve(),
    },
    hub,
    audit: auditRepository,
    logger,
  })
  const workflowRecoverySink: { target: WorkflowNodeRecoveryService | null } = { target: null }
  const recoveryService = new RecoveryService({
    db,
    attempts: recoveryAttemptRepository,
    works: workRepository,
    workService,
    checkpoints: checkpointService,
    executions: executionService,
    executionRepository,
    assignments: assignmentService,
    assignmentRepository,
    agents: agentRepository,
    teams: teamRepository,
    teamRuns: teamTaskRunRepository,
    teamSubtasks: teamTaskSubtaskRepository,
    teamMessages: teamTaskMessageRepository,
    taskMemories: taskMemoryService,
    audit: auditRepository,
    logger,
    onWorkflowAttemptSettled: ({ workflowRunId }) => {
      workflowRecoverySink.target?.reconcileRun(workflowRunId)
    },
  })
  recoveryResultSink.target = recoveryService
  recoveryService.subscribe(hub)
  const workflowNodeRecovery = new WorkflowNodeRecoveryService({
    db,
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    works: workRepository,
    attempts: recoveryAttemptRepository,
    executions: executionRepository,
    definitions: publishedDefinitions,
    assignments: workflowAssignmentResolver,
    checkpoints: checkpointService,
    executionRunner: executionService,
    worktrees: new WorkflowRecoveryWorktreeService(worktrees, workRepository),
    buildRecoveryPrompt: ({ run, node, definition }) => {
      if (node.type !== 'agent_task') throw new Error('recovery prompt requires AgentTask')
      return artifactExchange.promptForRecovery({ run, node, definition })
    },
    audit: auditRepository,
    logger,
    onRunReentered: (runId) => {
      void workflowEngine?.kick(runId)
    },
  })
  workflowRecoverySink.target = workflowNodeRecovery
  const plannerChatService = new PlannerChatService({
    db,
    messages: plannerMessageRepository,
    agents: agentRepository,
    teams: teamRepository,
    projects: projectRepository,
    teamService,
    agentService,
    planner: plannerService,
    executions: executionService,
    providers: registry,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    teamTasks: {
      createFromPlanner: (input) =>
        teamTaskCreationSink.target?.createFromPlanner(input) ??
        Promise.reject(new Error('team collaboration service is not ready')),
    },
    onTeamDecision: async ({ workId, content }) => {
      teamCollaborationService.onPlannerDecision(workId, content)
    },
    logger,
  })
  plannerEscalationSink.target = plannerChatService
  teamTaskCreationSink.target = teamCollaborationService
  const agentDesignerService = new AgentDesignerService({
    agents: agentService,
    executions: executionService,
    providers: registry,
    skills: skillRepository,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    logger,
  })
  workflowBridge = new WorkflowExecutionBridge({
    db,
    runs: workflowRunRepository,
    nodes: nodeRunRepository,
    works: workRepository,
    worktrees,
    definitions: publishedDefinitions,
    resolver: workflowAssignmentResolver,
    assignmentOverride: (runId, nodeKey) =>
      nodeAssignmentOverrideRepository.get(runId, nodeKey)?.agentId ?? null,
    executions: executionService,
    workInterrupted: (id) => executionService.isWorkPauseInterrupted(id),
    outputs: (id) => artifactExchange.extract(id),
    inputPrompt: (context) => artifactExchange.prompt(context),
    commitOutput: (execution, node, output, save) =>
      artifactExchange.commit(execution, node, output, save),
    rework: reworkService,
    checkpoints: checkpointService,
    taskEvents: {
      onTaskStarted: (event) => planThreadSink.target?.recordTaskEvent(event),
      onTaskSucceeded: (event) => planThreadSink.target?.recordTaskEvent(event),
      onTaskFailed: (event) => planThreadSink.target?.recordTaskEvent(event),
      onTaskCancelled: (event) => planThreadSink.target?.recordTaskEvent(event),
      onVerificationReport: (event) => planThreadSink.target?.recordTaskEvent(event),
    },
    recoveryExecution: {
      isRecoveryExecution: (executionId) =>
        recoveryAttemptRepository.getByExecutionId(executionId)?.kind === 'workflow_node',
      onWorkflowNodeTerminal: (input) => recoveryService.onWorkflowNodeTerminal(input),
    },
    logger,
  })
  const approvalGateChecker = createApprovalGateChecker({
    runs: workflowRunRepository,
    nodes: nodeRunRepository,
    approvals: approvalRepository,
    definitions: publishedDefinitions,
  })
  const workflowScheduler = new WorkflowScheduler({
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    definitions: publishedDefinitions,
    maintenance,
    drain,
    gates: [
      approvalGate(approvalGateChecker),
      ...defaultDispatchGates({
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
        inputArtifacts: {
          isAvailable: (context) => {
            try {
              artifactExchange.resolveInputs(context)
              return true
            } catch {
              nodeRunRepository.fail(
                context.nodeRun.id,
                ['ready'],
                {
                  category: 'internal',
                  nodeKey: context.node.key,
                  message: 'Input artifact missing, corrupt or from another run',
                },
                new Date().toISOString(),
              )
              return false
            }
          },
        },
      }),
    ],
    onNodeStarted: (context) => workflowEngine?.onNodeStarted(context),
    // S4-07：分支暂停时按 Provider 能力处置运行中 Execution（三档策略）。
    executionsRepo: executionRepository,
    pauseExecutor: {
      interrupt: (executionId) => executionService.interrupt({ executionId }),
    },
    pauseLogger: logger,
    agentResolver: (context) => {
      try {
        return workflowAssignmentResolver.resolveForNode(context.run.workId, context.node).agentId
      } catch {
        return null
      }
    },
    audit: auditRepository,
    logger,
  })
  const workflowFairDispatcher = new WorkflowFairDispatcher({
    runs: workflowRunRepository,
    scheduler: workflowScheduler,
    maintenance,
    logger,
  })
  workflowEngine = new WorkflowEngine({
    db,
    runs: workflowRunRepository,
    branches: branchRunRepository,
    nodes: nodeRunRepository,
    definitions: publishedDefinitions,
    approvals: approvalService,
    audit: auditRepository,
    scheduler: workflowScheduler,
    dispatcher: workflowFairDispatcher,
    bridge: workflowBridge,
    rework: reworkService,
    runService: workflowRunService,
    executions: executionService,
    eventSink: workflowEventRecorder,
    logger,
    maintenance,
    drain,
  })
  const teamDispatchService = new TeamDispatchService({
    db,
    plans: planRepository,
    versions: planVersionRepository,
    teams: teamRepository,
    agents: agentRepository,
    dispatches: planDispatchRepository,
    startAttempts: planStartAttemptRepository,
    assignments: planAssignmentService,
    executions: executionService,
    providers: registry,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    audit: auditRepository,
    logger,
  })
  const planStartService = new PlanStartService({
    db,
    plans: planRepository,
    versions: planVersionRepository,
    assignments: planAssignmentService,
    startAttempts: planStartAttemptRepository,
    dispatches: planDispatchRepository,
    workAssignments: assignmentService,
    works: workRepository,
    workflows: workflowService,
    runs: workflowRunRepository,
    runService: workflowRunService,
    engine: workflowEngine,
    threads: planThreadRepository,
    comments: planCommentRepository,
    audit: auditRepository,
    logger,
    eventWindow: {
      beforeKick: (planId, versionId) =>
        planStartEventSink.target?.beginVersionEventWindow(planId, versionId),
      afterKick: (versionId) => planStartEventSink.target?.finishVersionEventWindow(versionId),
    },
  })
  const planService = new PlanService({
    db,
    plans: planRepository,
    versions: planVersionRepository,
    threads: planThreadRepository,
    comments: planCommentRepository,
    overrides: nodeAssignmentOverrideRepository,
    rework: reworkService,
    reworks: reworkRequestRepository,
    nodes: nodeRunRepository,
    workService,
    projectService,
    hub,
    chatExecutions: executionService,
    extractOutput: (executionId) => artifactExchange.extract(executionId),
    planner: plannerService,
    agents: agentService,
    assignments: assignmentService,
    planAssignments: planAssignmentService,
    dispatches: planDispatchRepository,
    startAttempts: planStartAttemptRepository,
    startService: planStartService,
    dispatchService: teamDispatchService,
    teams: teamRepository,
    works: workRepository,
    runs: workflowRunRepository,
    engine: workflowEngine,
    audit: auditRepository,
  })
  planThreadSink.target = planService
  planStartEventSink.target = planService
  const workflowRecovery = new WorkflowRecoveryService(
    workflowRunRepository,
    branchRunRepository,
    nodeRunRepository,
    executionRepository,
    workflowScheduler,
    (execution) => workflowEngine?.onExecutionFinished(execution),
    logger,
    workflowFairDispatcher,
  )

  // S55-2B-1B：先注册 shutdown（recovery_locked 早退路径也必须能优雅退出并清理
  // 本进程创建的 socket/pid/锁），再进入 recovering 编排。
  let businessServer: Awaited<ReturnType<typeof startWsServer>> | null = null
  const shutdown = createShutdownHandler(
    (signal) =>
      shutdownWithDrain({
        signal,
        maintenance,
        drain,
        closeRuntime: () => runtime.close(),
        closeServer: () => businessServer?.close(),
        closeBootSocket: () => bootServer.close(),
        closeDb: () => db.close(),
        removePidFile: () => fs.unlinkSync(paths.corePid),
        releaseLock: () => bootLock.release(),
        exit: (code) => process.exit(code),
        logger,
      }),
    logger,
  )
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // S55-2C：老 Core 的 Restore 编排。只在 normal 态接受 backup.restore（RPC 门禁）；
  // handed_off 后经 shutdown 正常退出，文件替换由新 Core 在恢复启动模式完成。
  const restoreCoordinator = new RestoreCoordinator(
    {
      restoreRoot: paths.restore,
      journalA: paths.restoreJournalA,
      journalB: paths.restoreJournalB,
      activeMarker: paths.restoreActiveMarker,
      archiveRoot: paths.restoreArchive,
    },
    paths.restoreRetired,
    db,
    maintenance,
    drain,
    persistence,
    runtime,
    executionRepository,
    backupRepository,
    backupService,
    backupPrecheck,
    (reason) => shutdown(reason),
    logger,
  )

  // S55-2B-1B：进入 recovering；先订阅（终态事件可入）再等待订阅 ACK。
  maintenance.beginRecovering('reconciliation')

  // 运行期重连路径：仅 normal 态执行（boot 期由下方显式编排，不重复进入）。
  runtime.subscribe(
    (event) => executionService.handleRuntimeEvent(event),
    () => {
      if (maintenance.state !== 'normal') {
        logger.warn('skip daemon recovery while core is not normal', {
          state: maintenance.state,
        })
        return
      }
      void (async () => {
        try {
          await executionService.reconcile()
          const report = await workflowRecovery.recover({ daemonAvailable: true })
          logger.info('workflow recovery completed', {
            runs: report.runs,
            branches: report.branches,
            reconciliationRequired: report.nodesMarkedReconciliationRequired.length,
            runsKicked: report.runsKicked.length,
          })
          // S55-2B-1B（C1）：重连后无条件收敛一次，消费遗留 ready 行（CAS 幂等）。
          await workflowFairDispatcher.tickAll()
        } catch (error) {
          logger.error('workflow recovery failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
  )

  const daemonConnected = (await runtime.waitForConnection(DAEMON_CONNECT_TIMEOUT_MS)) === true
  logger.info('daemon connection ready check', { connected: daemonConnected })
  if (daemonConnected && !restoredJournal) {
    try {
      await executionService.recoverWorkEffects()
    } catch (error) {
      logger.error('Work process cancellation remains unconfirmed', { error: String(error) })
      maintenance.enterRecoveryLocked('work_process_effects_failed')
      return
    }
  }

  // 终态补偿 sweep：纯 DB，与 Daemon 可用性无关；失败必须 fail closed。
  try {
    const backlog = executionService.processTerminalBacklog()
    logger.info('terminal backlog processed', {
      processed: backlog.processed,
      completed: backlog.completed,
      failures: backlog.failures.length,
    })
    if (backlog.failures.length > 0) {
      throw new Error(
        `terminal compensation incomplete for ${backlog.failures.length} execution(s)`,
      )
    }
  } catch (error) {
    logger.error('terminal compensation sweep failed; entering recovery_locked', {
      error: error instanceof Error ? error.message : String(error),
    })
    maintenance.enterRecoveryLocked('terminal_compensation_failed')
    return
  }

  // 上次运行遗留的排队任务：丢弃并标记，不自动恢复（从未启动过进程，补跑等于静默产生副作用）。
  // 顺序约束（S55-2B-1B）：discard 严格先于 reconcile——queued 行从未有 Daemon 证据。
  const discardedQueued = executionService.discardQueuedOnStartup()
  if (discardedQueued > 0) {
    logger.info('discarded queued executions on startup', { count: discardedQueued })
  }

  // 阶段 2：回收上次进程遗留的队长派工/启动占用。失败行不自动重试，由老板显式重试。
  try {
    await teamDispatchService.recoverRunningDispatches()
  } catch (error) {
    logger.warn('team dispatch recovery failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    await planStartService.recoverStaleAttempts()
  } catch (error) {
    logger.warn('plan start attempt recovery failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (daemonConnected) {
    try {
      const report = await executionService.reconcile()
      const latePurge = locks.purgeStale()
      logger.info('workdir locks purged after execution reconcile', {
        reclaimed: latePurge.reclaimed,
        retained: latePurge.retained,
      })
      if (report.conflicts.length > 0) {
        logger.error('reconciliation conflicts detected; entering recovery_locked', {
          conflicts: report.conflicts,
        })
        maintenance.enterRecoveryLocked('reconciliation_conflict')
        return
      }
      const recoveryReport = await workflowRecovery.recover({
        daemonAvailable: true,
        unconfirmedExecutionIds: new Set(report.unconfirmed),
        // S55-2C：Restore 启动恢复禁止自动 kick。
        allowKick: restoredJournal === null,
      })
      logger.info('workflow recovery completed', {
        runs: recoveryReport.runs,
        branches: recoveryReport.branches,
        reconciliationRequired: recoveryReport.nodesMarkedReconciliationRequired.length,
        runsKicked: recoveryReport.runsKicked.length,
      })
      for (const attempt of recoveryAttemptRepository.listUnfinished()) {
        await workflowNodeRecovery.reconcileStartup(attempt)
      }
      recoveryService.recoverOnStartup()
      await recoveryService.reconcileInterruptedStarts(true)
      workflowNodeRecovery.reconcileAll()
    } catch (error) {
      logger.error('startup recovery failed; entering recovery_locked', {
        error: error instanceof Error ? error.message : String(error),
      })
      maintenance.enterRecoveryLocked('startup_recovery_failed')
      return
    }
  } else {
    // A4：Daemon 不可用——仅做一次只读健康探测（日志用途），不改 Execution 终态、
    // 不自动 dispatch；无法确认的 NodeRun/WorkflowRun 进入 reconciliation_required。
    try {
      await proxyDaemonHealth(paths.daemonSocket)
    } catch (error) {
      logger.warn('daemon health probe failed (diagnostics only)', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      const recoveryReport = await workflowRecovery.recover({ daemonAvailable: false })
      for (const attempt of recoveryAttemptRepository.listUnfinished()) {
        await workflowNodeRecovery.reconcileStartup(attempt)
      }
      recoveryService.recoverOnStartup()
      workflowNodeRecovery.reconcileAll()
      logger.warn('daemon unavailable; marked unconfirmed work as reconciliation_required', {
        nodes: recoveryReport.nodesMarkedReconciliationRequired.length,
        runs: recoveryReport.runsMarkedReconciliationRequired.length,
      })
    } catch (error) {
      logger.error('daemon-unavailable recovery failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await recoveryService.reconcileInterruptedStarts(false)
    maintenance.enterRecoveryLocked('daemon_unavailable')
    return
  }

  // S55-2C：Restore 启动恢复的数据验证与 completed 收尾。
  // 必须在业务 socket 开放前完成：Archive verified → marker 删除 → Journal 退役。
  if (restoredJournal) {
    try {
      const evidence = restoreBoot.verifyRestoredData(
        restoredJournal,
        paths.database,
        paths.artifacts,
      )
      restoredJournal = restoreBoot.markReconciled(restoredJournal)
      restoredJournal = restoreBoot.completeRestore(restoredJournal, evidence)
      logger.info('restore completed and archived during boot', {
        journalId: restoredJournal.journalId,
        phase: restoredJournal.phase,
        evidence,
      })
    } catch (error) {
      logger.error('restore data verification failed; entering recovery_locked', {
        error: error instanceof Error ? error.message : String(error),
      })
      maintenance.enterRecoveryLocked('restore_verification_failed')
      return
    }
  }

  // 业务 RPC socket：在对账完成后 bind，但状态仍为 recovering——
  // authorizeRpc 的 lockdown 分支保证任何业务调用（含 events.subscribe）都被拒绝。
  try {
    businessServer = await startWsServer(
      paths.coreSocket,
      coreMethods(
        VERSION,
        paths.daemonSocket,
        {
          agents: agentService,
          skills: skillService,
          agentDesigner: agentDesignerService,
          planner: plannerService,
          plannerChat: plannerChatService,
          teamCollaboration: teamCollaborationService,
          plans: planService,
          projects: projectService,
          registry,
          executions: executionService,
          hub,
          teams: teamService,
          works: workService,
          recoveries: recoveryService,
          workflowNodeRecovery,
          workspaceFiles: new WorkspaceFilesService(),
          workEffects: async (id, action) => {
            if (action === 'terminate') await executionService.terminateWork(id)
            if (action === 'pause') await executionService.pauseWork(id)
            if (action === 'resume') {
              await executionService.resumeWork(id)
              for (const run of workflowRunRepository.listByWork(id))
                await workflowEngine?.kick(run.id)
            }
          },
          assignments: assignmentService,
          worktrees,
          workflowRuns: workflowRunQuery,
          workflowEngine,
          approvals: approvalRpc,
          artifacts: artifactRpc,
          backups: backupRpc,
          backupPrecheck,
          restore: restoreCoordinator,
        },
        {
          maintenance,
          drain,
        },
      ),
      {
        authorize: (requestId, method, access) =>
          maintenance.authorizeRpc(requestId, method, access),
        onStart: (method, access) => {
          if (access !== 'write') return undefined
          const lease = drain.acquire('rpc-mutation', `rpc:${method}`)
          return () => {
            lease.release()
          }
        },
      },
    )
  } catch (error) {
    logger.error('business socket bind failed; entering recovery_locked', {
      socket: paths.coreSocket,
      error: error instanceof Error ? error.message : String(error),
    })
    maintenance.enterRecoveryLocked('business_socket_bind_failed')
    return
  }

  // completeBoot：只有 bind 成功后才进入 normal；失败则关闭业务入口并锁定。
  try {
    maintenance.completeBoot()
  } catch (error) {
    logger.error('completeBoot failed; closing business socket', {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      businessServer.close()
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    maintenance.enterRecoveryLocked('complete_boot_failed')
    return
  }

  // 收敛 pass（S55-2B-1B）：normal 后消费遗留 ready 行；Daemon 健康不可达则跳过
  // （ready 行持久保留，由运行期 onConnected 路径重新消费）。
  // S55-2C：Restore 启动恢复不自动 kick——遗留 ready 行保持排队，由用户/后续操作决定。
  let daemonHealthy = false
  try {
    await proxyDaemonHealth(paths.daemonSocket)
    daemonHealthy = true
  } catch (error) {
    logger.warn('convergence pass skipped: daemon health check failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  if (daemonHealthy && !restoredJournal) {
    try {
      await workflowFairDispatcher.tickAll()
      await teamCollaborationService.recover()
      const repairedMemberReports = teamCollaborationService.backfillMemberReports()
      if (repairedMemberReports > 0) {
        logger.info('team task member reports backfilled', { repaired: repairedMemberReports })
      }
      const repairedRunSteps = teamCollaborationService.backfillRunSteps()
      if (repairedRunSteps > 0) {
        logger.info('team task run steps backfilled', { inserted: repairedRunSteps })
      }
      logger.info('boot convergence pass completed')
    } catch (error) {
      logger.warn('boot convergence pass failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  } else if (restoredJournal) {
    logger.info('boot convergence pass skipped after restore (no auto dispatch)')
  }

  logger.info('core started', {
    socketPath: paths.coreSocket,
    bootSocketPath: paths.coreBootSocket,
    pid: process.pid,
    version: VERSION,
    daemonSpawned: daemon.spawned,
  })
}

// 被直接运行时启动（tsx 源码 / esbuild 打包产物）；被测试导入时不自动启动。
if (isDirectRun(import.meta.url)) {
  void main()
}
