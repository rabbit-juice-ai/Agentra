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
  getAppInfo: () => ipcRenderer.invoke('agentra:app-info'),
  openDataDir: () => ipcRenderer.invoke('agentra:open-data-dir'),

  listAgents: (params) => ipcRenderer.invoke('agentra:agent-list', params ?? {}),
  createAgent: (params) => ipcRenderer.invoke('agentra:agent-create', params),
  updateAgent: (params) => ipcRenderer.invoke('agentra:agent-update', params),
  archiveAgent: (params) => ipcRenderer.invoke('agentra:agent-archive', params),
  generateAgentDraft: (params) => ipcRenderer.invoke('agentra:agent-generate-draft', params),

  listProviders: () => ipcRenderer.invoke('agentra:provider-list'),
  refreshProviders: () => ipcRenderer.invoke('agentra:provider-refresh'),
  listProviderModels: (params) => ipcRenderer.invoke('agentra:provider-models', params),

  listSkills: () => ipcRenderer.invoke('agentra:skill-list'),
  createSkill: (params) => ipcRenderer.invoke('agentra:skill-create', params),
  updateSkill: (params) => ipcRenderer.invoke('agentra:skill-update', params),
  deleteSkill: (params) => ipcRenderer.invoke('agentra:skill-delete', params),

  generatePlan: (params) => ipcRenderer.invoke('agentra:plan-generate', params),
  getPlan: (params) => ipcRenderer.invoke('agentra:plan-get', params),
  listPlansByWork: (params) => ipcRenderer.invoke('agentra:plan-list-by-work', params),
  listRecentPlans: (params) => ipcRenderer.invoke('agentra:plan-list-recent', params ?? {}),
  convertPlanToTask: (params) => ipcRenderer.invoke('agentra:plan-convert-to-task', params),
  convertPlanToProject: (params) => ipcRenderer.invoke('agentra:plan-convert-to-project', params),
  approvePlan: (params) => ipcRenderer.invoke('agentra:plan-approve', params),
  rejectPlan: (params) => ipcRenderer.invoke('agentra:plan-reject', params),
  startPlanRun: (params) => ipcRenderer.invoke('agentra:plan-start-run', params),
  listPlanThreads: (params) => ipcRenderer.invoke('agentra:plan-thread-list', params),
  commentOnPlan: (params) => ipcRenderer.invoke('agentra:plan-comment', params),
  reassignPlanTask: (params) => ipcRenderer.invoke('agentra:plan-reassign-task', params),
  continuePlanRework: (params) => ipcRenderer.invoke('agentra:plan-continue-rework', params),
  takeOverPlanRework: (params) => ipcRenderer.invoke('agentra:plan-take-over-rework', params),

  listTeams: (params) => ipcRenderer.invoke('agentra:team-list', params ?? {}),
  getTeam: (params) => ipcRenderer.invoke('agentra:team-get', params),
  createTeam: (params) => ipcRenderer.invoke('agentra:team-create', params),
  updateTeam: (params) => ipcRenderer.invoke('agentra:team-update', params),
  archiveTeam: (params) => ipcRenderer.invoke('agentra:team-archive', params),
  listTeamMembers: (params) => ipcRenderer.invoke('agentra:team-member-list', params),
  addTeamMember: (params) => ipcRenderer.invoke('agentra:team-member-add', params),
  removeTeamMember: (params) => ipcRenderer.invoke('agentra:team-member-remove', params),

  listProjects: () => ipcRenderer.invoke('agentra:project-list', {}),
  getProject: (params) => ipcRenderer.invoke('agentra:project-get', params),
  createProject: (params) => ipcRenderer.invoke('agentra:project-create', params),
  updateProject: (params) => ipcRenderer.invoke('agentra:project-update', params),
  listWorks: (params) => ipcRenderer.invoke('agentra:work-list', params ?? {}),
  createWork: (params) => ipcRenderer.invoke('agentra:work-create', params),
  linkWorkTeam: (params) => ipcRenderer.invoke('agentra:work-link-team', params),
  activateWork: (params) => ipcRenderer.invoke('agentra:work-activate', params),
  pauseWork: (params) => ipcRenderer.invoke('agentra:work-pause', params),
  resumeWork: (params) => ipcRenderer.invoke('agentra:work-resume', params),
  completeWork: (params) => ipcRenderer.invoke('agentra:work-complete', params),

  listWorktrees: (params) => ipcRenderer.invoke('agentra:worktree-list', params),
  createWorktree: (params) => ipcRenderer.invoke('agentra:worktree-create', params),
  removeWorktree: (params) => ipcRenderer.invoke('agentra:worktree-remove', params),

  listAssignments: (params) => ipcRenderer.invoke('agentra:assignment-list', params),
  createAssignment: (params) => ipcRenderer.invoke('agentra:assignment-create', params),
  pauseAssignment: (params) => ipcRenderer.invoke('agentra:assignment-pause', params),
  resumeAssignment: (params) => ipcRenderer.invoke('agentra:assignment-resume', params),
  completeAssignment: (params) => ipcRenderer.invoke('agentra:assignment-complete', params),

  startExecution: (params) => ipcRenderer.invoke('agentra:execution-start', params),
  getExecution: (params) => ipcRenderer.invoke('agentra:execution-get', params),
  listExecutions: (params) => ipcRenderer.invoke('agentra:execution-list', params ?? {}),
  getExecutionLogs: (params) => ipcRenderer.invoke('agentra:execution-logs', params),
  cancelExecution: (params) => ipcRenderer.invoke('agentra:execution-cancel', params),
  interruptExecution: (params) => ipcRenderer.invoke('agentra:execution-interrupt', params),
  sendExecutionMessage: (params) => ipcRenderer.invoke('agentra:execution-send-message', params),

  decideApproval: (params) => ipcRenderer.invoke('agentra:approval-decide', params),
  getApproval: (params) => ipcRenderer.invoke('agentra:approval-get', params),
  listPendingApprovals: (params) => ipcRenderer.invoke('agentra:approval-list-pending', params),
  getWorkflowRun: (params) => ipcRenderer.invoke('agentra:workflow-run-get', params),
  listArtifacts: (params) => ipcRenderer.invoke('agentra:artifact-list', params),
  previewArtifact: (params) => ipcRenderer.invoke('agentra:artifact-preview', params),

  createBackup: () => ipcRenderer.invoke('agentra:backup-create'),
  listBackups: (params) => ipcRenderer.invoke('agentra:backup-list', params ?? {}),
  exportBackup: (params) => ipcRenderer.invoke('agentra:backup-export', params),
  restorePrecheck: (params) => ipcRenderer.invoke('agentra:backup-restore-precheck', params),
  restoreBackup: (params) => ipcRenderer.invoke('agentra:backup-restore', params),
  getRestoreStatus: (params) => ipcRenderer.invoke('agentra:restore-status', params ?? {}),

  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: RuntimeEvent): void => listener(payload)
    ipcRenderer.on('agentra:event', handler)
    return () => {
      ipcRenderer.removeListener('agentra:event', handler)
    }
  },

  onCoreReady: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('agentra:core-ready', handler)
    return () => {
      ipcRenderer.removeListener('agentra:core-ready', handler)
    }
  },
}

contextBridge.exposeInMainWorld('agentra', api)

export type { AgentraApi }
