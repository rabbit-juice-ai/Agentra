import fs from 'node:fs'
import { PROTOCOL_VERSION } from '@agentra/protocol'
import {
  ClaudeCodeProvider,
  CodeBuddyProvider,
  CodexProvider,
  GeminiProvider,
  GrokProvider,
} from '@agentra/runtime-cli'
import { agentraHome, agentraPaths, createLogger, ensureDirs, isDirectRun } from '@agentra/shared'
import { startNdjsonServer } from './rpc/ndjson-server'
import { RuntimeEventHub } from './runtime/event-hub'
import { ExecutionManager } from './runtime/execution-manager'
import { daemonHealthMethods } from './services/health'
import { runtimeMethods } from './services/runtime'

const VERSION = '0.1.0'

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = agentraHome(env)
  const paths = agentraPaths(home)
  ensureDirs(paths)
  const logger = createLogger('daemon')

  const hub = new RuntimeEventHub()
  const providers = [
    new ClaudeCodeProvider({ discovery: { env } }),
    new CodexProvider({ discovery: { env } }),
    new GeminiProvider({ discovery: { env } }),
    new CodeBuddyProvider({ discovery: { env } }),
    new GrokProvider({ discovery: { env } }),
  ]
  // 启动即发现：把路径/版本/认证状态带入进程，供 Core 的 runtime.provider.refresh 读取。
  for (const provider of providers) {
    try {
      const [info] = await provider.discover()
      logger.info('runtime provider discovered', {
        providerId: info?.providerId,
        executablePath: info?.executablePath,
        version: info?.version,
        healthStatus: info?.healthStatus,
      })
    } catch (error) {
      logger.warn('runtime provider discovery failed', {
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const manager = new ExecutionManager({
    scratchRoot: paths.scratch,
    providers: new Map(providers.map((provider) => [provider.id, provider])),
    hub,
    logger,
  })

  // pid 文件：探活与 stop 脚本使用。
  fs.writeFileSync(
    paths.daemonPid,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      socketPath: paths.daemonSocket,
    }),
    { mode: 0o600 },
  )

  const server = await startNdjsonServer(
    paths.daemonSocket,
    { ...daemonHealthMethods(VERSION), ...runtimeMethods(manager, hub) },
    (error) => {
      logger.error('daemon server error', { error: error.message })
    },
  )

  logger.info('daemon started', {
    socketPath: server.socketPath,
    pid: process.pid,
    version: VERSION,
    scratchRoot: paths.scratch,
  })

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('daemon shutting down', { signal })
    // 取消运行中的子进程，避免留下孤儿 CLI 进程。
    await manager.shutdown()
    server.close()
    try {
      fs.unlinkSync(paths.daemonPid)
    } catch {
      // 忽略。
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// 被直接运行时启动（tsx 源码 / esbuild 打包产物）；被测试导入时不自动启动。
if (isDirectRun(import.meta.url)) {
  void main()
}
