import fs from 'node:fs'
import { agentraHome, agentraPaths, createLogger, ensureDirs } from '@agentra/shared'
import { startNdjsonServer } from './rpc/ndjson-server'
import { daemonHealthMethods } from './services/health'

const VERSION = '0.1.0'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('daemon', paths.daemonLog)

  // pid 文件：探活与 stop 脚本使用。
  fs.writeFileSync(paths.daemonPid, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), protocolVersion: '1', socketPath: paths.daemonSocket }), { mode: 0o600 })

  const server = await startNdjsonServer(paths.daemonSocket, daemonHealthMethods(VERSION), (error) => {
    logger.error('daemon server error', { error: error.message })
  })

  logger.info('daemon started', { socketPath: server.socketPath, pid: process.pid, version: VERSION })

  const shutdown = (signal: string) => {
    logger.info('daemon shutting down', { signal })
    server.close()
    try {
      fs.unlinkSync(paths.daemonPid)
    } catch {
      // 忽略。
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 被直接运行时启动（tsx / node dist）；被测试导入时不自动启动。
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('daemon/index.js')) {
  void main()
}
