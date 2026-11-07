import type { ProviderModelInfo, StartExecutionConfig } from '@agentra/runtime-sdk'
import { parseTabbedModels } from '../one-shot/models'
import { OneShotCliProvider, type OneShotParseState } from '../one-shot/provider'
import { runCommand } from '../run-command'
import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
} from './capabilities'
import { type DiscoveryOptions, discoverAntigravity, findAntigravityExecutable } from './discovery'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Antigravity CLI headless Provider（`agy -p ... --output-format stream-json`）。
 * CLI 没有逐工具 allow/deny 参数：编辑权限需要放开审批；只读权限保持默认审批模式。
 */
export class AntigravityProvider extends OneShotCliProvider {
  readonly id = ANTIGRAVITY_PROVIDER_ID
  readonly name = ANTIGRAVITY_PROVIDER_NAME
  protected readonly capabilities = ANTIGRAVITY_CAPABILITIES
  protected readonly installHint =
    'Antigravity CLI 未找到。请安装 Antigravity CLI（`agy`）并加入 PATH，或设置 AGENTRA_ANTIGRAVITY_PATH。'
  private readonly discovery: DiscoveryOptions

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    const discovery = options.discovery ?? {}
    super(options.executablePath ?? findAntigravityExecutable(discovery.env, discovery.homeDir))
    this.discovery = discovery
  }

  async discover() {
    return [await discoverAntigravity(this.discovery)]
  }

  /** `agy models`：真实可用模型列表；命令失败时返回空，由 Core 回退内置目录。 */
  async listModels(): Promise<ProviderModelInfo[]> {
    if (!this.executablePath) return []
    const run = this.discovery.run ?? runCommand
    try {
      const result = await run(this.executablePath, ['models'], {
        env: this.discovery.env,
        timeoutMs: 8000,
      })
      return result.code === 0 ? parseTabbedModels(result.stdout) : []
    } catch {
      return []
    }
  }

  protected argsFor(config: StartExecutionConfig): string[] {
    const prompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${config.prompt}`
      : config.prompt
    const args = ['-p', prompt, '--output-format', 'stream-json']
    if (config.model) args.push('--model', config.model)
    const tools = config.allowedTools ?? []
    if (tools.some((tool) => WRITE_TOOLS.has(tool))) {
      args.push('--dangerously-skip-permissions')
    }
    return args
  }

  protected parseLine(line: string, state: OneShotParseState): void {
    const parsed = JSON.parse(line) as {
      event?: unknown
      type?: unknown
      step_update?: { text_delta?: unknown }
      result?: { response?: unknown; status?: unknown; error?: unknown } | unknown
      response?: unknown
      status?: unknown
      error?: unknown
    }
    const event = typeof parsed.event === 'string' ? parsed.event : parsed.type
    if (event === 'step_update') {
      const delta = parsed.step_update?.text_delta
      if (typeof delta === 'string') state.appendText(delta)
      return
    }
    if (event === 'result') {
      const result =
        parsed.result && typeof parsed.result === 'object'
          ? (parsed.result as { response?: unknown; status?: unknown; error?: unknown })
          : parsed
      const status = typeof result.status === 'string' ? result.status : null
      if (status !== null && status !== 'SUCCESS') {
        const error =
          typeof result.error === 'string'
            ? result.error
            : result.error && typeof result.error === 'object'
              ? JSON.stringify(result.error)
              : `Antigravity execution ended with ${status}`
        state.markError(error)
        return
      }
      if (typeof result.response === 'string') state.setText(result.response)
      return
    }
  }
}
