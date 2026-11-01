import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalError, ApprovalService } from './approval-service'
import {
  type ControlNodeDeps,
  completeConditionNode,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
  enterHumanApproval,
} from './control-nodes'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { ROOT_BRANCH_KEY, resolveBranchKeys } from './graph'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { ensureBranchRuns, WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const settings = {
  defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
  reworkPolicy: { maxRounds: 2 },
  failureStrategy: 'fail_branch',
  concurrency: { maxParallelNodes: 4 },
}

function node(key: string, type: string, config: Record<string, unknown> = {}, y = 0) {
  return { key, type, label: '', position: { x: 0, y }, config }
}
const task = (key: string, y = 1) =>
  node(key, 'agent_task', { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'x' }, y)

function definitionBranches(expected: 'succeeded' | 'failed' = 'failed'): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node(
        'cond',
        'condition',
        {
          predicate: {
            kind: 'comparison',
            op: '==',
            left: { kind: 'field', path: 'nodes.start.status' },
            right: { kind: 'literal', value: expected },
          },
          falseBranch: 'edge',
        },
        1,
      ),
      node('end_t', 'end', {}, 2),
      node('end_f', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'cond' },
      { key: 'e2', source: 'cond', target: 'end_t', when: true },
      { key: 'e3', source: 'cond', target: 'end_f', when: false },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionRework(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      {
        ...task('task_1'),
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'x',
          outputContract: { profile: 'test_result' },
        },
      },
      node(
        'cond',
        'condition',
        {
          predicate: {
            kind: 'comparison',
            op: '==',
            left: { kind: 'field', path: 'nodes.task_1.output.pass' },
            right: { kind: 'literal', value: true },
          },
          falseBranch: { kind: 'rework', reportNodeKey: 'task_1' },
        },
        2,
      ),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'cond' },
      { key: 'e3', source: 'cond', target: 'end', when: true },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionJoin(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node('split_1', 'parallel_split', {}, 1),
      task('a', 2),
      task('b', 2),
      node('join', 'join', { pairWith: 'split_1' }, 3),
      node('end', 'end', {}, 4),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'a', branchKey: 'a' },
      { key: 'e3', source: 'split_1', target: 'b', branchKey: 'b' },
      { key: 'e4', source: 'a', target: 'join' },
      { key: 'e5', source: 'b', target: 'join' },
      { key: 'e6', source: 'join', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionEnd(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [node('start', 'start'), node('end', 'end', {}, 1)],
    edges: [{ key: 'e1', source: 'start', target: 'end' }],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionApproval(
  phase: 'before_execute' | 'after_execute' = 'after_execute',
): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1'),
      node('approval', 'human_approval', { target: { nodeKey: 'task_1', phase } }, 2),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'approval' },
      { key: 'e3', source: 'approval', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionApprovalBeforeExecute(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node(
        'approval',
        'human_approval',
        { target: { nodeKey: 'task_1', phase: 'before_execute' } },
        1,
      ),
      task('task_1', 2),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval' },
      { key: 'e2', source: 'approval', target: 'task_1' },
      { key: 'e3', source: 'task_1', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function definitionTwoEnds(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node('split_1', 'parallel_split', {}, 1),
      task('a', 2),
      task('b', 2),
      node('end_a', 'end', {}, 3),
      node('end_b', 'end', {}, 3),
      node('join', 'join', { pairWith: 'split_1' }, 3),
      node('end_join', 'end', {}, 4),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'a', branchKey: 'a' },
      { key: 'e3', source: 'split_1', target: 'b', branchKey: 'b' },
      { key: 'e4', source: 'a', target: 'end_a' },
      { key: 'e5', source: 'b', target: 'end_b' },
      { key: 'e6', source: 'a', target: 'join' },
      { key: 'e7', source: 'b', target: 'join' },
      { key: 'e8', source: 'join', target: 'end_join' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

type Harness = {
  db: Database
  deps: ControlNodeDeps
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  approvals: ApprovalService
  audit: AuditRepository
  events: { type: string; runId: string }[]
  reworks: { nodeKey: string; reportNodeKey: string }[]
  runId: string
  branchId: (key: string) => string | null
  setRunning: (key: string) => void
  setSucceeded: (key: string, output?: Record<string, unknown>) => void
  setFailed: (key: string) => void
  nodeRunId: (key: string) => string
  close: () => void
}

function setup(definition: WorkflowDefinition): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-control-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const repo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(repo)
  const service = new WorkflowDefinitionService(db, repo, () => NOW)
  const template = service.createTemplate({ name: 't' })
  const draft = service.createDraft(template.id, definition)
  service.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const audit = new AuditRepository(db)
  const approvals = new ApprovalService(
    db,
    new ApprovalRepository(db),
    nodes,
    branches,
    () => NOW,
    undefined,
    audit,
  )
  const run = runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, NOW)
  runs.transition('run-1', ['pending'], 'running', NOW)
  ensureBranchRuns(branches, run.id, definition, NOW)
  const branchKeys = resolveBranchKeys(definition)
  for (const nodeDef of definition.nodes) {
    const branchKey = branchKeys.get(nodeDef.key) ?? ROOT_BRANCH_KEY
    const branch = branches.getByKey(run.id, branchKey)
    nodes.create(
      {
        id: `nrn-${nodeDef.key}`,
        workflowRunId: run.id,
        workflowNodeKey: nodeDef.key,
        branchRunId: branch?.id ?? null,
      },
      NOW,
    )
  }

  const events: { type: string; runId: string }[] = []
  const reworks: { nodeKey: string; reportNodeKey: string }[] = []
  const deps: ControlNodeDeps = {
    db,
    runs,
    branches,
    nodes,
    definitions,
    approvals,
    audit,
    eventSink: { publish: (event) => events.push(event) },
    reworkTrigger: {
      request: (input) =>
        reworks.push({ nodeKey: input.nodeKey, reportNodeKey: input.reportNodeKey }),
    },
    now: () => NOW,
  }

  return {
    db,
    deps,
    runs,
    branches,
    nodes,
    approvals,
    audit,
    events,
    reworks,
    runId: run.id,
    branchId: (key) => branches.getByKey(run.id, key)?.id ?? null,
    setRunning: (key) => {
      nodes.transition(`nrn-${key}`, ['blocked'], 'ready', NOW)
      nodes.transition(`nrn-${key}`, ['ready'], 'running', NOW)
    },
    setSucceeded: (key, output) => {
      nodes.transition(
        `nrn-${key}`,
        ['running'],
        'succeeded',
        NOW,
        output ? { outputSnapshot: output } : undefined,
      )
    },
    setFailed: (key) => {
      nodes.fail(
        `nrn-${key}`,
        ['running'],
        { category: 'internal', nodeKey: key, message: 'x' },
        NOW,
      )
    },
    nodeRunId: (key) => `nrn-${key}`,
    close: () => db.close(),
  }
}

describe('Condition 运行时', () => {
  it('evaluates true and writes output.when=true', () => {
    const h = setup(definitionBranches('succeeded'))
    try {
      h.setRunning('start')
      h.setSucceeded('start')
      h.setRunning('cond')
      completeConditionNode(h.deps, h.nodeRunId('cond'))
      const cond = h.nodes.get(h.nodeRunId('cond'))
      expect(cond?.status).toBe('succeeded')
      expect(cond?.outputSnapshot).toEqual({ when: true })
    } finally {
      h.close()
    }
  })

  it('routes false through the when=false edge', () => {
    const h = setup(definitionBranches())
    try {
      h.setRunning('start')
      h.setSucceeded('start')
      h.setRunning('cond')
      completeConditionNode(h.deps, h.nodeRunId('cond'))
      expect(h.nodes.get(h.nodeRunId('cond'))?.outputSnapshot).toEqual({ when: false })
    } finally {
      h.close()
    }
  })

  it('treats falseBranch=rework as matched and triggers rework', () => {
    const h = setup(definitionRework())
    try {
      h.setRunning('start')
      h.setSucceeded('start')
      h.setRunning('task_1')
      h.setSucceeded('task_1', {
        pass: false,
        failureReason: '',
        relatedTasks: [],
        impactScope: '',
        relatedArtifacts: [],
      })
      h.setRunning('cond')
      completeConditionNode(h.deps, h.nodeRunId('cond'))
      expect(h.nodes.get(h.nodeRunId('cond'))?.status).toBe('succeeded')
      expect(h.nodes.get(h.nodeRunId('cond'))?.outputSnapshot).toEqual({ when: false })
      expect(h.reworks).toEqual([{ nodeKey: 'cond', reportNodeKey: 'task_1' }])
    } finally {
      h.close()
    }
  })

  it('fails instead of silently succeeding when the rework trigger is not wired', () => {
    const h = setup(definitionRework())
    try {
      h.setRunning('start')
      h.setSucceeded('start')
      h.setRunning('task_1')
      h.setSucceeded('task_1', {
        pass: false,
        failureReason: '',
        relatedTasks: [],
        impactScope: '',
        relatedArtifacts: [],
      })
      h.setRunning('cond')
      const { reworkTrigger: _unwired, ...deps } = h.deps
      completeConditionNode(deps, h.nodeRunId('cond'))
      const cond = h.nodes.get(h.nodeRunId('cond'))
      expect(cond?.status).toBe('failed')
      expect(cond?.error?.category).toBe('internal')
    } finally {
      h.close()
    }
  })

  it('fails the node when a referenced output field is missing', () => {
    const h = setup(definitionRework())
    try {
      h.setRunning('start')
      h.setSucceeded('start')
      h.setRunning('task_1')
      h.setSucceeded('task_1')
      h.setRunning('cond')
      completeConditionNode(h.deps, h.nodeRunId('cond'))
      const cond = h.nodes.get(h.nodeRunId('cond'))
      expect(cond?.status).toBe('failed')
      expect(cond?.error?.category).toBe('condition_evaluation')
    } finally {
      h.close()
    }
  })
})

describe('Join 运行时', () => {
  it('fails the join when an upstream branch failed', () => {
    const h = setup(definitionJoin())
    try {
      h.setRunning('a')
      h.setFailed('a')
      h.setRunning('b')
      h.setSucceeded('b')
      h.setRunning('join')
      completeJoinNode(h.deps, h.nodeRunId('join'))
      const join = h.nodes.get(h.nodeRunId('join'))
      expect(join?.status).toBe('failed')
      expect(join?.error?.category).toBe('join_failed')
    } finally {
      h.close()
    }
  })

  it('keeps waiting when an upstream branch is paused (not failed)', () => {
    const h = setup(definitionJoin())
    try {
      h.setRunning('a')
      h.setSucceeded('a')
      h.setRunning('b')
      const branchB = h.branchId('split_1/b')
      if (branchB) h.branches.pause(branchB, 'user_paused', NOW)
      h.setRunning('join')
      completeJoinNode(h.deps, h.nodeRunId('join'))
      expect(h.nodes.get(h.nodeRunId('join'))?.status).toBe('running')
    } finally {
      h.close()
    }
  })

  it('succeeds only when every upstream branch succeeded', () => {
    const h = setup(definitionJoin())
    try {
      h.setRunning('a')
      h.setSucceeded('a')
      h.setRunning('b')
      h.setSucceeded('b')
      h.setRunning('join')
      completeJoinNode(h.deps, h.nodeRunId('join'))
      expect(h.nodes.get(h.nodeRunId('join'))?.status).toBe('succeeded')
    } finally {
      h.close()
    }
  })
})

describe('End 运行时（C-9）', () => {
  it('completes the run once no active branch remains, emitting the event exactly once', () => {
    const h = setup(definitionEnd())
    try {
      h.setRunning('end')
      completeEndNode(h.deps, h.nodeRunId('end'))
      expect(h.nodes.get(h.nodeRunId('end'))?.status).toBe('succeeded')
      expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('completed')
      expect(h.runs.get(h.runId)?.status).toBe('completed')
      expect(h.events).toEqual([{ type: 'workflow.completed', runId: h.runId }])

      completeEndNode(h.deps, h.nodeRunId('end'))
      expect(h.events).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('completes the run only after every branch reaches its own End', () => {
    const h = setup(definitionTwoEnds())
    try {
      // split 会在派发分支时把 blocked 分支激活；这里直接构造该状态。
      for (const key of ['split_1/a', 'split_1/b']) {
        const branch = h.branchId(key)
        if (branch) h.branches.transition(branch, ['blocked'], 'active', NOW)
      }
      h.setRunning('end_a')
      completeEndNode(h.deps, h.nodeRunId('end_a'))
      expect(h.runs.get(h.runId)?.status).toBe('running')
      expect(h.events).toHaveLength(0)

      h.setRunning('end_b')
      completeEndNode(h.deps, h.nodeRunId('end_b'))
      // 两个 split 分支都结束了，但 join 所在的 root 分支还在跑。
      expect(h.runs.get(h.runId)?.status).toBe('running')
      expect(h.events).toHaveLength(0)

      h.setRunning('end_join')
      completeEndNode(h.deps, h.nodeRunId('end_join'))
      expect(h.runs.get(h.runId)?.status).toBe('completed')
      expect(h.events).toEqual([{ type: 'workflow.completed', runId: h.runId }])
    } finally {
      h.close()
    }
  })

  it('keeps the run running while another branch is still active', () => {
    const h = setup(definitionJoin())
    try {
      const branchB = h.branchId('split_1/b')
      if (branchB) h.branches.transition(branchB, ['blocked'], 'active', NOW)
      h.setRunning('end')
      completeEndNode(h.deps, h.nodeRunId('end'))
      expect(h.runs.get(h.runId)?.status).toBe('running')
      expect(h.events).toHaveLength(0)
    } finally {
      h.close()
    }
  })
})

describe('HumanApproval 运行时', () => {
  it('enters waiting_approval, pauses only its branch and creates a pending approval', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      expect(h.nodes.get(h.nodeRunId('approval'))?.status).toBe('waiting_approval')
      expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('paused')
      const row = h.db
        .prepare("SELECT * FROM approvals WHERE node_run_id = 'nrn-approval'")
        .get() as Record<string, unknown>
      expect(row.status).toBe('pending')
      expect(row.approval_type).toBe('after_execute')
      expect(row.target_node_run_id).toBe('nrn-task_1')
      expect(row.decided_by).toBeNull()
      expect(row.decided_at).toBeNull()
    } finally {
      h.close()
    }
  })

  it('before_execute pending creates no Execution (negative)', () => {
    const h = setup(definitionApprovalBeforeExecute())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      expect(h.nodes.get(h.nodeRunId('approval'))?.status).toBe('waiting_approval')
      const row = h.db
        .prepare("SELECT target_node_run_id FROM approvals WHERE node_run_id = 'nrn-approval'")
        .get() as { target_node_run_id: string | null }
      expect(row.target_node_run_id).toBeNull()
      const executions = h.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
      expect(executions.n).toBe(0)
    } finally {
      h.close()
    }
  })

  it('requestForNode is idempotent while a pending row exists', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      const again = h.approvals.requestForNode(h.nodeRunId('approval'), {
        approvalType: 'after_execute',
        targetNodeRunId: 'nrn-task_1',
        requestedBy: 'system',
      })
      const rows = h.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }
      expect(rows.n).toBe(1)
      expect(again.status).toBe('pending')
    } finally {
      h.close()
    }
  })

  it('repeating the same decision returns the same row; a conflicting decision is rejected', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      const first = h.approvals.decide(h.nodeRunId('approval'), 'approve', { decidedBy: 'user-1' })
      const again = h.approvals.decide(h.nodeRunId('approval'), 'approve', { decidedBy: 'user-1' })
      expect(again.id).toBe(first.id)
      expect(() =>
        h.approvals.decide(h.nodeRunId('approval'), 'reject', { decidedBy: 'user-1' }),
      ).toThrow(/no pending approval/)
    } finally {
      h.close()
    }
  })

  it('approve succeeds the node and resumes the branch', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      const decided = h.approvals.decide(h.nodeRunId('approval'), 'approve', {
        decidedBy: 'user-1',
      })
      expect(decided.status).toBe('approved')
      expect(decided.decidedBy).toBe('user-1')
      expect(decided.decidedAt).toBe(NOW)
      expect(h.nodes.get(h.nodeRunId('approval'))?.status).toBe('succeeded')
      expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('active')
      expect(h.audit.listByAction('workflow.branch.resumed')[0]).toMatchObject({
        actorType: 'user',
        actorId: 'user-1',
        targetType: 'branch_run',
        details: { reason: 'approval_approved' },
      })
    } finally {
      h.close()
    }
  })

  it('request_changes requires a comment and leaves the branch paused', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      expect(() =>
        h.approvals.decide(h.nodeRunId('approval'), 'request_changes', { decidedBy: 'user-1' }),
      ).toThrow(ApprovalError)
      const decided = h.approvals.decide(h.nodeRunId('approval'), 'request_changes', {
        decidedBy: 'user-1',
        comment: 'fix it',
      })
      expect(decided.status).toBe('changes_requested')
      expect(decided.decisionComment).toBe('fix it')
      expect(h.nodes.get(h.nodeRunId('approval'))?.status).toBe('changes_requested')
      expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('paused')
    } finally {
      h.close()
    }
  })

  it('reject pauses the branch without rework', () => {
    const h = setup(definitionApproval())
    try {
      h.setRunning('approval')
      enterHumanApproval(h.deps, h.nodeRunId('approval'))
      const decided = h.approvals.decide(h.nodeRunId('approval'), 'reject', { decidedBy: 'user-1' })
      expect(decided.status).toBe('rejected')
      expect(h.nodes.get(h.nodeRunId('approval'))?.status).toBe('rejected')
      expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('paused')
    } finally {
      h.close()
    }
  })

  describe('ParallelSplit 运行时', () => {
    it('activates every split branch on success', () => {
      const h = setup(definitionJoin())
      try {
        h.setRunning('split_1')
        completeSplitNode(h.deps, h.nodeRunId('split_1'))
        expect(h.nodes.get(h.nodeRunId('split_1'))?.status).toBe('succeeded')
        expect(h.branches.getByKey(h.runId, 'split_1/a')?.status).toBe('active')
        expect(h.branches.getByKey(h.runId, 'split_1/b')?.status).toBe('active')
        expect(h.branches.getByKey(h.runId, ROOT_BRANCH_KEY)?.status).toBe('active')
      } finally {
        h.close()
      }
    })
  })

  describe('Join 的 skipped 规则', () => {
    it('does not block on skipped upstream and becomes skipped itself', () => {
      const h = setup(definitionJoin())
      try {
        h.setRunning('a')
        h.setSucceeded('a')
        h.setRunning('b')
        h.nodes.transition(h.nodeRunId('b'), ['running'], 'skipped', NOW)
        h.setRunning('join')
        completeJoinNode(h.deps, h.nodeRunId('join'))
        expect(h.nodes.get(h.nodeRunId('join'))?.status).toBe('skipped')
      } finally {
        h.close()
      }
    })

    it('still waits when a skipped upstream is mixed with a pending one', () => {
      const h = setup(definitionJoin())
      try {
        h.setRunning('a')
        h.nodes.transition(h.nodeRunId('a'), ['running'], 'skipped', NOW)
        h.setRunning('join')
        completeJoinNode(h.deps, h.nodeRunId('join'))
        expect(h.nodes.get(h.nodeRunId('join'))?.status).toBe('running')
      } finally {
        h.close()
      }
    })
  })

  describe('并行图端到端（真实 Scheduler + 控制节点）', () => {
    it('runs split → parallel tasks → join → end and completes the run exactly once', async () => {
      const h = setup(definitionJoin())
      try {
        const scheduler = new WorkflowScheduler({
          runs: h.runs,
          branches: h.branches,
          nodes: h.nodes,
          definitions: h.deps.definitions,
          gates: defaultDispatchGates(allowAllResourcePorts()),
          onNodeStarted: (context) => {
            const nodeRunId = context.nodeRun.id
            switch (context.node.type) {
              case 'start':
                completeStartNode(h.deps, nodeRunId)
                break
              case 'parallel_split':
                completeSplitNode(h.deps, nodeRunId)
                break
              case 'join':
                completeJoinNode(h.deps, nodeRunId)
                break
              case 'end':
                completeEndNode(h.deps, nodeRunId)
                break
              case 'agent_task':
                h.nodes.transition(nodeRunId, ['running'], 'succeeded', NOW, {
                  outputSnapshot: {},
                })
                break
              default:
                throw new Error(`unexpected node type ${context.node.type}`)
            }
          },
          now: () => NOW,
        })

        await scheduler.runUntilIdle(h.runId)

        expect(h.runs.get(h.runId)?.status).toBe('completed')
        expect(h.events).toEqual([{ type: 'workflow.completed', runId: h.runId }])
        for (const key of ['start', 'split_1', 'a', 'b', 'join', 'end']) {
          expect(h.nodes.get(h.nodeRunId(key))?.status).toBe('succeeded')
        }
        for (const key of [ROOT_BRANCH_KEY, 'split_1/a', 'split_1/b']) {
          expect(h.branches.getByKey(h.runId, key)?.status).toBe('completed')
        }
      } finally {
        h.close()
      }
    })
  })
})
