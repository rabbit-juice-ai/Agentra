import path from 'node:path'
import {
  AGENT_ARCHIVE_METHOD,
  AGENT_CREATE_METHOD,
  AGENT_GENERATE_DRAFT_METHOD,
  AGENT_LIST_METHOD,
  AGENT_UPDATE_METHOD,
  AgentGenerateDraftResult,
  AgentListResult,
  AgentResult,
  APPROVAL_DECIDE_METHOD,
  APPROVAL_GET_METHOD,
  APPROVAL_LIST_PENDING_METHOD,
  ApprovalGetResult,
  ApprovalListPendingResult,
  ApprovalResult,
  ARTIFACT_LIST_METHOD,
  ARTIFACT_PREVIEW_METHOD,
  ArtifactListResult,
  ArtifactPreviewResult,
  ASSIGNMENT_COMPLETE_METHOD,
  ASSIGNMENT_CREATE_METHOD,
  ASSIGNMENT_LIST_METHOD,
  ASSIGNMENT_PAUSE_METHOD,
  ASSIGNMENT_RESUME_METHOD,
  AssignmentListResult,
  AssignmentResult,
  BACKUP_CREATE_METHOD,
  BACKUP_EXPORT_METHOD,
  BACKUP_LIST_METHOD,
  BACKUP_RESTORE_METHOD,
  BACKUP_RESTORE_PRECHECK_METHOD,
  BackupExportResultValue,
  BackupListResultValue,
  BackupRestoreAcceptedValue,
  BackupRestorePrecheckResultValue,
  BackupResultValue,
  CORE_HEALTH_METHOD,
  DAEMON_HEALTH_METHOD,
  EVENTS_SUBSCRIBE_METHOD,
  EXECUTION_CANCEL_METHOD,
  EXECUTION_GET_METHOD,
  EXECUTION_INTERRUPT_METHOD,
  EXECUTION_LIST_METHOD,
  EXECUTION_LOGS_METHOD,
  EXECUTION_SEND_MESSAGE_METHOD,
  EXECUTION_START_METHOD,
  ExecutionGetResult,
  ExecutionInterruptResult,
  ExecutionListResult,
  ExecutionLogsResult,
  ExecutionResult,
  ExecutionSendMessageResult,
  HealthResult,
  PLAN_APPROVE_METHOD,
  PLAN_ASSIGN_TASK_METHOD,
  PLAN_COMMENT_METHOD,
  PLAN_CONTINUE_REWORK_METHOD,
  PLAN_CONVERT_TO_PROJECT_METHOD,
  PLAN_CONVERT_TO_TASK_METHOD,
  PLAN_DISPATCH_METHOD,
  PLAN_GENERATE_METHOD,
  PLAN_GET_METHOD,
  PLAN_LIST_BY_WORK_METHOD,
  PLAN_LIST_RECENT_METHOD,
  PLAN_REASSIGN_TASK_METHOD,
  PLAN_REJECT_METHOD,
  PLAN_START_RUN_METHOD,
  PLAN_TAKE_OVER_REWORK_METHOD,
  PLAN_THREAD_LIST_METHOD,
  PLANNER_ACTION_APPLY_METHOD,
  PLANNER_ACTION_REJECT_METHOD,
  PLANNER_CHAT_GET_METHOD,
  PLANNER_CHAT_SEND_METHOD,
  PLANNER_ENSURE_METHOD,
  PlanAssignTaskResult,
  PlanCommentResult,
  PlanConvertToProjectResult,
  PlanConvertToTaskResult,
  PlanDecisionResult,
  PlanDispatchResult,
  PlanGenerateResult,
  PlanGetResult,
  PlanListByWorkResult,
  PlanListRecentResult,
  PlannerActionResult,
  PlannerChatGetResult,
  PlannerChatSendResult,
  PlannerEnsureResult,
  PlanReassignTaskResult,
  PlanReworkActionResult,
  PlanStartRunResult,
  PlanThreadListResult,
  PROJECT_CREATE_METHOD,
  PROJECT_GET_METHOD,
  PROJECT_LIST_METHOD,
  PROJECT_UPDATE_METHOD,
  ProjectListResult,
  ProjectResult,
  RESTORE_STATUS_METHOD,
  RestoreStatusResultValue,
  RUNTIME_PROVIDER_LIST_METHOD,
  RUNTIME_PROVIDER_MODELS_METHOD,
  RUNTIME_PROVIDER_REFRESH_METHOD,
  RuntimeProviderListResult,
  RuntimeProviderModelsResult,
  SKILL_CREATE_METHOD,
  SKILL_DELETE_METHOD,
  SKILL_LIST_METHOD,
  SKILL_UPDATE_METHOD,
  SkillDeleteResult,
  SkillListResult,
  SkillResult,
  TEAM_ARCHIVE_METHOD,
  TEAM_CREATE_METHOD,
  TEAM_GET_METHOD,
  TEAM_LIST_METHOD,
  TEAM_MEMBER_ADD_METHOD,
  TEAM_MEMBER_LIST_METHOD,
  TEAM_MEMBER_REMOVE_METHOD,
  TEAM_TASK_COMMENT_METHOD,
  TEAM_TASK_GET_METHOD,
  TEAM_TASK_SET_STATUS_METHOD,
  TEAM_UPDATE_METHOD,
  TeamListResult,
  TeamMemberListResult,
  TeamMemberRemoveResult,
  TeamMemberResult,
  TeamResult,
  TeamTaskCommentResult,
  TeamTaskGetResult,
  TeamTaskSetStatusResult,
  WORK_ACTIVATE_METHOD,
  WORK_COMPLETE_METHOD,
  WORK_CREATE_METHOD,
  WORK_FILES_LIST_METHOD,
  WORK_LINK_TEAM_METHOD,
  WORK_LIST_METHOD,
  WORK_PAUSE_METHOD,
  WORK_RESUME_METHOD,
  WORKFLOW_RUN_GET_METHOD,
  WORKTREE_CREATE_METHOD,
  WORKTREE_LIST_METHOD,
  WORKTREE_REMOVE_METHOD,
  WorkFilesListResult,
  WorkflowRunGetResult,
  WorkListResult,
  WorkResult,
  WorktreeCreateResult,
  WorktreeListResult,
  WorktreeRemoveResult,
} from '@agentra/protocol'
import { agentraHome, agentraPaths } from '@agentra/shared'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import {
  AGENT_GENERATE_DRAFT_TIMEOUT_MS,
  BACKUP_LIST_DEFAULT_LIMIT,
  backupRpcTimeoutMs,
  PLAN_DISPATCH_TIMEOUT_MS,
  PLAN_GENERATE_TIMEOUT_MS,
  PLAN_REASSIGN_TIMEOUT_MS,
  PLAN_START_RUN_TIMEOUT_MS,
  PLANNER_CHAT_TIMEOUT_MS,
  PROVIDER_MODELS_TIMEOUT_MS,
  type RpcResult,
  TEAM_TASK_COMMENT_TIMEOUT_MS,
} from '../shared/api'
import { ensureCore } from './core-launcher'
import { waitForCoreNormal } from './core-status'
import { CoreRpcClient } from './rpc-client'

// 窗口级单实例：第二次启动聚焦已有窗口（与 Core/Daemon 的 socket 探活是两回事）。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const RECONNECT_DELAY_MS = 3000

let client: CoreRpcClient | null = null
let lastError: string | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let connecting = false
let detachEvents: (() => void) | null = null

/** Core 响应在信任边界处校验：结构不符不得进入 renderer。 */
type Parser<T> = { parse: (value: unknown) => T }

async function callCore<T>(
  method: string,
  params: unknown,
  schema: Parser<T>,
  timeoutMs?: number,
): Promise<RpcResult<T>> {
  const active = client
  if (!active) {
    return { ok: false, error: { code: 'NOT_READY', message: lastError ?? 'core not connected' } }
  }
  try {
    const response = await active.call(method, params, timeoutMs)
    if (!response.ok) return { ok: false, error: response.error }
    try {
      return { ok: true, result: schema.parse(response.result) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: `invalid core response for ${method}: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('agentra:core-health', () => callCore(CORE_HEALTH_METHOD, {}, HealthResult))
  ipcMain.handle('agentra:daemon-health', () => callCore(DAEMON_HEALTH_METHOD, {}, HealthResult))
  ipcMain.handle('agentra:app-info', () => ({ version: app.getVersion(), dataDir: agentraHome() }))
  ipcMain.handle('agentra:open-data-dir', async () => {
    const dataDir = agentraHome()
    const error = await shell.openPath(dataDir)
    return { path: dataDir, error: error === '' ? null : error }
  })

  ipcMain.handle('agentra:agent-list', (_event, params: unknown) =>
    callCore(AGENT_LIST_METHOD, params ?? {}, AgentListResult),
  )
  ipcMain.handle('agentra:agent-create', (_event, params: unknown) =>
    callCore(AGENT_CREATE_METHOD, params, AgentResult),
  )
  ipcMain.handle('agentra:agent-update', (_event, params: unknown) =>
    callCore(AGENT_UPDATE_METHOD, params, AgentResult),
  )
  ipcMain.handle('agentra:agent-archive', (_event, params: unknown) =>
    callCore(AGENT_ARCHIVE_METHOD, params, AgentResult),
  )
  ipcMain.handle('agentra:agent-generate-draft', (_event, params: unknown) =>
    callCore(
      AGENT_GENERATE_DRAFT_METHOD,
      params,
      AgentGenerateDraftResult,
      AGENT_GENERATE_DRAFT_TIMEOUT_MS,
    ),
  )

  ipcMain.handle('agentra:provider-list', () =>
    callCore(RUNTIME_PROVIDER_LIST_METHOD, {}, RuntimeProviderListResult),
  )
  ipcMain.handle('agentra:provider-refresh', () =>
    callCore(RUNTIME_PROVIDER_REFRESH_METHOD, {}, RuntimeProviderListResult),
  )
  ipcMain.handle('agentra:provider-models', (_event, params: unknown) =>
    callCore(
      RUNTIME_PROVIDER_MODELS_METHOD,
      params,
      RuntimeProviderModelsResult,
      PROVIDER_MODELS_TIMEOUT_MS,
    ),
  )

  ipcMain.handle('agentra:skill-list', () => callCore(SKILL_LIST_METHOD, {}, SkillListResult))
  ipcMain.handle('agentra:skill-create', (_event, params: unknown) =>
    callCore(SKILL_CREATE_METHOD, params, SkillResult),
  )
  ipcMain.handle('agentra:skill-update', (_event, params: unknown) =>
    callCore(SKILL_UPDATE_METHOD, params, SkillResult),
  )
  ipcMain.handle('agentra:skill-delete', (_event, params: unknown) =>
    callCore(SKILL_DELETE_METHOD, params, SkillDeleteResult),
  )

  ipcMain.handle('agentra:plan-generate', (_event, params: unknown) =>
    callCore(PLAN_GENERATE_METHOD, params, PlanGenerateResult, PLAN_GENERATE_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:plan-get', (_event, params: unknown) =>
    callCore(PLAN_GET_METHOD, params, PlanGetResult),
  )
  ipcMain.handle('agentra:plan-list-by-work', (_event, params: unknown) =>
    callCore(PLAN_LIST_BY_WORK_METHOD, params, PlanListByWorkResult),
  )
  ipcMain.handle('agentra:plan-list-recent', (_event, params: unknown) =>
    callCore(PLAN_LIST_RECENT_METHOD, params ?? {}, PlanListRecentResult),
  )
  ipcMain.handle('agentra:plan-convert-to-task', (_event, params: unknown) =>
    callCore(PLAN_CONVERT_TO_TASK_METHOD, params, PlanConvertToTaskResult),
  )
  ipcMain.handle('agentra:plan-convert-to-project', (_event, params: unknown) =>
    callCore(PLAN_CONVERT_TO_PROJECT_METHOD, params, PlanConvertToProjectResult),
  )
  ipcMain.handle('agentra:plan-approve', (_event, params: unknown) =>
    callCore(PLAN_APPROVE_METHOD, params, PlanDecisionResult),
  )
  ipcMain.handle('agentra:plan-reject', (_event, params: unknown) =>
    callCore(PLAN_REJECT_METHOD, params, PlanDecisionResult),
  )
  ipcMain.handle('agentra:plan-start-run', (_event, params: unknown) =>
    callCore(PLAN_START_RUN_METHOD, params, PlanStartRunResult, PLAN_START_RUN_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:plan-dispatch', (_event, params: unknown) =>
    callCore(PLAN_DISPATCH_METHOD, params, PlanDispatchResult, PLAN_DISPATCH_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:plan-assign-task', (_event, params: unknown) =>
    callCore(PLAN_ASSIGN_TASK_METHOD, params, PlanAssignTaskResult, PLAN_REASSIGN_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:planner-chat-get', () =>
    callCore(PLANNER_CHAT_GET_METHOD, {}, PlannerChatGetResult),
  )
  ipcMain.handle('agentra:planner-ensure', () =>
    callCore(PLANNER_ENSURE_METHOD, {}, PlannerEnsureResult),
  )
  ipcMain.handle('agentra:planner-chat-send', (_event, params: unknown) =>
    callCore(PLANNER_CHAT_SEND_METHOD, params, PlannerChatSendResult, PLANNER_CHAT_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:planner-action-apply', (_event, params: unknown) =>
    callCore(PLANNER_ACTION_APPLY_METHOD, params, PlannerActionResult),
  )
  ipcMain.handle('agentra:planner-action-reject', (_event, params: unknown) =>
    callCore(PLANNER_ACTION_REJECT_METHOD, params, PlannerActionResult),
  )
  ipcMain.handle('agentra:team-task-get', (_event, params: unknown) =>
    callCore(TEAM_TASK_GET_METHOD, params, TeamTaskGetResult),
  )
  ipcMain.handle('agentra:team-task-comment', (_event, params: unknown) =>
    callCore(TEAM_TASK_COMMENT_METHOD, params, TeamTaskCommentResult, TEAM_TASK_COMMENT_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:team-task-set-status', (_event, params: unknown) =>
    callCore(TEAM_TASK_SET_STATUS_METHOD, params, TeamTaskSetStatusResult),
  )
  ipcMain.handle('agentra:plan-thread-list', (_event, params: unknown) =>
    callCore(PLAN_THREAD_LIST_METHOD, params, PlanThreadListResult),
  )
  ipcMain.handle('agentra:plan-comment', (_event, params: unknown) =>
    callCore(PLAN_COMMENT_METHOD, params, PlanCommentResult),
  )
  ipcMain.handle('agentra:plan-reassign-task', (_event, params: unknown) =>
    callCore(PLAN_REASSIGN_TASK_METHOD, params, PlanReassignTaskResult, PLAN_REASSIGN_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:plan-continue-rework', (_event, params: unknown) =>
    callCore(PLAN_CONTINUE_REWORK_METHOD, params, PlanReworkActionResult, PLAN_REASSIGN_TIMEOUT_MS),
  )
  ipcMain.handle('agentra:plan-take-over-rework', (_event, params: unknown) =>
    callCore(
      PLAN_TAKE_OVER_REWORK_METHOD,
      params,
      PlanReworkActionResult,
      PLAN_REASSIGN_TIMEOUT_MS,
    ),
  )

  ipcMain.handle('agentra:team-list', (_event, params: unknown) =>
    callCore(TEAM_LIST_METHOD, params ?? {}, TeamListResult),
  )
  ipcMain.handle('agentra:team-get', (_event, params: unknown) =>
    callCore(TEAM_GET_METHOD, params, TeamResult),
  )
  ipcMain.handle('agentra:team-create', (_event, params: unknown) =>
    callCore(TEAM_CREATE_METHOD, params, TeamResult),
  )
  ipcMain.handle('agentra:team-update', (_event, params: unknown) =>
    callCore(TEAM_UPDATE_METHOD, params, TeamResult),
  )
  ipcMain.handle('agentra:team-archive', (_event, params: unknown) =>
    callCore(TEAM_ARCHIVE_METHOD, params, TeamResult),
  )
  ipcMain.handle('agentra:team-member-list', (_event, params: unknown) =>
    callCore(TEAM_MEMBER_LIST_METHOD, params, TeamMemberListResult),
  )
  ipcMain.handle('agentra:team-member-add', (_event, params: unknown) =>
    callCore(TEAM_MEMBER_ADD_METHOD, params, TeamMemberResult),
  )
  ipcMain.handle('agentra:team-member-remove', (_event, params: unknown) =>
    callCore(TEAM_MEMBER_REMOVE_METHOD, params, TeamMemberRemoveResult),
  )

  ipcMain.handle('agentra:project-list', () => callCore(PROJECT_LIST_METHOD, {}, ProjectListResult))
  ipcMain.handle('agentra:project-get', (_event, params: unknown) =>
    callCore(PROJECT_GET_METHOD, params, ProjectResult),
  )
  ipcMain.handle('agentra:project-create', (_event, params: unknown) =>
    callCore(PROJECT_CREATE_METHOD, params, ProjectResult),
  )
  ipcMain.handle('agentra:project-update', (_event, params: unknown) =>
    callCore(PROJECT_UPDATE_METHOD, params, ProjectResult),
  )

  ipcMain.handle('agentra:work-list', (_event, params: unknown) =>
    callCore(WORK_LIST_METHOD, params ?? {}, WorkListResult),
  )
  ipcMain.handle('agentra:work-create', (_event, params: unknown) =>
    callCore(WORK_CREATE_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-link-team', (_event, params: unknown) =>
    callCore(WORK_LINK_TEAM_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-activate', (_event, params: unknown) =>
    callCore(WORK_ACTIVATE_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-pause', (_event, params: unknown) =>
    callCore(WORK_PAUSE_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-resume', (_event, params: unknown) =>
    callCore(WORK_RESUME_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-complete', (_event, params: unknown) =>
    callCore(WORK_COMPLETE_METHOD, params, WorkResult),
  )
  ipcMain.handle('agentra:work-files-list', (_event, params: unknown) =>
    callCore(WORK_FILES_LIST_METHOD, params, WorkFilesListResult),
  )

  ipcMain.handle('agentra:worktree-list', (_event, params: unknown) =>
    callCore(WORKTREE_LIST_METHOD, params, WorktreeListResult),
  )
  ipcMain.handle('agentra:worktree-create', (_event, params: unknown) =>
    callCore(WORKTREE_CREATE_METHOD, params, WorktreeCreateResult),
  )
  ipcMain.handle('agentra:worktree-remove', (_event, params: unknown) =>
    callCore(WORKTREE_REMOVE_METHOD, params, WorktreeRemoveResult),
  )

  ipcMain.handle('agentra:assignment-list', (_event, params: unknown) =>
    callCore(ASSIGNMENT_LIST_METHOD, params, AssignmentListResult),
  )
  ipcMain.handle('agentra:assignment-create', (_event, params: unknown) =>
    callCore(ASSIGNMENT_CREATE_METHOD, params, AssignmentResult),
  )
  ipcMain.handle('agentra:assignment-pause', (_event, params: unknown) =>
    callCore(ASSIGNMENT_PAUSE_METHOD, params, AssignmentResult),
  )
  ipcMain.handle('agentra:assignment-resume', (_event, params: unknown) =>
    callCore(ASSIGNMENT_RESUME_METHOD, params, AssignmentResult),
  )
  ipcMain.handle('agentra:assignment-complete', (_event, params: unknown) =>
    callCore(ASSIGNMENT_COMPLETE_METHOD, params, AssignmentResult),
  )

  ipcMain.handle('agentra:execution-start', (_event, params: unknown) =>
    callCore(EXECUTION_START_METHOD, params, ExecutionResult),
  )
  ipcMain.handle('agentra:execution-get', (_event, params: unknown) =>
    callCore(EXECUTION_GET_METHOD, params, ExecutionGetResult),
  )
  ipcMain.handle('agentra:execution-list', (_event, params: unknown) =>
    callCore(EXECUTION_LIST_METHOD, params ?? {}, ExecutionListResult),
  )
  ipcMain.handle('agentra:execution-logs', (_event, params: unknown) =>
    callCore(EXECUTION_LOGS_METHOD, params, ExecutionLogsResult),
  )
  ipcMain.handle('agentra:execution-cancel', (_event, params: unknown) =>
    callCore(EXECUTION_CANCEL_METHOD, params, ExecutionResult),
  )
  ipcMain.handle('agentra:execution-interrupt', (_event, params: unknown) =>
    callCore(EXECUTION_INTERRUPT_METHOD, params, ExecutionInterruptResult),
  )
  ipcMain.handle('agentra:execution-send-message', (_event, params: unknown) =>
    callCore(EXECUTION_SEND_MESSAGE_METHOD, params, ExecutionSendMessageResult),
  )

  // 阶段 5 S5-3：审批中心 + 运行态只读查询。逐条显式通道，无通用透传；无执行入口。
  ipcMain.handle('agentra:approval-decide', (_event, params: unknown) =>
    callCore(APPROVAL_DECIDE_METHOD, params, ApprovalResult),
  )
  ipcMain.handle('agentra:approval-get', (_event, params: unknown) =>
    callCore(APPROVAL_GET_METHOD, params, ApprovalGetResult),
  )
  ipcMain.handle('agentra:approval-list-pending', (_event, params: unknown) =>
    callCore(APPROVAL_LIST_PENDING_METHOD, params, ApprovalListPendingResult),
  )
  ipcMain.handle('agentra:workflow-run-get', (_event, params: unknown) =>
    callCore(WORKFLOW_RUN_GET_METHOD, params, WorkflowRunGetResult),
  )
  ipcMain.handle('agentra:artifact-list', (_event, params: unknown) =>
    callCore(ARTIFACT_LIST_METHOD, params, ArtifactListResult),
  )
  ipcMain.handle('agentra:artifact-preview', (_event, params: unknown) =>
    callCore(ARTIFACT_PREVIEW_METHOD, params, ArtifactPreviewResult),
  )

  // 阶段 5.5 S55-1B：备份中心（创建固定 manual；create/export 使用独立超时）。
  ipcMain.handle('agentra:backup-create', () =>
    callCore(
      BACKUP_CREATE_METHOD,
      { type: 'manual' },
      BackupResultValue,
      backupRpcTimeoutMs('create'),
    ),
  )
  ipcMain.handle('agentra:backup-list', (_event, params: unknown) =>
    callCore(
      BACKUP_LIST_METHOD,
      params ?? { limit: BACKUP_LIST_DEFAULT_LIMIT },
      BackupListResultValue,
      backupRpcTimeoutMs('list'),
    ),
  )
  ipcMain.handle('agentra:backup-export', (_event, params: unknown) =>
    callCore(BACKUP_EXPORT_METHOD, params, BackupExportResultValue, backupRpcTimeoutMs('export')),
  )

  // 阶段 5.5 S55-2A：恢复预检（只读）。
  ipcMain.handle('agentra:backup-restore-precheck', (_event, params: unknown) =>
    callCore(
      BACKUP_RESTORE_PRECHECK_METHOD,
      params,
      BackupRestorePrecheckResultValue,
      backupRpcTimeoutMs('precheck'),
    ),
  )

  // 阶段 5.5 S55-2C：恢复执行（异步受理；UI 在 2E）与状态查询（只读）。
  // 受理前 Core 会执行完整预检（复制/哈希 DB 与 Artifact），复用 precheck 超时预算。
  ipcMain.handle('agentra:backup-restore', (_event, params: unknown) =>
    callCore(
      BACKUP_RESTORE_METHOD,
      params,
      BackupRestoreAcceptedValue,
      backupRpcTimeoutMs('precheck'),
    ),
  )
  ipcMain.handle('agentra:restore-status', (_event, params: unknown) =>
    callCore(RESTORE_STATUS_METHOD, params ?? {}, RestoreStatusResultValue),
  )
}

function broadcastEvent(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agentra:event', event)
  }
}

/** Core 连接就绪（含断线重连成功）：renderer 收到后补拉首屏数据。 */
function broadcastCoreReady(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agentra:core-ready')
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectCore()
  }, RECONNECT_DELAY_MS)
}

/**
 * S55-2B-1B（R2）：连接后先等待 Core 进入 normal，再做业务初始化。
 * 实现移至 core-status.ts（无 Electron 依赖，可用真实 UDS 测试）。
 */
async function connectCore(): Promise<void> {
  if (connecting) return
  connecting = true
  const paths = agentraPaths()
  try {
    await ensureCore(paths)
    const next = new CoreRpcClient(paths.coreSocket)
    await next.connect()
    client = next
    lastError = null
    detachEvents?.()
    detachEvents = next.subscribe(broadcastEvent)
    next.onClose(() => {
      if (client === next) {
        client = null
        lastError = 'core connection closed'
        scheduleReconnect()
      }
    })
    // S55-2B-1B（R2）：先等 Core 进入 normal（booting/recovering 只轮询 status），
    // 再订阅事件与拉首屏——recovering 期不产生任何业务请求。
    await waitForCoreNormal(next)
    // 订阅事件：renderer 通过 IPC 接收 execution.output / execution.state。
    await next.call(EVENTS_SUBSCRIBE_METHOD, {})
    // Core 就绪：通知 renderer 补拉首屏数据。
    // 启动时 renderer 常先于 Core 就绪，首拉会撞 NOT_READY；agents / providers 没有轮询，不补拉就会一直是空列表。
    broadcastCoreReady()
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    client = null
    // 不抛出：UI 显示断连态，后台自动重试。
    scheduleReconnect()
  } finally {
    connecting = false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1100,
    minHeight: 700,
    title: 'Agentra',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void connectCore()

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// window-all-closed 退出：退出路径没有任何 kill 子进程的代码（验收：关 Desktop 不终止 Core/Daemon）。
app.on('window-all-closed', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  detachEvents?.()
  client?.close()
  app.quit()
})
