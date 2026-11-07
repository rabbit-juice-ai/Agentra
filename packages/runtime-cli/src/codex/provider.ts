import type { ProviderModelInfo, StartExecutionConfig } from '@agentra/runtime-sdk'
import { OneShotCliProvider, type OneShotParseState } from '../one-shot/provider'
import { CODEX_CAPABILITIES, CODEX_PROVIDER_ID, CODEX_PROVIDER_NAME } from './capabilities'
import { type DiscoveryOptions, discoverCodex, findCodexExecutable } from './discovery'
import { discoverCodexModels } from './models'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** Codex CLI headless Provider（`codex exec --json`）。 */
export class CodexProvider extends OneShotCliProvider {
  readonly id = CODEX_PROVIDER_ID
  readonly name = CODEX_PROVIDER_NAME
  protected readonly capabilities = CODEX_CAPABILITIES
  protected readonly installHint =
    'Codex CLI 未找到。请安装 Codex 并将 codex 加入 PATH，或设置 AGENTRA_CODEX_PATH。'
  private readonly discovery: DiscoveryOptions

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    const discovery = options.discovery ?? {}
    super(options.executablePath ?? findCodexExecutable(discovery.env, discovery.homeDir))
    this.discovery = discovery
  }

  async discover() {
    return [await discoverCodex(this.discovery)]
  }

  /** 读取 cc-switch 模型目录或 Codex 当前配置的 model。 */
  async listModels(): Promise<ProviderModelInfo[]> {
    return discoverCodexModels({
      env: this.discovery.env,
      homeDir: this.discovery.homeDir,
    })
  }

  protected argsFor(config: StartExecutionConfig): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-C',
      config.workingDirectory,
    ]
    if (config.model) args.push('-m', config.model)
    const canWrite = (config.allowedTools ?? []).some((tool) => WRITE_TOOLS.has(tool))
    if (canWrite) args.push('--sandbox', 'workspace-write', '--approve-for-me')
    else args.push('--sandbox', 'read-only')
    const prompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${config.prompt}`
      : config.prompt
    args.push(prompt)
    return args
  }

  protected parseLine(line: string, state: OneShotParseState): void {
    const parsed = JSON.parse(line) as {
      type?: unknown
      item?: { type?: unknown; text?: unknown }
      message?: unknown
      error?: { message?: unknown }
    }
    if (
      parsed.type === 'item.completed' &&
      parsed.item?.type === 'agent_message' &&
      typeof parsed.item.text === 'string'
    ) {
      state.setText(parsed.item.text)
      return
    }
    if (parsed.type === 'turn.failed' || parsed.type === 'error') {
      const message =
        (typeof parsed.message === 'string' ? parsed.message : null) ??
        (typeof parsed.error?.message === 'string' ? parsed.error.message : null) ??
        'Codex execution failed'
      state.markError(message)
    }
  }
}
