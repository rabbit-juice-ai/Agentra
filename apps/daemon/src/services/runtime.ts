import {
  DAEMON_DISCOVER_METHOD,
  DAEMON_EXECUTION_CANCEL_METHOD,
  DAEMON_EXECUTION_INTERRUPT_METHOD,
  DAEMON_EXECUTION_LIST_ACTIVE_METHOD,
  DAEMON_EXECUTION_SEND_MESSAGE_METHOD,
  DAEMON_EXECUTION_START_METHOD,
  DAEMON_EXECUTION_STATUS_METHOD,
  DAEMON_PROVIDER_MODELS_METHOD,
  DAEMON_SUBSCRIBE_METHOD,
  DaemonDiscoverParams,
  DaemonDiscoverResult,
  DaemonEmptyParams,
  DaemonExecutionCancelResult,
  DaemonExecutionIdParams,
  DaemonExecutionInterruptResult,
  DaemonExecutionListActiveResult,
  DaemonExecutionSendMessageParams,
  DaemonExecutionSendMessageResult,
  DaemonExecutionStartParams,
  DaemonExecutionStartResult,
  DaemonExecutionStatusResult,
  DaemonProviderModelsParams,
  DaemonProviderModelsResult,
  DaemonSubscribeParams,
  DaemonSubscribeResult,
  defineMethod,
} from '@agentra/protocol'
import type { MethodTable } from '../rpc/dispatcher'
import type { RuntimeEventHub } from '../runtime/event-hub'
import type { ExecutionManager } from '../runtime/execution-manager'

/** Daemon 的运行时 RPC：发现、执行生命周期、事件订阅。 */
export function runtimeMethods(manager: ExecutionManager, hub: RuntimeEventHub): MethodTable {
  return {
    [DAEMON_DISCOVER_METHOD]: defineMethod(
      DaemonDiscoverParams,
      DaemonDiscoverResult,
      async () => ({ providers: await manager.discover() }),
    ),
    [DAEMON_PROVIDER_MODELS_METHOD]: defineMethod(
      DaemonProviderModelsParams,
      DaemonProviderModelsResult,
      async (params) => ({ models: await manager.listModels(params.providerId) }),
    ),
    [DAEMON_EXECUTION_START_METHOD]: defineMethod(
      DaemonExecutionStartParams,
      DaemonExecutionStartResult,
      async (params) => manager.start(params),
    ),
    [DAEMON_EXECUTION_SEND_MESSAGE_METHOD]: defineMethod(
      DaemonExecutionSendMessageParams,
      DaemonExecutionSendMessageResult,
      async (params) => manager.sendMessage(params.executionId, params.message),
    ),
    [DAEMON_EXECUTION_INTERRUPT_METHOD]: defineMethod(
      DaemonExecutionIdParams,
      DaemonExecutionInterruptResult,
      async (params) => manager.interrupt(params.executionId),
    ),
    [DAEMON_EXECUTION_CANCEL_METHOD]: defineMethod(
      DaemonExecutionIdParams,
      DaemonExecutionCancelResult,
      async (params) => manager.cancel(params.executionId),
    ),
    [DAEMON_EXECUTION_STATUS_METHOD]: defineMethod(
      DaemonExecutionIdParams,
      DaemonExecutionStatusResult,
      async (params) => manager.status(params.executionId),
    ),
    [DAEMON_EXECUTION_LIST_ACTIVE_METHOD]: defineMethod(
      DaemonEmptyParams,
      DaemonExecutionListActiveResult,
      () => ({ executionIds: manager.listActive() }),
    ),
    [DAEMON_SUBSCRIBE_METHOD]: defineMethod(
      DaemonSubscribeParams,
      DaemonSubscribeResult,
      (_params, ctx) => {
        const unsubscribe = hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
    ),
  }
}
