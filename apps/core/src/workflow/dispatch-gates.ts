import type { WorkflowDefinition, WorkflowNode } from '@agentra/workflow-schema'
import type { BranchRunRecord } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord } from '../db/repositories/node-run-repository'
import type { WorkflowRunRecord } from '../db/repositories/workflow-run-repository'

/** 派发判定上下文：一次 ready → running 之前可见的全部信息。 */
export type DispatchContext = {
  run: WorkflowRunRecord
  nodeRun: NodeRunRecord
  node: WorkflowNode
  branch: BranchRunRecord
  branchKey: string
  definition: WorkflowDefinition
}

export type GateResult = { ok: true } | { ok: false; reason: string }

/**
 * 派发闸门。调度器按注册顺序执行，任一失败即保持 ready（不启动）。
 * 闸门必须是**只读判定**：真正的资源占用（工作目录锁、Execution 创建）在 S4-4 的
 * onNodeStarted 里完成，闸门只回答"现在能不能"。
 */
export type DispatchGate = {
  name: string
  check(context: DispatchContext): GateResult
}

export function runRunningGate(): DispatchGate {
  return {
    name: 'run_running',
    check: ({ run }) =>
      run.status === 'running'
        ? { ok: true }
        : { ok: false, reason: `workflow run is ${run.status}` },
  }
}

export function branchActiveGate(): DispatchGate {
  return {
    name: 'branch_active',
    check: ({ branch }) =>
      branch.status === 'active'
        ? { ok: true }
        : { ok: false, reason: `branch is ${branch.status}` },
  }
}

/** Agent 并发槽（S4-4 用 Assignment/ExecutionService 的真实并发计数实现）。 */
export type AgentCapacityPort = {
  hasCapacity(context: DispatchContext): boolean
}

export function agentCapacityGate(port: AgentCapacityPort): DispatchGate {
  return {
    name: 'agent_capacity',
    check: (context) =>
      port.hasCapacity(context)
        ? { ok: true }
        : { ok: false, reason: 'agent concurrency limit reached' },
  }
}

/** Provider 可用性（S4-4 用 ProviderRegistry + 认证状态实现）。 */
export type ProviderAvailabilityPort = {
  isAvailable(context: DispatchContext): boolean
}

export function providerAvailabilityGate(port: ProviderAvailabilityPort): DispatchGate {
  return {
    name: 'provider_available',
    check: (context) =>
      port.isAvailable(context) ? { ok: true } : { ok: false, reason: 'provider unavailable' },
  }
}

/** 工作目录可用性（S4-4 用 WorkdirLockService 的路径锁实现）。 */
export type WorkdirAvailabilityPort = {
  isAvailable(context: DispatchContext): boolean
}

export function workdirAvailabilityGate(port: WorkdirAvailabilityPort): DispatchGate {
  return {
    name: 'workdir_available',
    check: (context) =>
      port.isAvailable(context)
        ? { ok: true }
        : { ok: false, reason: 'working directory is locked' },
  }
}

/** 输入 Artifact 可用性（阶段 5 接入 Artifact 版本后实现；S4-3 用端口占位）。 */
export type InputArtifactPort = {
  isAvailable(context: DispatchContext): boolean
}

export function inputArtifactGate(port: InputArtifactPort): DispatchGate {
  return {
    name: 'input_artifacts_available',
    check: (context) =>
      port.isAvailable(context)
        ? { ok: true }
        : { ok: false, reason: 'required artifacts missing' },
  }
}

export type ResourcePorts = {
  agentCapacity: AgentCapacityPort
  providerAvailability: ProviderAvailabilityPort
  workdirAvailability: WorkdirAvailabilityPort
  inputArtifacts: InputArtifactPort
}

/** 默认放行端口：只用于 S4-3 测试与 S4-4 接入前的装配占位。 */
export function allowAllResourcePorts(): ResourcePorts {
  const allow = { hasCapacity: () => true, isAvailable: () => true }
  return {
    agentCapacity: allow,
    providerAvailability: allow,
    workdirAvailability: allow,
    inputArtifacts: allow,
  }
}

/** 六项检查的默认组合（顺序即判定顺序）。 */
export function defaultDispatchGates(ports: ResourcePorts): DispatchGate[] {
  return [
    runRunningGate(),
    branchActiveGate(),
    agentCapacityGate(ports.agentCapacity),
    providerAvailabilityGate(ports.providerAvailability),
    workdirAvailabilityGate(ports.workdirAvailability),
    inputArtifactGate(ports.inputArtifacts),
  ]
}
