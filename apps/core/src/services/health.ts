import net from 'node:net'
import {
  CORE_HEALTH_METHOD,
  DAEMON_HEALTH_METHOD,
  defineMethod,
  HealthParams,
  HealthResult,
  PROTOCOL_VERSION,
  type RpcResponse,
} from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { MethodTable } from '../rpc/dispatcher'

const startedAt = Date.now()

/**
 * core.health：Core 自身健康。
 * daemon.health：Core 透明代理给 Daemon（同一方法名、同一 schema，零额外协议）。
 * Desktop 只连 Core，不直连 Daemon（架构纪律）。
 */
export function coreHealthMethods(version: string, daemonSocketPath: string): MethodTable {
  return {
    [CORE_HEALTH_METHOD]: defineMethod(
      HealthParams,
      HealthResult,
      () => ({
        status: 'ok' as const,
        service: 'core' as const,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        version,
      }),
      'read',
    ),
    [DAEMON_HEALTH_METHOD]: defineMethod(
      HealthParams,
      HealthResult,
      () => proxyDaemonHealth(daemonSocketPath),
      'read',
    ),
  }
}

/** 把 daemon.health 请求经 UDS 转发给 Daemon 并回传响应（响应经 HealthResult 校验）。 */
export function proxyDaemonHealth(daemonSocketPath: string): Promise<HealthResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(daemonSocketPath)
    let buffer = ''
    const requestId = newId('proxy')
    const request = {
      requestId,
      protocolVersion: PROTOCOL_VERSION,
      method: DAEMON_HEALTH_METHOD,
      params: {},
    }
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`daemon.health proxy timed out (${daemonSocketPath})`))
    }, 3000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex !== -1) {
        clearTimeout(timer)
        socket.destroy()
        try {
          const response = JSON.parse(buffer.slice(0, newlineIndex)) as RpcResponse
          if (response.ok) resolve(HealthResult.parse(response.result))
          else
            reject(
              new Error(`daemon.health failed: ${response.error.code} ${response.error.message}`),
            )
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
