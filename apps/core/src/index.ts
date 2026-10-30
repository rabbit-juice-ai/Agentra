import fs from 'node:fs'
import { agentraHome, agentraPaths, createLogger, ensureDirs } from '@agentra/shared'
import { ensureDaemon } from './daemon-launcher'
import { startWsServer } from './rpc/ws-server'
import { coreHealthMethods } from './services/health'

const VERSION = '0.1.0'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('core', paths.coreLog)

  // 启动链：Core 负责 Daemon 存活（探活优先，附着已有实例）。
  const daemon = await ensureDaemon(paths, env)
  logger.info('daemon ensured', { spawned: daemon.spawned, socket: paths.daemonSocket })

  fs.writeFileSync(paths.corePid, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), protocolVersion: '1', socketPath: paths.coreSocket }), { mode: 0o600 })

  const server = await startWsServer(paths.coreSocket, coreHealthMethods(VERSION, paths.daemonSocket))
  logger.info('core started', { socketPath: server.socketPath, pid: process.pid, version: VERSION, daemonSpawned: daemon.spawned })

  const shutdown = (signal: string) => {
    logger.info('core shutting down', { signal })
    server.close()
    try {
      fs.unlinkSync(paths.corePid)
    } catch {
      // 忽略。
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 被直接运行时启动；被测试导入时不自动启动。
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('core/index.js')) {
  void main()
}
