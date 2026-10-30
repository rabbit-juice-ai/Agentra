import type { RuntimeEvent } from '@agentra/protocol'
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import type { AgentraApi } from '../shared/api'

/**
 * Preload 暴露最小白名单 API（contextIsolation 下 renderer 唯一入口）。
 * 每个方法对应主进程一个显式 IPC 通道；不存在通用 RPC 透传。
 */
const api: AgentraApi = {
  getCoreHealth: () => ipcRenderer.invoke('agentra:core-health'),
  getDaemonHealth: () => ipcRenderer.invoke('agentra:daemon-health'),

  listAgents: (params) => ipcRenderer.invoke('agentra:agent-list', params ?? {}),
  createAgent: (params) => ipcRenderer.invoke('agentra:agent-create', params),
  updateAgent: (params) => ipcRenderer.invoke('agentra:agent-update', params),
  archiveAgent: (params) => ipcRenderer.invoke('agentra:agent-archive', params),

  listProviders: () => ipcRenderer.invoke('agentra:provider-list'),
  refreshProviders: () => ipcRenderer.invoke('agentra:provider-refresh'),

  startExecution: (params) => ipcRenderer.invoke('agentra:execution-start', params),
  getExecution: (params) => ipcRenderer.invoke('agentra:execution-get', params),
  listExecutions: (params) => ipcRenderer.invoke('agentra:execution-list', params ?? {}),
  getExecutionLogs: (params) => ipcRenderer.invoke('agentra:execution-logs', params),
  cancelExecution: (params) => ipcRenderer.invoke('agentra:execution-cancel', params),
  interruptExecution: (params) => ipcRenderer.invoke('agentra:execution-interrupt', params),
  sendExecutionMessage: (params) => ipcRenderer.invoke('agentra:execution-send-message', params),

  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: RuntimeEvent): void => listener(payload)
    ipcRenderer.on('agentra:event', handler)
    return () => {
      ipcRenderer.removeListener('agentra:event', handler)
    }
  },
}

contextBridge.exposeInMainWorld('agentra', api)

export type { AgentraApi }
