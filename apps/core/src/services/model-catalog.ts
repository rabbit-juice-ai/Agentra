import type { RuntimeProviderModel } from '@agentra/protocol'

/**
 * Provider 的模型候选（内置目录）。
 * 各 CLI 没有统一的「列出模型」协议；这里只提供常见别名，表单始终允许填写自定义模型 ID。
 * 目录不参与校验：Provider 收到未知模型时自行报错，Core 不猜。
 */
const MODEL_CATALOG: Record<string, RuntimeProviderModel[]> = {
  'Claude Code': [
    { id: 'sonnet', label: 'Sonnet（均衡，默认）' },
    { id: 'opus', label: 'Opus（最强推理）' },
    { id: 'haiku', label: 'Haiku（快速）' },
  ],
  CodeBuddy: [],
  Codex: [
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex（默认）' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', label: 'GPT-5.1' },
    { id: 'o3', label: 'o3' },
  ],
  'Gemini CLI': [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  'Grok CLI': [
    { id: 'grok-4.6', label: 'Grok 4.6（默认）' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
  ],
  'Antigravity CLI': [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
}

export function modelsForProvider(providerName: string): RuntimeProviderModel[] {
  return (MODEL_CATALOG[providerName] ?? []).map((model) => ({ ...model }))
}
