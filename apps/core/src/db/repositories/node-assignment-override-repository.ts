import type { Database } from '../database'

export type NodeAssignmentOverride = {
  id: string
  workflowRunId: string
  workflowNodeKey: string
  agentId: string
  assignedBy: string
  createdAt: string
  updatedAt: string
}

type OverrideRow = {
  id: string
  workflow_run_id: string
  workflow_node_key: string
  agent_id: string
  assigned_by: string
  created_at: string
  updated_at: string
}

function toRecord(row: OverrideRow): NodeAssignmentOverride {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    workflowNodeKey: row.workflow_node_key,
    agentId: row.agent_id,
    assignedBy: row.assigned_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 返工换人：显式按 (run, node) 覆盖 Assignment。
 * 不做「Agent 失效自动改绑」——C-8 的失效即失败语义保持不变。
 */
export class NodeAssignmentOverrideRepository {
  constructor(private readonly db: Database) {}

  upsert(record: NodeAssignmentOverride): void {
    this.db
      .prepare(
        `INSERT INTO node_assignment_overrides (
          id, workflow_run_id, workflow_node_key, agent_id, assigned_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id, workflow_node_key) DO UPDATE SET
          agent_id = excluded.agent_id,
          assigned_by = excluded.assigned_by,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.workflowRunId,
        record.workflowNodeKey,
        record.agentId,
        record.assignedBy,
        record.createdAt,
        record.updatedAt,
      )
  }

  get(workflowRunId: string, workflowNodeKey: string): NodeAssignmentOverride | null {
    const row = this.db
      .prepare(
        'SELECT * FROM node_assignment_overrides WHERE workflow_run_id = ? AND workflow_node_key = ?',
      )
      .get(workflowRunId, workflowNodeKey) as OverrideRow | undefined
    return row ? toRecord(row) : null
  }

  listByRun(workflowRunId: string): NodeAssignmentOverride[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM node_assignment_overrides WHERE workflow_run_id = ? ORDER BY workflow_node_key ASC',
      )
      .all(workflowRunId) as OverrideRow[]
    return rows.map(toRecord)
  }
}
