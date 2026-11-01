import { type ProbeState, probeSocket } from './daemon-launcher'

/**
 * Core 单实例守卫：启动前先探活 socket。
 * 已有活 Core 时**拒绝启动**，而不是像 ws-server 那样 unlink 掉别人的 socket。
 * 注意：产品路径已有 Electron 单实例锁；这里保护的是 `pnpm dev:core`、QA 脚本、
 * 非 Electron 部署等不受 Electron 锁约束的路径。
 */
export async function assertCoreSocketAvailable(
  socketPath: string,
  probe: (path: string) => Promise<ProbeState> = probeSocket,
): Promise<void> {
  const state = await probe(socketPath)
  if (state === 'live') {
    throw new Error(
      `another Core instance is already listening on ${socketPath}; refusing to start (single-scheduler invariant)`,
    )
  }
}
