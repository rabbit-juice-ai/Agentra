import { CORE_MAINTENANCE_STATUS_METHOD, MaintenanceStatusResultSchema } from '@agentra/protocol'
import type { CoreRpcClient } from './rpc-client'

/** S55-2B-1B（R2）：Core 启动阶段轮询参数。 */
export const CORE_NORMAL_POLL_INTERVAL_MS = 500
export const CORE_NORMAL_WAIT_BUDGET_MS = 60_000

/**
 * S55-2B-1B（R2）：连接后先等待 Core 进入 normal，再做业务初始化。
 * booting/recovering 期间只发 core.maintenance.status 查询，不发 events.subscribe
 * 或任何业务 RPC；recovery_locked / shutting_down 立即以明确错误结束；超时有界。
 */
export async function waitForCoreNormal(
  rpc: CoreRpcClient,
  options: { budgetMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? CORE_NORMAL_WAIT_BUDGET_MS
  const pollIntervalMs = options.pollIntervalMs ?? CORE_NORMAL_POLL_INTERVAL_MS
  const deadline = Date.now() + budgetMs
  for (;;) {
    const response = await rpc.call(CORE_MAINTENANCE_STATUS_METHOD, {}, 5_000)
    if (!response.ok) {
      throw new Error(
        `core.maintenance.status failed: ${response.error.code} ${response.error.message}`,
      )
    }
    const status = MaintenanceStatusResultSchema.parse(response.result)
    if (status.state === 'normal') return
    if (status.state === 'recovery_locked' || status.state === 'shutting_down') {
      throw new Error(`core is ${status.state}; business RPC stays closed until manual recovery`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`core did not reach normal within ${budgetMs}ms (state: ${status.state})`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
