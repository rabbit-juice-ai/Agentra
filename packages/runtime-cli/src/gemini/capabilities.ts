import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const GEMINI_PROVIDER_ID = 'gemini'
export const GEMINI_PROVIDER_NAME = 'Gemini CLI'

/**
 * Gemini CLI headless 能力声明（`-p ... --output-format stream-json`）。
 * 单回合 JSONL；没有双向会话，sendMessage/resume 明确不支持。
 */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'emulated',
  resume: 'unsupported',
  checkpoint: 'unsupported',
  permissionRequests: 'unsupported',
  sessionPersistence: 'unsupported',
  workingDirectory: 'native',
  toolControl: 'emulated',
}
