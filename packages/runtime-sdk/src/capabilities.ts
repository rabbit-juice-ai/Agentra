import { z } from 'zod'

/**
 * Provider 能力模型（ARCHITECTURE §5）。
 * 能力状态必须显式声明，禁止把“停止后重新启动”标成原生恢复。
 */
export const CAPABILITY_NAMES = [
  'streaming',
  'structuredEvents',
  'interrupt',
  'resume',
  'checkpoint',
  'permissionRequests',
  'sessionPersistence',
  'workingDirectory',
  'toolControl',
] as const

export const CapabilityName = z.enum(CAPABILITY_NAMES)
export type CapabilityName = z.infer<typeof CapabilityName>

export const CapabilitySupport = z.enum(['native', 'emulated', 'unsupported'])
export type CapabilitySupport = z.infer<typeof CapabilitySupport>

/** 持久化到 runtime_providers.capabilities_json 的结构：九项能力必须全部声明。 */
export const ProviderCapabilities = z.object({
  streaming: CapabilitySupport,
  structuredEvents: CapabilitySupport,
  interrupt: CapabilitySupport,
  resume: CapabilitySupport,
  checkpoint: CapabilitySupport,
  permissionRequests: CapabilitySupport,
  sessionPersistence: CapabilitySupport,
  workingDirectory: CapabilitySupport,
  toolControl: CapabilitySupport,
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

/** 能力是否可被调用：native / emulated 可用，unsupported 一律拒绝。 */
export function isCapabilityUsable(
  capabilities: ProviderCapabilities,
  name: CapabilityName,
): boolean {
  return capabilities[name] !== 'unsupported'
}
