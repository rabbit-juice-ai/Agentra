/**
 * Workflow Runtime 的三套状态机（WORKFLOW §3 / §4 + DATABASE §2.6）。
 *
 * 只有这张表能定义"哪些迁移合法"；Repository 的 CAS 迁移会先对照本表，
 * 再执行 `UPDATE … WHERE status IN (…)`，两步缺一不可：
 * - 对照表：把非法迁移挡在写库之前（错误可诊断）；
 * - CAS：把并发下的"状态已被别人改走"变成 changes=0，而不是覆盖。
 */

export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'paused',
  'waiting_human',
  'completed',
  'failed',
  'cancelled',
  'reconciliation_required',
] as const
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

export const BRANCH_RUN_STATUSES = [
  'blocked',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type BranchRunStatus = (typeof BRANCH_RUN_STATUSES)[number]

/** 节点状态只含 MVP 子集（WORKFLOW §3）：不含 waiting_input / waiting_checkpoint。 */
export const NODE_RUN_STATUSES = [
  'blocked',
  'ready',
  'running',
  'waiting_approval',
  'paused',
  'succeeded',
  'changes_requested',
  'rejected',
  'failed',
  'cancelled',
  'skipped',
  'reconciliation_required',
] as const
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number]

/**
 * 注意：`paused` **没有**直达 `completed` 的边，这是有意的——暂停的 Run 必须先恢复
 * （paused → running）才能完成。引擎不要用 `from: ['running', 'paused'] → completed`
 * 调 CAS，from 集合校验会直接抛 IllegalWorkflowTransitionError。
 */
const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  pending: ['running', 'failed', 'cancelled'],
  running: [
    'paused',
    'waiting_human',
    'completed',
    'failed',
    'cancelled',
    'reconciliation_required',
  ],
  paused: ['running', 'cancelled', 'failed'],
  waiting_human: ['running', 'paused', 'cancelled', 'failed'],
  reconciliation_required: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const BRANCH_TRANSITIONS: Record<BranchRunStatus, readonly BranchRunStatus[]> = {
  blocked: ['active', 'cancelled'],
  active: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const NODE_TRANSITIONS: Record<NodeRunStatus, readonly NodeRunStatus[]> = {
  blocked: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'blocked', 'skipped', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'reconciliation_required'],
  waiting_approval: [
    'succeeded',
    'changes_requested',
    'rejected',
    'cancelled',
    'reconciliation_required',
  ],
  paused: ['ready', 'running', 'cancelled'],
  changes_requested: ['ready', 'failed', 'cancelled'],
  rejected: ['ready', 'cancelled'],
  reconciliation_required: ['succeeded', 'failed', 'cancelled', 'ready'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
}

const TERMINAL_RUN: ReadonlySet<WorkflowRunStatus> = new Set(['completed', 'failed', 'cancelled'])
const TERMINAL_BRANCH: ReadonlySet<BranchRunStatus> = new Set(['completed', 'failed', 'cancelled'])
const TERMINAL_NODE: ReadonlySet<NodeRunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
])

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN.has(status)
}

export function isTerminalBranchStatus(status: BranchRunStatus): boolean {
  return TERMINAL_BRANCH.has(status)
}

export function isTerminalNodeStatus(status: NodeRunStatus): boolean {
  return TERMINAL_NODE.has(status)
}

export class IllegalWorkflowTransitionError extends Error {
  constructor(
    readonly entity: 'workflow_run' | 'branch_run' | 'node_run',
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal ${entity} transition: ${from} -> ${to}`)
    this.name = 'IllegalWorkflowTransitionError'
  }
}

function assertTransition<T extends string>(
  entity: 'workflow_run' | 'branch_run' | 'node_run',
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): void {
  if (!transitions[from].includes(to)) {
    throw new IllegalWorkflowTransitionError(entity, from, to)
  }
}

export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  assertTransition('workflow_run', RUN_TRANSITIONS, from, to)
}

export function assertBranchTransition(from: BranchRunStatus, to: BranchRunStatus): void {
  assertTransition('branch_run', BRANCH_TRANSITIONS, from, to)
}

export function assertNodeTransition(from: NodeRunStatus, to: NodeRunStatus): void {
  assertTransition('node_run', NODE_TRANSITIONS, from, to)
}

export function runTargets(from: WorkflowRunStatus): readonly WorkflowRunStatus[] {
  return RUN_TRANSITIONS[from]
}

export function branchTargets(from: BranchRunStatus): readonly BranchRunStatus[] {
  return BRANCH_TRANSITIONS[from]
}

export function nodeTargets(from: NodeRunStatus): readonly NodeRunStatus[] {
  return NODE_TRANSITIONS[from]
}
