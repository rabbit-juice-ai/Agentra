import type { ProviderCapabilities } from '@agentra/runtime-sdk'

export const GROK_PROVIDER_ID = 'grok'
export const GROK_PROVIDER_NAME = 'Grok CLI'

/** Grok CLI headless（`grok -p ... --output-format streaming-messages-json`）。 */
export const GROK_CAPABILITIES: ProviderCapabilities = {
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
