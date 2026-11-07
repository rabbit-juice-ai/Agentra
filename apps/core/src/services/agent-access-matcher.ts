import type { AgentAccessMode, AgentProfile } from '@agentra/protocol'

/**
 * 确定性权限匹配：任务要求的工作权限必须与 Agent 完全一致。
 * - analyze 任务只能交给只读分析 Agent（测试不能改代码）；
 * - edit 任务只能交给编辑 Agent（研发不能接分析/验收任务）。
 * 「擅长的工作与调用时机」只用于 Planner 语义排序，不能绕过这里的校验。
 */
export function matchesAgentAccess(
  agent: AgentProfile,
  requiredAccessMode: AgentAccessMode,
): boolean {
  return agent.status === 'active' && agent.accessMode === requiredAccessMode
}

export function findMatchingAgents(
  agents: AgentProfile[],
  requiredAccessMode: AgentAccessMode,
): AgentProfile[] {
  return agents.filter((agent) => matchesAgentAccess(agent, requiredAccessMode))
}
