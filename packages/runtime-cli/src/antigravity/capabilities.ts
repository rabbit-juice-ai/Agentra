import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'
export const ANTIGRAVITY_PROVIDER_NAME = 'Antigravity CLI'

/**
 * Antigravity CLI headless 能力声明（`agy -p ... --output-format stream-json`）。
 * 单回合 JSONL；没有双向会话，sendMessage/resume 明确不支持。
 * 权限由 CLI 自身审批模式控制：只读权限保持默认（写入会被软拒绝），
 * 编辑权限通过 `--dangerously-skip-permissions` 放开。
 */
export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = {
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
