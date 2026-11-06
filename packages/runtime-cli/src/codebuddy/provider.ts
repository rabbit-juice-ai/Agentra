import type { StartExecutionConfig } from '@agentra/runtime-sdk'
import { ClaudeCodeProvider } from '../claude-code/provider'
import { CODEBUDDY_CAPABILITIES, CODEBUDDY_PROVIDER_ID } from './capabilities'
import { type DiscoveryOptions, discoverCodeBuddy } from './discovery'

/** CodeBuddy CLI（Claude Code 兼容 stream-json 会话）。 */
export class CodeBuddyProvider extends ClaudeCodeProvider {
  override readonly id = CODEBUDDY_PROVIDER_ID
  override readonly capabilities = CODEBUDDY_CAPABILITIES
  override readonly cliName = 'CodeBuddy'

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    super(options)
  }

  protected override async discoverInfo() {
    return discoverCodeBuddy({
      ...(this.discovery ?? {}),
      ...(this.injectedPath
        ? {
            env: {
              ...(this.discovery?.env ?? process.env),
              AGENTRA_CODEBUDDY_PATH: this.injectedPath,
            },
          }
        : {}),
    })
  }

  protected override buildArgs(config: StartExecutionConfig): string[] {
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
    ]
    if (config.resumeSessionId) args.push('--resume', config.resumeSessionId)
    else args.push('--session-id', config.sessionId)
    if (config.model) args.push('--model', config.model)
    if (config.permissionMode) args.push('--permission-mode', config.permissionMode)
    if (config.systemPrompt) args.push('--append-system-prompt', config.systemPrompt)
    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push('--allowedTools', ...config.allowedTools)
    }
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      args.push('--disallowedTools', ...config.disallowedTools)
    }
    return args
  }
}
