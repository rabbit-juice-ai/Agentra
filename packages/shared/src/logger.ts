import fs from 'node:fs'
import path from 'node:path'

export type Logger = (entry: LogEntry) => void

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  service: string
  message: string
  data?: Record<string, unknown>
  time: string
}

/** 极简结构化 JSON 行日志：写 stderr + 可选日志文件。 */
export function createLogger(
  service: string,
  logFile?: string,
): {
  log: Logger
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
} {
  const write = (entry: LogEntry): void => {
    const line = JSON.stringify(entry)
    process.stderr.write(`${line}\n`)
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
        fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 })
      } catch {
        // 日志文件写入失败不阻断主流程；stderr 已有记录。
      }
    }
  }
  const log: Logger = (entry) => write(entry)
  const make =
    (level: LogEntry['level']) =>
    (message: string, data?: Record<string, unknown>): void => {
      write({ level, service, message, data, time: new Date().toISOString() })
    }
  return { log, info: make('info'), warn: make('warn'), error: make('error') }
}
