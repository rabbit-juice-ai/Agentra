import type { BranchRunRecord, BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRecord, NodeRunRepository } from '../db/repositories/node-run-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'

export class WorkflowRunQueryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowRunQueryError'
  }
}

export type WorkflowRunView = {
  run: WorkflowRunRecord
  branches: BranchRunRecord[]
  nodes: NodeRunRecord[]
}

/** 只读查询：恢复后 reconciliation_required 必须能被 RPC 看到。 */
export class WorkflowRunQueryService {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly branches: BranchRunRepository,
    private readonly nodes: NodeRunRepository,
  ) {}

  /** S5-3b：某 Work 的全部 Run（按创建时间倒序，供 UI 定位失败终态）。 */
  listByWork(workId: string): WorkflowRunRecord[] {
    return this.runs.listByWork(workId)
  }

  get(runId: string): WorkflowRunView {
    const run = this.runs.get(runId)
    if (!run) throw new WorkflowRunQueryError('NOT_FOUND', `workflow run ${runId} not found`)
    return {
      run,
      branches: this.branches.listByRun(runId),
      nodes: this.nodes.listByRun(runId),
    }
  }
}
