import type { StartExecutionConfig } from '@agentra/runtime-sdk'

/**
 * Claude Code 启动参数（参数数组，绝不拼接 shell 字符串）。
 * prompt 走 stdin 的 stream-json 帧，不进 argv（避免命令行泄露与转义问题）。
 */
export function buildClaudeArgs(config: StartExecutionConfig): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--input-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
  ]
  if (config.resumeSessionId) {
    args.push('--resume', config.resumeSessionId)
  } else {
    args.push('--session-id', config.sessionId)
  }
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

/**
 * 子进程环境：继承用户环境，但去掉 ELECTRON_RUN_AS_NODE
 * （Daemon 生产态经 ELECTRON_RUN_AS_NODE 运行，不能让 CLI 继承该模式）。
 */
export function buildChildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
