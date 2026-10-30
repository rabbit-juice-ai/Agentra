import {
  DAEMON_DISCOVER_METHOD,
  DAEMON_EXECUTION_CANCEL_METHOD,
  DAEMON_EXECUTION_INTERRUPT_METHOD,
  DAEMON_EXECUTION_LIST_ACTIVE_METHOD,
  DAEMON_EXECUTION_SEND_MESSAGE_METHOD,
  DAEMON_EXECUTION_START_METHOD,
  DAEMON_EXECUTION_STATUS_METHOD,
  DAEMON_SUBSCRIBE_METHOD,
  DaemonDiscoverParams,
  DaemonEmptyParams,
  DaemonExecutionIdParams,
  DaemonExecutionSendMessageParams,
  DaemonExecutionStartParams,
  DaemonSubscribeParams,
} from '@agentra/protocol'
import type { MethodTable } from '../rpc/dispatcher'
import type { RuntimeEventHub } from '../runtime/event-hub'
import type { ExecutionManager } from '../runtime/execution-manager'

/** Daemon 的运行时 RPC：发现、执行生命周期、事件订阅。 */
export function runtimeMethods(manager: ExecutionManager, hub: RuntimeEventHub): MethodTable {
  return {
    [DAEMON_DISCOVER_METHOD]: {
      paramsSchema: DaemonDiscoverParams,
      handler: async () => ({ providers: await manager.discover() }),
    },
    [DAEMON_EXECUTION_START_METHOD]: {
      paramsSchema: DaemonExecutionStartParams,
      handler: async (params) => manager.start(params as DaemonExecutionStartParams),
    },
    [DAEMON_EXECUTION_SEND_MESSAGE_METHOD]: {
      paramsSchema: DaemonExecutionSendMessageParams,
      handler: async (params) => {
        const parsed = params as { executionId: string; message: string }
        return manager.sendMessage(parsed.executionId, parsed.message)
      },
    },
    [DAEMON_EXECUTION_INTERRUPT_METHOD]: {
      paramsSchema: DaemonExecutionIdParams,
      handler: async (params) => manager.interrupt((params as { executionId: string }).executionId),
    },
    [DAEMON_EXECUTION_CANCEL_METHOD]: {
      paramsSchema: DaemonExecutionIdParams,
      handler: async (params) => manager.cancel((params as { executionId: string }).executionId),
    },
    [DAEMON_EXECUTION_STATUS_METHOD]: {
      paramsSchema: DaemonExecutionIdParams,
      handler: async (params) => manager.status((params as { executionId: string }).executionId),
    },
    [DAEMON_EXECUTION_LIST_ACTIVE_METHOD]: {
      paramsSchema: DaemonEmptyParams,
      handler: () => ({ executionIds: manager.listActive() }),
    },
    [DAEMON_SUBSCRIBE_METHOD]: {
      paramsSchema: DaemonSubscribeParams,
      handler: (_params, ctx) => {
        const unsubscribe = hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
    },
  }
}
