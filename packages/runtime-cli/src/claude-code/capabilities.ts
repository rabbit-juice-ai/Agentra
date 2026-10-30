import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_PROVIDER_NAME = 'Claude Code'

/**
 * Claude Code 能力声明（阶段 1 实测）。
 * checkpoint 不支持，必须显式声明 unsupported，不得伪装成 native。
 */
export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'native',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
}
