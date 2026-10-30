import { spawn } from 'node:child_process'

export type CommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const MAX_CAPTURE_BYTES = 1024 * 1024

/**
 * 运行外部命令：参数数组（绝不拼接 shell 字符串），带超时与输出上限。
 * 用于 discovery 的版本/认证探测，不用于执行 Agent 任务。
 */
export function runCommand(
  file: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_CAPTURE_BYTES
        ? current
        : (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}
