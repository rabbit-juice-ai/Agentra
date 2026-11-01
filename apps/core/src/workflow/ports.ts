import type { AgentRepository } from '../db/repositories/agent-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { ProviderRegistry } from '../services/provider-registry'
import type { WorkdirLockService } from '../services/workdir-lock-service'
import type { WorkflowAssignmentResolver } from './assignment-resolver'
import type {
  AgentCapacityPort,
  ProviderAvailabilityPort,
  WorkdirAvailabilityPort,
} from './dispatch-gates'

/** 真实端口：Agent 并发槽。解析失败时放行，让桥接层给出结构化失败而不是静默卡住。 */
export function createAgentCapacityPort(deps: {
  resolver: WorkflowAssignmentResolver
  agents: AgentRepository
  executions: ExecutionRepository
}): AgentCapacityPort {
  return {
    hasCapacity: (context) => {
      let agentId: string
      try {
        agentId = deps.resolver.resolveForNode(context.run.workId, context.node).agentId
      } catch {
        return true
      }
      const agent = deps.agents.get(agentId)
      if (!agent) return false
      return deps.executions.countActiveByAgent(agent.id) < agent.maxConcurrency
    },
  }
}

/** 真实端口：Provider 可用性（健康状态）。 */
export function createProviderAvailabilityPort(
  registry: ProviderRegistry,
): ProviderAvailabilityPort {
  return {
    isAvailable: () => registry.list().some((provider) => provider.healthStatus === 'healthy'),
  }
}

/**
 * 真实端口：工作目录可用性。
 * `worktree` 策略天然隔离（每个 attempt 独立目录），不参与锁竞争；`work_root` 检查路径锁。
 */
export function createWorkdirAvailabilityPort(deps: {
  works: WorkRepository
  locks: WorkdirLockService
}): WorkdirAvailabilityPort {
  return {
    isAvailable: (context) => {
      const work = deps.works.get(context.run.workId)
      if (!work) return false
      if (
        context.node.type === 'agent_task' &&
        context.node.config.workingDirectoryPolicy === 'worktree'
      ) {
        return true
      }
      return deps.locks.get(work.rootPath) === null
    },
  }
}
