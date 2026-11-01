import { newId } from '@agentra/shared'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { BranchRunRepository } from '../db/repositories/branch-run-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { WorkRepository } from '../db/repositories/work-repository'
import type {
  WorkflowRunRecord,
  WorkflowRunRepository,
} from '../db/repositories/workflow-run-repository'
import type { WorkflowAssignmentResolver } from './assignment-resolver'
import { ROOT_BRANCH_KEY, resolveBranchKeys } from './graph'
import type { PublishedDefinitionProvider } from './published-definition-provider'
import { ensureBranchRuns } from './scheduler'

export class WorkflowRunCreationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowRunCreationError'
  }
}

export type CreateWorkflowRunInput = {
  workId: string
  workflowVersionId: string
}

/**
 * WorkflowRun 创建：预检全部 agent_task 的 Assignment，**任何失败都在写入之前抛出**，
 * 保证「整次 Run 创建失败、零 NodeRun / 零 Execution」。
 */
export class WorkflowRunService {
  constructor(
    private readonly db: Database,
    private readonly runs: WorkflowRunRepository,
    private readonly branches: BranchRunRepository,
    private readonly nodes: NodeRunRepository,
    private readonly works: WorkRepository,
    private readonly definitions: PublishedDefinitionProvider,
    private readonly resolver: WorkflowAssignmentResolver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createRun(input: CreateWorkflowRunInput): WorkflowRunRecord {
    const work = this.works.get(input.workId)
    if (!work) throw new WorkflowRunCreationError(`work not found: ${input.workId}`)
    if (work.status !== 'active' && work.status !== 'paused') {
      throw new WorkflowRunCreationError(`work ${work.id} is ${work.status}, cannot create a run`)
    }

    const { definition } = this.definitions.get(input.workflowVersionId)
    this.assertWorkingDirectoriesAvailable(work.repositoryPath, definition)
    this.resolver.precheck(input.workId, definition)

    const now = this.now()
    return transaction(this.db, () => {
      const run = this.runs.create(
        { id: newId('run'), workId: input.workId, workflowVersionId: input.workflowVersionId },
        now,
      )
      const branchRuns = ensureBranchRuns(this.branches, run.id, definition, now)
      const branchByKey = new Map(branchRuns.map((branch) => [branch.branchKey, branch]))
      const branchKeys = resolveBranchKeys(definition)
      for (const node of definition.nodes) {
        const branchKey = branchKeys.get(node.key) ?? ROOT_BRANCH_KEY
        this.nodes.create(
          {
            id: newId('nrn'),
            workflowRunId: run.id,
            workflowNodeKey: node.key,
            branchRunId: branchByKey.get(branchKey)?.id ?? null,
          },
          now,
        )
      }
      if (!this.runs.transition(run.id, ['pending'], 'running', now)) {
        throw new WorkflowRunCreationError(`failed to start workflow run ${run.id}`)
      }
      const created = this.runs.get(run.id)
      if (!created)
        throw new WorkflowRunCreationError(`workflow run ${run.id} missing after insert`)
      return created
    })
  }

  /** worktree 策略要求 Work 配置 repository_path；缺配置在 Run 创建阶段就拒绝。 */
  private assertWorkingDirectoriesAvailable(
    repositoryPath: string | null,
    definition: WorkflowDefinition,
  ): void {
    const needsWorktree = definition.nodes.some(
      (node) => node.type === 'agent_task' && node.config.workingDirectoryPolicy === 'worktree',
    )
    if (needsWorktree && (repositoryPath === null || repositoryPath.length === 0)) {
      throw new WorkflowRunCreationError(
        'workflow uses workingDirectoryPolicy="worktree" but the work has no repository_path',
      )
    }
  }
}
