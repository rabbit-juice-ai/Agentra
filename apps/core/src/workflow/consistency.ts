import type { Database } from '../db/database'
import { isTerminalNodeStatus, NODE_RUN_STATUSES } from './state-machine'

export type WorkflowConsistencyIssue = {
  code: string
  entityId: string
  message: string
}

export class WorkflowConsistencyError extends Error {
  constructor(readonly issues: WorkflowConsistencyIssue[]) {
    super(
      `workflow consistency violated (${issues.length} issue(s)): ${issues
        .slice(0, 5)
        .map((issue) => `${issue.code}@${issue.entityId}`)
        .join(', ')}`,
    )
    this.name = 'WorkflowConsistencyError'
  }
}

const TERMINAL_NODE_STATUSES = NODE_RUN_STATUSES.filter((status) => isTerminalNodeStatus(status))
const NON_TERMINAL_EXECUTION_STATUSES = ['pending', 'running']

/**
 * 全量一致性检查（只读）。
 *
 * !! **只能在一致性边界调用**：Core 启动完成后，或某个事务 COMMIT 之后。
 * !! 不得在事务中间调用 —— 它看到的是连接当前可见的状态，未提交或半提交的数据
 * !! 会被误报为不一致（测试 `consistency-boundary.test.ts` 里对此有显式用例）。
 * !! 需要事务内自检时，请只校验本次写入涉及的行，而不是全量断言。
 */
export function checkWorkflowConsistency(db: Database): WorkflowConsistencyIssue[] {
  const issues: WorkflowConsistencyIssue[] = []
  const add = (code: string, entityId: string, message: string): void => {
    issues.push({ code, entityId, message })
  }

  const runningWithoutStart = db
    .prepare("SELECT id FROM workflow_runs WHERE status = 'running' AND started_at IS NULL")
    .all() as { id: string }[]
  for (const row of runningWithoutStart) {
    add('run_running_without_started_at', row.id, 'running run has no started_at')
  }

  const terminalWithoutEnd = db
    .prepare(
      `SELECT id FROM workflow_runs
       WHERE status IN ('completed', 'failed', 'cancelled') AND ended_at IS NULL`,
    )
    .all() as { id: string }[]
  for (const row of terminalWithoutEnd) {
    add('run_terminal_without_ended_at', row.id, 'terminal run has no ended_at')
  }

  const activeBranchUnderTerminalRun = db
    .prepare(
      `SELECT b.id AS id FROM branch_runs b
       JOIN workflow_runs r ON r.id = b.workflow_run_id
       WHERE r.status IN ('completed', 'failed', 'cancelled') AND b.status = 'active'`,
    )
    .all() as { id: string }[]
  for (const row of activeBranchUnderTerminalRun) {
    add('branch_active_under_terminal_run', row.id, 'terminal run still has an active branch')
  }

  const pausedWithoutTimestamp = db
    .prepare("SELECT id FROM branch_runs WHERE status = 'paused' AND paused_at IS NULL")
    .all() as { id: string }[]
  for (const row of pausedWithoutTimestamp) {
    add('branch_paused_without_paused_at', row.id, 'paused branch has no paused_at')
  }

  // 节点 running ⇒ 恰好一条非终态 Execution；节点终态 ⇒ 没有非终态 Execution。
  const executionPlaceholders = NON_TERMINAL_EXECUTION_STATUSES.map(() => '?').join(', ')
  const runningWithoutSingleExecution = db
    .prepare(
      `SELECT n.id AS id, COUNT(e.id) AS execution_count
       FROM node_runs n
       LEFT JOIN executions e
         ON e.node_run_id = n.id AND e.status IN (${executionPlaceholders})
       WHERE n.status = 'running'
       GROUP BY n.id
       HAVING COUNT(e.id) <> 1`,
    )
    .all(...NON_TERMINAL_EXECUTION_STATUSES) as { id: string; execution_count: number }[]
  for (const row of runningWithoutSingleExecution) {
    add(
      'node_running_without_single_execution',
      row.id,
      `running node has ${row.execution_count} non-terminal execution(s)`,
    )
  }

  const terminalNodePlaceholders = TERMINAL_NODE_STATUSES.map(() => '?').join(', ')
  const terminalWithRunningExecution = db
    .prepare(
      `SELECT DISTINCT n.id AS id
       FROM node_runs n
       JOIN executions e
         ON e.node_run_id = n.id AND e.status IN (${executionPlaceholders})
       WHERE n.status IN (${terminalNodePlaceholders})`,
    )
    .all(...NON_TERMINAL_EXECUTION_STATUSES, ...TERMINAL_NODE_STATUSES) as { id: string }[]
  for (const row of terminalWithRunningExecution) {
    add(
      'node_terminal_with_active_execution',
      row.id,
      'terminal node still has an active execution',
    )
  }

  const branchOfAnotherRun = db
    .prepare(
      `SELECT n.id AS id FROM node_runs n
       JOIN branch_runs b ON b.id = n.branch_run_id
       WHERE b.workflow_run_id <> n.workflow_run_id`,
    )
    .all() as { id: string }[]
  for (const row of branchOfAnotherRun) {
    add('node_branch_from_other_run', row.id, 'node references a branch of another run')
  }

  const duplicateAttempts = db
    .prepare(
      `SELECT workflow_run_id || '/' || workflow_node_key || '/' || attempt AS id
       FROM node_runs
       GROUP BY workflow_run_id, workflow_node_key, attempt
       HAVING COUNT(*) > 1`,
    )
    .all() as { id: string }[]
  for (const row of duplicateAttempts) {
    add('node_duplicate_attempt', row.id, 'duplicate (run, nodeKey, attempt) node_runs')
  }

  const terminalRunWithOpenNodes = db
    .prepare(
      `SELECT n.id AS id FROM node_runs n
       JOIN workflow_runs r ON r.id = n.workflow_run_id
       WHERE r.status IN ('completed', 'failed', 'cancelled')
         AND n.status NOT IN (${terminalNodePlaceholders})`,
    )
    .all(...TERMINAL_NODE_STATUSES) as { id: string }[]
  for (const row of terminalRunWithOpenNodes) {
    add('terminal_run_with_open_node', row.id, 'terminal run still has a non-terminal node')
  }

  return issues
}

/** 一致性断言；只能在一致性边界调用（见 checkWorkflowConsistency 的约束）。 */
export function assertWorkflowConsistency(db: Database): void {
  const issues = checkWorkflowConsistency(db)
  if (issues.length > 0) throw new WorkflowConsistencyError(issues)
}
