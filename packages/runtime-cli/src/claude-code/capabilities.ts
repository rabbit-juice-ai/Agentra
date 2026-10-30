import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_PROVIDER_NAME = 'Claude Code'

/**
 * Claude Code 能力声明（阶段 1 实测）。
 *
 * 语义：capabilities 描述**当前适配器可被调用方使用的能力**，不是底层 CLI 的原始能力。
 * - 声明 native/emulated 的能力必须有可执行实现路径（见 capabilities-consistency.test.ts）；
 * - 声明 unsupported 的能力不得有可用路径，调用必须返回 CAPABILITY_UNSUPPORTED。
 * 禁止把"底层支持但适配器未实现"标成 native。
 */
export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  // CLI 支持 --resume，但阶段 1 适配器不暴露恢复入口（无 Work/审批上下文），故按适配器口径声明 unsupported。
  resume: 'unsupported',
  checkpoint: 'unsupported',
  // CLI 有 --permission-prompt-tool stdio，但适配器未实现权限请求帧的收发，故声明 unsupported。
  permissionRequests: 'unsupported',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
}
