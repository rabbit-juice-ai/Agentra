import type { StartExecutionConfig } from '@agentra/runtime-sdk'
import { OneShotCliProvider, type OneShotParseState } from '../one-shot/provider'
import { GROK_CAPABILITIES, GROK_PROVIDER_ID, GROK_PROVIDER_NAME } from './capabilities'
import { type DiscoveryOptions, discoverGrok, findGrokExecutable } from './discovery'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Grok CLI headless Provider。 */
export class GrokProvider extends OneShotCliProvider {
  readonly id = GROK_PROVIDER_ID
  readonly name = GROK_PROVIDER_NAME
  protected readonly capabilities = GROK_CAPABILITIES
  protected readonly installHint =
    'Grok CLI 未找到。请安装 Grok CLI 并将 grok 加入 PATH，或设置 AGENTRA_GROK_PATH。'
  private readonly discovery: DiscoveryOptions

  constructor(options: { executablePath?: string | null; discovery?: DiscoveryOptions } = {}) {
    const discovery = options.discovery ?? {}
    super(options.executablePath ?? findGrokExecutable(discovery.env, discovery.homeDir))
    this.discovery = discovery
  }

  async discover() {
    return [await discoverGrok(this.discovery)]
  }

  protected argsFor(config: StartExecutionConfig): string[] {
    const prompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${config.prompt}`
      : config.prompt
    const args = [
      '-p',
      prompt,
      '--output-format',
      'streaming-messages-json',
      '--cwd',
      config.workingDirectory,
    ]
    if (config.model) args.push('--model', config.model)
    const tools = config.allowedTools ?? []
    if (tools.includes('Bash')) args.push('--permission-mode', 'auto')
    else if (tools.some((tool) => WRITE_TOOLS.has(tool)))
      args.push('--permission-mode', 'acceptEdits')
    else args.push('--permission-mode', 'plan')
    for (const tool of config.allowedTools ?? []) args.push('--allow', tool)
    for (const tool of config.disallowedTools ?? []) args.push('--deny', tool)
    return args
  }

  protected parseLine(line: string, state: OneShotParseState): void {
    const parsed = JSON.parse(line) as {
      type?: unknown
      delta?: { type?: unknown; text?: unknown }
      message?: { content?: { type?: unknown; text?: unknown }[] }
      result?: unknown
      is_error?: unknown
      error?: { message?: unknown }
      messageText?: unknown
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      if (typeof parsed.delta.text === 'string') state.appendText(parsed.delta.text)
      return
    }
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      const text = parsed.message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (text.length > 0) state.setText(text)
      return
    }
    if (parsed.type === 'result') {
      if (parsed.is_error === true) {
        state.markError(
          typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : typeof parsed.result === 'string'
              ? parsed.result
              : 'Grok execution failed',
        )
      } else if (typeof parsed.result === 'string') {
        state.setText(parsed.result)
      }
      return
    }
    if (parsed.type === 'error') {
      state.markError(
        typeof parsed.error?.message === 'string' ? parsed.error.message : 'Grok execution failed',
      )
    }
  }
}
