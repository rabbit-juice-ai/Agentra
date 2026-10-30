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
  AgentListResult,
  AgentResult,
  AgentUpdateParams,
  defineMethod,
  EVENTS_SUBSCRIBE_METHOD,
  EventsSubscribeParams,
  EventsSubscribeResult,
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
  ExecutionGetResult,
  ExecutionInterruptParams,
  ExecutionInterruptResult,
  ExecutionListParams,
  ExecutionListResult,
  ExecutionLogsParams,
  ExecutionLogsResult,
  ExecutionResult,
  ExecutionSendMessageParams,
  ExecutionSendMessageResult,
  ExecutionStartParams,
  ExecutionStatusParams,
  RUNTIME_PROVIDER_LIST_METHOD,
  RUNTIME_PROVIDER_REFRESH_METHOD,
  RuntimeProviderListParams,
  RuntimeProviderListResult,
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

    [AGENT_LIST_METHOD]: defineMethod(AgentListParams, AgentListResult, (params) => ({
      agents: services.agents.list(params.includeArchived ?? false),
    })),
    [AGENT_GET_METHOD]: defineMethod(AgentGetParams, AgentResult, (params) => ({
      agent: services.agents.get(params.id),
    })),
    [AGENT_CREATE_METHOD]: defineMethod(AgentCreateParams, AgentResult, (params) => ({
      agent: services.agents.create(params),
    })),
    [AGENT_UPDATE_METHOD]: defineMethod(AgentUpdateParams, AgentResult, (params) => ({
      agent: services.agents.update(params),
    })),
    [AGENT_ARCHIVE_METHOD]: defineMethod(AgentArchiveParams, AgentResult, (params) => ({
      agent: services.agents.archive(params.id),
    })),

    [RUNTIME_PROVIDER_LIST_METHOD]: defineMethod(
      RuntimeProviderListParams,
      RuntimeProviderListResult,
      () => ({ providers: services.registry.list() }),
    ),
    [RUNTIME_PROVIDER_REFRESH_METHOD]: defineMethod(
      RuntimeProviderRefreshParams,
      RuntimeProviderListResult,
      async () => ({ providers: await services.registry.refresh() }),
    ),

    [EXECUTION_START_METHOD]: defineMethod(
      ExecutionStartParams,
      ExecutionResult,
      async (params) => ({ execution: await services.executions.start(params) }),
    ),
    [EXECUTION_GET_METHOD]: defineMethod(ExecutionGetParams, ExecutionGetResult, (params) => ({
      execution: services.executions.get(params.executionId),
      logs: services.executions.logsFor({ executionId: params.executionId }),
    })),
    [EXECUTION_LIST_METHOD]: defineMethod(ExecutionListParams, ExecutionListResult, (params) => ({
      executions: services.executions.list(params.limit ?? 50),
    })),
    [EXECUTION_LOGS_METHOD]: defineMethod(ExecutionLogsParams, ExecutionLogsResult, (params) => ({
      logs: services.executions.logsFor(params),
    })),
    [EXECUTION_SEND_MESSAGE_METHOD]: defineMethod(
      ExecutionSendMessageParams,
      ExecutionSendMessageResult,
      (params) => services.executions.sendMessage(params),
    ),
    [EXECUTION_INTERRUPT_METHOD]: defineMethod(
      ExecutionInterruptParams,
      ExecutionInterruptResult,
      (params) => services.executions.interrupt(params),
    ),
    [EXECUTION_CANCEL_METHOD]: defineMethod(
      ExecutionCancelParams,
      ExecutionResult,
      async (params) => ({ execution: await services.executions.cancel(params) }),
    ),
    [EXECUTION_STATUS_METHOD]: defineMethod(ExecutionStatusParams, ExecutionResult, (params) => ({
      execution: services.executions.get(params.executionId),
    })),

    [EVENTS_SUBSCRIBE_METHOD]: defineMethod(
      EventsSubscribeParams,
      EventsSubscribeResult,
      (_params, ctx) => {
        const unsubscribe = services.hub.subscribe((event) => ctx.push({ type: 'event', event }))
        ctx.onClose(unsubscribe)
        return { subscribed: true }
      },
    ),
  }
}
