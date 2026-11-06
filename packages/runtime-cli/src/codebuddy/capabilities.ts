import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const CODEBUDDY_PROVIDER_ID = 'codebuddy'
export const CODEBUDDY_PROVIDER_NAME = 'CodeBuddy'

/** CodeBuddy CLI 是 Claude Code 兼容的 stream-json 会话；能力口径与 Claude 适配器一致。 */
export const CODEBUDDY_CAPABILITIES: ProviderCapabilities = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'unsupported',
  checkpoint: 'unsupported',
  permissionRequests: 'unsupported',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
}
