import type { StartExecutionConfig } from '@agentra/runtime-sdk'
import { OneShotCliProvider, type OneShotParseState } from '../one-shot/provider'
import { GEMINI_CAPABILITIES, GEMINI_PROVIDER_ID, GEMINI_PROVIDER_NAME } from './capabilities'
import { type DiscoveryOptions, discoverGemini, findGeminiExecutable } from './discovery'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Gemini CLI headless Provider（`gemini -p ... --output-format stream-json`）。 */
export class GeminiProvider extends OneShotCliProvider {
  readonly id = GEMINI_PROVIDER_ID
  readonly name = GEMINI_PROVIDER_NAME
  protected readonly capabilities = GEMINI_CAPABILITIES
  protected readonly installHint =
    'Gemini CLI 未找到。请安装 Gemini CLI 并将 gemini 加入 PATH，或设置 AGENTRA_GEMINI_PATH。'
  private readonly discovery: DiscoveryOptions

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    const discovery = options.discovery ?? {}
    super(options.executablePath ?? findGeminiExecutable(discovery.env, discovery.homeDir))
    this.discovery = discovery
  }

  async discover() {
    return [await discoverGemini(this.discovery)]
  }

  protected argsFor(config: StartExecutionConfig): string[] {
    const prompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${config.prompt}`
      : config.prompt
    const args = ['-p', prompt, '--output-format', 'stream-json', '--skip-trust']
    if (config.model) args.push('-m', config.model)
    const tools = config.allowedTools ?? []
    if (tools.includes('Bash')) args.push('--approval-mode', 'yolo')
    else if (tools.some((tool) => WRITE_TOOLS.has(tool))) args.push('--approval-mode', 'auto_edit')
    else args.push('--approval-mode', 'plan')
    return args
  }

  protected parseLine(line: string, state: OneShotParseState): void {
    const parsed = JSON.parse(line) as {
      type?: unknown
      role?: unknown
      content?: unknown
      delta?: unknown
      status?: unknown
      error?: { message?: unknown }
    }
    if (
      parsed.type === 'message' &&
      parsed.role === 'assistant' &&
      typeof parsed.content === 'string'
    ) {
      if (parsed.delta === true) state.appendText(parsed.content)
      else state.setText(parsed.content)
      return
    }
    if (parsed.type === 'result' && parsed.status === 'error') {
      const message =
        typeof parsed.error?.message === 'string' ? parsed.error.message : 'Gemini execution failed'
      state.markError(message)
    }
  }
}
