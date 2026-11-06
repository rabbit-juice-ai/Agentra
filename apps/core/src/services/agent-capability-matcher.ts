import type { AgentProfile } from '@agentra/protocol'

export type CapabilityKind = 'execute' | 'verify' | 'approve'

export type CapabilityRequirement = {
  taskType: string
  requiredCapabilities?: string[]
  kind?: CapabilityKind
}

/**
 * 确定性能力匹配。职责描述（description）不参与这里——
 * Planner 可以用描述做语义排序，但最终选人必须通过结构化 capabilities 校验。
 */
export function matchesAgentCapabilities(
  agent: AgentProfile,
  requirement: CapabilityRequirement,
): boolean {
  const { taskType, requiredCapabilities = [], kind = 'execute' } = requirement
  const capabilities = agent.capabilities
  if (capabilities.excludedTaskTypes.includes(taskType)) return false
  if (requiredCapabilities.some((item) => capabilities.excludedTaskTypes.includes(item))) {
    return false
  }

  // responsibilityRole 是职责标签；requiredCapabilities 才是硬能力要求。
  // 没给 requiredCapabilities 时才退回用职责名匹配，兼容手工创建的任务。
  const required = requiredCapabilities.length > 0 ? requiredCapabilities : [taskType]

  if (kind === 'approve') {
    return required.every((capability) => capabilities.canApprove.includes(capability))
  }

  if (kind === 'verify') {
    const verifiable = new Set([...capabilities.canVerify, ...capabilities.taskTypes])
    return required.every((capability) => verifiable.has(capability))
  }

  const executable = new Set(capabilities.taskTypes)
  return required.every((capability) => executable.has(capability))
}

export function findMatchingAgents(
  agents: AgentProfile[],
  requirement: CapabilityRequirement,
): AgentProfile[] {
  const matches = agents.filter(
    (agent) => agent.status === 'active' && matchesAgentCapabilities(agent, requirement),
  )
  if (requirement.kind !== 'verify') return matches
  const required =
    requirement.requiredCapabilities && requirement.requiredCapabilities.length > 0
      ? requirement.requiredCapabilities
      : [requirement.taskType]
  // 验收任务优先选显式声明 canVerify 的 Agent，而不是只会做同类任务的执行者。
  return matches.sort((left, right) => {
    const leftExplicit = required.every((capability) =>
      left.capabilities.canVerify.includes(capability),
    )
    const rightExplicit = required.every((capability) =>
      right.capabilities.canVerify.includes(capability),
    )
    return Number(rightExplicit) - Number(leftExplicit)
  })
}

export function missingCapabilities(
  agent: AgentProfile,
  requirement: CapabilityRequirement,
): string[] {
  const { taskType, requiredCapabilities = [], kind = 'execute' } = requirement
  const capabilities = agent.capabilities
  const pool =
    kind === 'approve'
      ? new Set(capabilities.canApprove)
      : kind === 'verify'
        ? new Set([...capabilities.canVerify, ...capabilities.taskTypes])
        : new Set(capabilities.taskTypes)
  const required = requiredCapabilities.length > 0 ? requiredCapabilities : [taskType]
  return [...new Set(required.filter((capability) => !pool.has(capability)))]
}
