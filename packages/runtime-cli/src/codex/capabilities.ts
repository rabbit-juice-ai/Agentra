import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_PROVIDER_NAME = 'Codex'

/**
 * Codex CLI headless 能力声明。
 * `codex exec --json` 是单回合 JSONL 输出；没有双向 stream-json 会话，
 * 因此 sendMessage/resume/sessionPersistence 明确不支持。
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
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
