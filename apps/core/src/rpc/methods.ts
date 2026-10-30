import {
  AGENT_ARCHIVE_METHOD,
  AGENT_CREATE_METHOD,
  AGENT_GET_METHOD,
  AGENT_LIST_METHOD,
  AGENT_UPDATE_METHOD,
  AgentArchiveParams,
  AgentCreateParams,
  AgentGetParams,
  AgentListParams,
  AgentUpdateParams,
  EVENTS_SUBSCRIBE_METHOD,
  EventsSubscribeParams,
  EXECUTION_CANCEL_METHOD,
  EXECUTION_GET_METHOD,
  EXECUTION_INTERRUPT_METHOD,
  EXECUTION_LIST_METHOD,
  EXECUTION_LOGS_METHOD,
  EXECUTION_SEND_MESSAGE_METHOD,
  EXECUTION_START_METHOD,
  EXECUTION_STATUS_METHOD,
  ExecutionCancelParams,
  ExecutionGetParams,
  ExecutionInterruptParams,
  ExecutionListParams,
  ExecutionLogsParams,
  ExecutionSendMessageParams,
  ExecutionStartParams,
  ExecutionStatusParams,
  RUNTIME_PROVIDER_LIST_METHOD,
  RUNTIME_PROVIDER_REFRESH_METHOD,
  RuntimeProviderListParams,
  RuntimeProviderRefreshParams,
} from '@agentra/protocol'
import type { AgentService } from '../services/agent-service'
import type { CoreEventHub } from '../services/event-hub'
import type { ExecutionService } from '../services/execution-service'
import { coreHealthMethods } from '../services/health'
import type { ProviderRegistry } from '../services/provider-registry'
import type { MethodTable } from './dispatcher'

export type CoreMethodServices = {
  agents: AgentService
  registry: ProviderRegistry
  executions: ExecutionService
  hub: CoreEventHub
}

/** Desktop 可见的全部 RPC 方法（Core 是唯一业务入口）。 */
export function coreMethods(
  version: string,
  daemonSocketPath: string,
  services: CoreMethodServices,
): MethodTable {
  return {
    ...coreHealthMethods(version, daemonSocketPath),

    [AGENT_LIST_METHOD]: {
      paramsSchema: AgentListParams,
      handler: (params) => ({
        agents: services.agents.list(
          (params as { includeArchived?: boolean }).includeArchived ?? false,
        ),
      }),
    },
    [AGENT_GET_METHOD]: {
      paramsSchema: AgentGetParams,
      handler: (params) => ({ agent: services.agents.get((params as { id: string }).id) }),
    },
    [AGENT_CREATE_METHOD]: {
      paramsSchema: AgentCreateParams,
      handler: (params) => ({ agent: services.agents.create(params as AgentCreateParams) }),
    },
    [AGENT_UPDATE_METHOD]: {
      paramsSchema: AgentUpdateParams,
      handler: (params) => ({ agent: services.agents.update(params as AgentUpdateParams) }),
    },
    [AGENT_ARCHIVE_METHOD]: {
      paramsSchema: AgentArchiveParams,
      handler: (params) => ({ agent: services.agents.archive((params as { id: string }).id) }),
    },

    [RUNTIME_PROVIDER_LIST_METHOD]: {
      paramsSchema: RuntimeProviderListParams,
      handler: () => ({ providers: services.registry.list() }),
    },
    [RUNTIME_PROVIDER_REFRESH_METHOD]: {
      paramsSchema: RuntimeProviderRefreshParams,
      handler: async () => ({ providers: await services.registry.refresh() }),
    },

    [EXECUTION_START_METHOD]: {
      paramsSchema: ExecutionStartParams,
      handler: async (params) => ({
        execution: await services.executions.start(params as ExecutionStartParams),
      }),
    },
    [EXECUTION_GET_METHOD]: {
      paramsSchema: ExecutionGetParams,
      handler: (params) => {
        const executionId = (params as { executionId: string }).executionId
        return {
          execution: services.executions.get(executionId),
          logs: services.executions.logsFor({ executionId }),
        }
      },
    },
    [EXECUTION_LIST_METHOD]: {
      paramsSchema: ExecutionListParams,
      handler: (params) => ({
        executions: services.executions.list((params as { limit?: number }).limit ?? 50),
      }),
    },
    [EXECUTION_LOGS_METHOD]: {
      paramsSchema: ExecutionLogsParams,
      handler: (params) => ({
        logs: services.executions.logsFor(params as ExecutionLogsParams),
      }),
    },
    [EXECUTION_SEND_MESSAGE_METHOD]: {
      paramsSchema: ExecutionSendMessageParams,
      handler: (params) => services.executions.sendMessage(params as ExecutionSendMessageParams),
    },
    [EXECUTION_INTERRUPT_METHOD]: {
      paramsSchema: ExecutionInterruptParams,
      handler: (params) => services.executions.interrupt(params as ExecutionInterruptParams),
    },
    [EXECUTION_CANCEL_METHOD]: {
      paramsSchema: ExecutionCancelParams,
      handler: async (params) => ({
        execution: await services.executions.cancel(params as ExecutionCancelParams),
      }),
    },
    [EXECUTION_STATUS_METHOD]: {
      paramsSchema: ExecutionStatusParams,
      handler: (params) => ({
        execution: services.executions.get((params as { executionId: string }).executionId),
      }),
    },

    [EVENTS_SUBSCRIBE_METHOD]: {
      paramsSchema: EventsSubscribeParams,
      handler: (_params, ctx) => {
        const unsubscribe = services.hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
    },
  }
}
