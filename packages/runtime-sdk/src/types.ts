import type { ProviderCapabilities } from './capabilities'

export const PROVIDER_HEALTH_STATUSES = [
  'healthy',
  'unavailable',
  'unauthenticated',
  'unknown',
] as const
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number]

export type RuntimeHealth = {
  status: ProviderHealthStatus
  /** 面向用户的可执行提示（如安装路径、登录命令），不含任何凭据。 */
  detail: string
  checkedAt: string
}

/** CLI 自动发现结果：路径、版本、可执行性、认证信息与能力声明。 */
export type RuntimeInfo = {
  providerId: string
  providerType: 'cli' | 'acp' | 'remote'
  providerName: string
  executablePath: string | null
  version: string | null
  capabilities: ProviderCapabilities
  /** 发现时的健康状态；与 runtime_providers.health_status 同口径。 */
  healthStatus: ProviderHealthStatus
  /** 面向用户的可执行提示（安装路径、登录命令），不含任何凭据。 */
  healthDetail: string
  /** 认证方式描述（oauth_token / api_key / none），不含 token 本身。 */
  authMethod: string | null
  discoveredAt: string
}

export type RuntimeConfig = {
  providerId: string
  executablePath: string | null
}

export type StartExecutionConfig = {
  executionId: string
  prompt: string
  workingDirectory: string
  /** Claude Code 的 --session-id（首次）或 --resume（续接）。 */
  sessionId: string
  resumeSessionId?: string
  systemPrompt?: string
  model?: string
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  /** 平台无关的环境变量覆盖（不依赖 Node 类型，保持 SDK 中立）。 */
  env?: Record<string, string | undefined>
}

export type ExecutionHandle = {
  executionId: string
  providerId: string
  processId: number | null
  startedAt: string
}

export type RuntimeMessage = {
  role: 'user'
  content: string
}

export type InterruptResult = {
  interrupted: boolean
  detail?: string
}

export const EXECUTION_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'crashed',
] as const
export type ExecutionState = (typeof EXECUTION_STATES)[number]

export type ExecutionStatus = {
  executionId: string
  status: ExecutionState
  processId: number | null
  exitCode: number | null
  startedAt: string | null
  endedAt: string | null
}

export type OutputStream = 'stdout' | 'stderr' | 'structured' | 'system'

/** Provider 向宿主上报的运行时事件（宿主负责分配 eventId/sequenceNo 并转发 Core）。 */
export type RuntimeEvent =
  | {
      type: 'output'
      stream: OutputStream
      content: string
      timestamp: string
    }
  | {
      type: 'state'
      status: ExecutionState
      previousStatus: ExecutionState | null
      detail?: string
      timestamp: string
    }
  | {
      type: 'exited'
      exitCode: number | null
      signal: string | null
      reason: 'exited' | 'crashed' | 'cancelled'
      timestamp: string
    }

export type RuntimeEventListener = (event: RuntimeEvent) => void
export type Unsubscribe = () => void
