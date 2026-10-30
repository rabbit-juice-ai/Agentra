import { contextBridge, ipcRenderer } from 'electron'

/** Preload 暴露最小白名单 API（contextIsolation 下 renderer 唯一入口）。 */
const api = {
  getCoreHealth: () => ipcRenderer.invoke('agentra:core-health'),
  getDaemonHealth: () => ipcRenderer.invoke('agentra:daemon-health'),
}

export type AgentraApi = typeof api

contextBridge.exposeInMainWorld('agentra', api)
