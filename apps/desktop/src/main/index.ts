import path from 'node:path'
import {
  AGENT_ARCHIVE_METHOD,
  AGENT_CREATE_METHOD,
  AGENT_LIST_METHOD,
  AGENT_UPDATE_METHOD,
  AgentListResult,
  AgentResult,
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
} from '@agentra/protocol'
import { agentraPaths } from '@agentra/shared'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { RpcResult } from '../shared/api'
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
): Promise<RpcResult<T>> {
  const active = client
  if (!active) {
    return { ok: false, error: { code: 'NOT_READY', message: lastError ?? 'core not connected' } }
  }
  try {
    const response = await active.call(method, params)
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
}

function broadcastEvent(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agentra:event', event)
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
