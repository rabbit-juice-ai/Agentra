export type Logger = (entry: LogEntry) => void

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  service: string
  message: string
  data?: Record<string, unknown>
  time: string
}

/**
 * 极简结构化 JSON 行日志：只写 stderr。
 *
 * 日志文件的唯一写入方是启动方的 stdio 重定向：daemon-launcher / core-launcher 把子进程的
 * stderr 指向 <role>.log。logger 不再自己写文件——两处同时写同一个文件会让每行重复一次。
 * 在前台直接运行（pnpm dev:*）时日志落在终端，这是期望行为。
 */
export function createLogger(service: string): {
  log: Logger
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
} {
  const write = (entry: LogEntry): void => {
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  }
  const log: Logger = (entry) => write(entry)
  const make =
    (level: LogEntry['level']) =>
    (message: string, data?: Record<string, unknown>): void => {
      write({ level, service, message, data, time: new Date().toISOString() })
    }
  return { log, info: make('info'), warn: make('warn'), error: make('error') }
}
