import path from 'node:path'
import {
  AGENT_ARCHIVE_METHOD,
  AGENT_CREATE_METHOD,
  AGENT_LIST_METHOD,
  AGENT_UPDATE_METHOD,
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
  BACKUP_RESTORE_PRECHECK_METHOD,
  BackupExportResultValue,
  BackupListResultValue,
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
  RUNTIME_PROVIDER_LIST_METHOD,
  RUNTIME_PROVIDER_REFRESH_METHOD,
  RuntimeProviderListResult,
  TEAM_ARCHIVE_METHOD,
  TEAM_CREATE_METHOD,
  TEAM_GET_METHOD,
  TEAM_LIST_METHOD,
  TEAM_MEMBER_ADD_METHOD,
  TEAM_MEMBER_LIST_METHOD,
  TEAM_MEMBER_REMOVE_METHOD,
  TeamListResult,
  TeamMemberListResult,
  TeamMemberRemoveResult,
  TeamMemberResult,
  TeamResult,
  WORK_ACTIVATE_METHOD,
  WORK_COMPLETE_METHOD,
  WORK_CREATE_METHOD,
  WORK_LINK_TEAM_METHOD,
  WORK_LIST_METHOD,
  WORK_PAUSE_METHOD,
  WORK_RESUME_METHOD,
  WORKFLOW_RUN_GET_METHOD,
  WORKFLOW_RUN_LIST_BY_WORK_METHOD,
  WORKFLOW_TEMPLATE_ARCHIVE_METHOD,
  WORKFLOW_TEMPLATE_CREATE_METHOD,
  WORKFLOW_TEMPLATE_GET_METHOD,
  WORKFLOW_TEMPLATE_LIST_METHOD,
  WORKFLOW_TEMPLATE_UPDATE_METHOD,
  WORKFLOW_VERSION_CREATE_DRAFT_METHOD,
  WORKFLOW_VERSION_GET_METHOD,
  WORKFLOW_VERSION_LIST_METHOD,
  WORKFLOW_VERSION_PUBLISH_METHOD,
  WORKFLOW_VERSION_VALIDATE_METHOD,
  WORKTREE_CREATE_METHOD,
  WORKTREE_LIST_METHOD,
  WORKTREE_REMOVE_METHOD,
  WorkflowRunGetResult,
  WorkflowRunListByWorkResult,
  WorkflowTemplateListResult,
  WorkflowTemplateResult,
  WorkflowVersionListResult,
  WorkflowVersionResult,
  WorkflowVersionValidateResult,
  WorkListResult,
  WorkResult,
  WorktreeCreateResult,
  WorktreeListResult,
  WorktreeRemoveResult,
} from '@agentra/protocol'
import { agentraPaths } from '@agentra/shared'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BACKUP_LIST_DEFAULT_LIMIT, backupRpcTimeoutMs, type RpcResult } from '../shared/api'
import { ensureCore } from './core-launcher'
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

  ipcMain.handle('agentra:provider-list', () =>
    callCore(RUNTIME_PROVIDER_LIST_METHOD, {}, RuntimeProviderListResult),
  )
  ipcMain.handle('agentra:provider-refresh', () =>
    callCore(RUNTIME_PROVIDER_REFRESH_METHOD, {}, RuntimeProviderListResult),
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

  // 阶段 3：工作流定义层。逐条显式通道，不存在通用 RPC 透传；也没有任何 workflow.run.* 入口。
  ipcMain.handle('agentra:workflow-template-list', (_event, params: unknown) =>
    callCore(WORKFLOW_TEMPLATE_LIST_METHOD, params ?? {}, WorkflowTemplateListResult),
  )
  ipcMain.handle('agentra:workflow-template-get', (_event, params: unknown) =>
    callCore(WORKFLOW_TEMPLATE_GET_METHOD, params, WorkflowTemplateResult),
  )
  ipcMain.handle('agentra:workflow-template-create', (_event, params: unknown) =>
    callCore(WORKFLOW_TEMPLATE_CREATE_METHOD, params, WorkflowTemplateResult),
  )
  ipcMain.handle('agentra:workflow-template-update', (_event, params: unknown) =>
    callCore(WORKFLOW_TEMPLATE_UPDATE_METHOD, params, WorkflowTemplateResult),
  )
  ipcMain.handle('agentra:workflow-template-archive', (_event, params: unknown) =>
    callCore(WORKFLOW_TEMPLATE_ARCHIVE_METHOD, params, WorkflowTemplateResult),
  )
  ipcMain.handle('agentra:workflow-version-list', (_event, params: unknown) =>
    callCore(WORKFLOW_VERSION_LIST_METHOD, params, WorkflowVersionListResult),
  )
  ipcMain.handle('agentra:workflow-version-get', (_event, params: unknown) =>
    callCore(WORKFLOW_VERSION_GET_METHOD, params, WorkflowVersionResult),
  )
  ipcMain.handle('agentra:workflow-version-create-draft', (_event, params: unknown) =>
    callCore(WORKFLOW_VERSION_CREATE_DRAFT_METHOD, params, WorkflowVersionResult),
  )
  ipcMain.handle('agentra:workflow-version-publish', (_event, params: unknown) =>
    callCore(WORKFLOW_VERSION_PUBLISH_METHOD, params, WorkflowVersionResult),
  )
  ipcMain.handle('agentra:workflow-version-validate', (_event, params: unknown) =>
    callCore(WORKFLOW_VERSION_VALIDATE_METHOD, params, WorkflowVersionValidateResult),
  )

  // 阶段 5 S5-3：审批中心 + 运行态查询。逐条显式通道，无通用透传；没有任何执行入口。
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
  ipcMain.handle('agentra:workflow-run-list-by-work', (_event, params: unknown) =>
    callCore(WORKFLOW_RUN_LIST_BY_WORK_METHOD, params, WorkflowRunListByWorkResult),
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
    width: 1180,
    height: 760,
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
