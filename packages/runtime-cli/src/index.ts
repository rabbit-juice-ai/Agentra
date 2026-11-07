export {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
} from './antigravity/capabilities'
export {
  type DiscoveryOptions as AntigravityDiscoveryOptions,
  discoverAntigravity,
  findAntigravityExecutable,
  parseVersion as parseAntigravityVersion,
} from './antigravity/discovery'
export { AntigravityProvider } from './antigravity/provider'
export { buildChildEnv, buildClaudeArgs } from './claude-code/args'
export {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_PROVIDER_NAME,
} from './claude-code/capabilities'
export {
  type AuthProbe,
  type DiscoveryOptions,
  discoverClaudeCode,
  findClaudeExecutable,
  interpretAuthStatus,
  parseVersion,
  type RunCommand,
} from './claude-code/discovery'
export { ClaudeCodeProvider } from './claude-code/provider'
export {
  buildInterruptFrame,
  buildUserFrame,
  type ParsedLine,
  parseStderrLine,
  parseStdoutLine,
  readResultFrame,
  splitLines,
} from './claude-code/stream-json'
export {
  CODEBUDDY_CAPABILITIES,
  CODEBUDDY_PROVIDER_ID,
  CODEBUDDY_PROVIDER_NAME,
} from './codebuddy/capabilities'
export {
  type DiscoveryOptions as CodeBuddyDiscoveryOptions,
  discoverCodeBuddy,
  findCodeBuddyExecutable,
  parseVersion as parseCodeBuddyVersion,
} from './codebuddy/discovery'
export { CodeBuddyProvider } from './codebuddy/provider'
export {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_NAME,
} from './codex/capabilities'
export {
  type DiscoveryOptions as CodexDiscoveryOptions,
  discoverCodex,
  findCodexExecutable,
  parseVersion as parseCodexVersion,
} from './codex/discovery'
export { CodexProvider } from './codex/provider'
export {
  GEMINI_CAPABILITIES,
  GEMINI_PROVIDER_ID,
  GEMINI_PROVIDER_NAME,
} from './gemini/capabilities'
export {
  type DiscoveryOptions as GeminiDiscoveryOptions,
  discoverGemini,
  findGeminiExecutable,
  parseVersion as parseGeminiVersion,
} from './gemini/discovery'
export { GeminiProvider } from './gemini/provider'
export {
  GROK_CAPABILITIES,
  GROK_PROVIDER_ID,
  GROK_PROVIDER_NAME,
} from './grok/capabilities'
export {
  type DiscoveryOptions as GrokDiscoveryOptions,
  discoverGrok,
  findGrokExecutable,
  parseVersion as parseGrokVersion,
} from './grok/discovery'
export { GrokProvider } from './grok/provider'
export { OneShotCliProvider, type OneShotParseState } from './one-shot/provider'
export { type CommandResult, runCommand } from './run-command'
// 测试夹具路径（仅测试使用；夹具脚本不参与生产构建）。
export { FAKE_CLAUDE_PATH } from './test-fixtures'
