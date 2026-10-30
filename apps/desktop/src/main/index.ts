import path from 'node:path'
import { CORE_HEALTH_METHOD, DAEMON_HEALTH_METHOD } from '@agentra/protocol'
import { agentraPaths } from '@agentra/shared'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ensureCore } from './core-launcher'
import { CoreRpcClient } from './rpc-client'

// 窗口级单实例：第二次启动聚焦已有窗口（与 Core/Daemon 的 socket 探活是两回事）。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let client: CoreRpcClient | null = null
let lastError: string | null = null

async function callCore(
  method: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!client) return { ok: false, error: lastError ?? 'core not connected' }
  try {
    const response = await client.call(method)
    if (response.ok) return { ok: true, result: response.result }
    return { ok: false, error: `${response.error.code}: ${response.error.message}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function registerIpc(): void {
  ipcMain.handle('agentra:core-health', () => callCore(CORE_HEALTH_METHOD))
  ipcMain.handle('agentra:daemon-health', () => callCore(DAEMON_HEALTH_METHOD))
}

async function connectCore(): Promise<void> {
  const paths = agentraPaths()
  try {
    await ensureCore(paths)
    client = new CoreRpcClient(paths.coreSocket)
    await client.connect()
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    // 不抛出：UI 显示断连态，重试由用户刷新触发。
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
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
  client?.close()
  app.quit()
})
