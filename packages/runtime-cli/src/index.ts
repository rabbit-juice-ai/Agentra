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
export { type CommandResult, runCommand } from './run-command'
// 测试夹具路径（仅测试使用；夹具脚本不参与生产构建）。
export { FAKE_CLAUDE_PATH } from './test-fixtures'
