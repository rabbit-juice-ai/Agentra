import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APPROVAL_DECIDE_METHOD,
  APPROVAL_GET_METHOD,
  APPROVAL_LIST_PENDING_METHOD,
  PROTOCOL_VERSION,
} from '@agentra/protocol'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowEventRepository } from '../db/repositories/workflow-event-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { ApprovalRpcService } from '../services/approval-rpc-service'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalService } from '../workflow/approval-service'
import { enterHumanApproval } from '../workflow/control-nodes'
import { PublishedDefinitionProvider } from '../workflow/published-definition-provider'
import { WorkflowRunQueryService } from '../workflow/run-query-service'
import { createDispatcher, type MethodTable } from './dispatcher'
import { coreMethods } from './methods'

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

const node = (key: string, type: string, config: Record<string, unknown> = {}, y = 0) => ({
  key,
  type,
  label: '',
  position: { x: 0, y },
  config,
})
const task = (key: string, y = 1) =>
  node(key, 'agent_task', { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'x' }, y)

function afterExecuteDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1'),
      node(
        'approval',
        'human_approval',
        { target: { nodeKey: 'task_1', phase: 'after_execute' } },
        2,
      ),
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

type Harness = {
  db: Database
  dispatch: (method: string, params: unknown) => Promise<unknown>
  approvals: ApprovalRepository
  audit: AuditRepository
  approvalService: ApprovalService
  nodes: NodeRunRepository
  branches: BranchRunRepository
  runs: WorkflowRunRepository
  runId: string
  approvalRunId: string
  taskRunId: string
  close: () => void
}

function setup(definition: WorkflowDefinition): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-approval-rpc-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
     VALUES ('claude-code', 'cli', 'Claude Code', '{}', 'healthy', ?, ?)`,
  ).run(NOW, NOW)

  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const draft = definitionService.createDraft(template.id, definition)
  definitionService.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const approvalRepository = new ApprovalRepository(db)
  const audit = new AuditRepository(db)
  const approvalService = new ApprovalService(
    db,
    approvalRepository,
    nodes,
    branches,
    () => NOW,
    undefined,
    audit,
    {
      // 生产装配同样把 approval.decided 落 workflow_events；测试里用同一 sink 语义。
      publish: (event) => {
        new WorkflowEventRepository(db).append({
          eventId: `approval:${event.approvalId}:approval.decided:${event.round}`,
          workflowRunId: event.runId,
          nodeRunId: event.nodeRunId,
          eventType: 'approval.decided',
          payload: { decision: event.decision, round: event.round },
          occurredAt: event.occurredAt,
        })
      },
    },
  )
  const approvalRpc = new ApprovalRpcService(approvalService, approvalRepository)

  runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, NOW)
  runs.transition('run-1', ['pending'], 'running', NOW)
  // RunService 只在 createRun 时建分支；这里手工建 root 分支（保持 harness 轻量）。
  const root = branches.create({ id: 'br-root', workflowRunId: 'run-1', branchKey: 'root' }, NOW)
  for (const definitionNode of definition.nodes) {
    nodes.create(
      {
        id: `nrn-${definitionNode.key}`,
        workflowRunId: 'run-1',
        workflowNodeKey: definitionNode.key,
        branchRunId: root.id,
      },
      NOW,
    )
  }
  nodes.transition('nrn-approval', ['blocked'], 'ready', NOW)
  nodes.transition('nrn-approval', ['ready'], 'running', NOW)
  void enterHumanApproval(
    {
      db,
      runs,
      branches,
      nodes,
      definitions,
      approvals: approvalService,
      now: () => NOW,
    },
    'nrn-approval',
  )
  nodes.transition('nrn-task_1', ['blocked'], 'ready', NOW)
  nodes.transition('nrn-task_1', ['ready'], 'running', NOW)

  const methods: MethodTable = coreMethods('0.1.0', '/tmp/none.sock', {
    approvals: approvalRpc,
    workflowRuns: new WorkflowRunQueryService(runs, branches, nodes),
  } as never)
  const dispatcher = createDispatcher(methods)
  const dispatch = async (method: string, params: unknown) =>
    dispatcher(
      JSON.stringify({
        requestId: 'req-test-0001',
        protocolVersion: PROTOCOL_VERSION,
        method,
        params,
      }),
    )

  return {
    db,
    dispatch,
    approvals: approvalRepository,
    audit,
    approvalService,
    nodes,
    branches,
    runs,
    runId: 'run-1',
    approvalRunId: 'nrn-approval',
    taskRunId: 'nrn-task_1',
    close: () => db.close(),
  }
}

describe('approval RPC · A2/A3/A6/A11/A13', () => {
  it('A3: request_changes without comment is rejected by the API', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      const result = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'request_changes',
        decidedBy: 'user-1',
      })) as { ok: boolean; error?: { code: string; detail?: { code?: string } } }
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('INVALID_PARAMS')
      expect(result.error?.detail?.code).toBe('COMMENT_REQUIRED')
      expect(h.approvals.findPendingByNodeRun(h.approvalRunId)?.status).toBe('pending')
    } finally {
      h.close()
    }
  })

  it('A2: reject keeps the branch paused and creates no rework', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      const result = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'reject',
        decidedBy: 'user-1',
      })) as { ok: boolean; result?: { approval: { status: string } } }
      expect(result.ok).toBe(true)
      expect(result.result?.approval.status).toBe('rejected')
      expect(h.branches.listByRun(h.runId)[0]?.status).toBe('paused')
      expect(
        (h.db.prepare('SELECT COUNT(*) AS c FROM rework_requests').get() as { c: number }).c,
      ).toBe(0)
    } finally {
      h.close()
    }
  })

  it('A13: decision records decided_by / decided_at / decision_comment', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'request_changes',
        decidedBy: 'user-1',
        comment: 'please fix the header',
      })
      const record = h.approvals.latestByNodeRun(h.approvalRunId)
      expect(record).toMatchObject({
        status: 'changes_requested',
        decidedBy: 'user-1',
        decidedAt: NOW,
        decisionComment: 'please fix the header',
      })
    } finally {
      h.close()
    }
  })

  it('A11: repeating the same decision is a no-op (one terminal record, one node transition, no duplicate rework)', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      const first = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'request_changes',
        decidedBy: 'user-1',
        comment: 'fix',
      })) as { ok: boolean; result?: { approval: { id: string } } }
      expect(first.ok).toBe(true)
      const approvalId = first.result?.approval.id

      const before = {
        approvals: (h.db.prepare('SELECT COUNT(*) AS c FROM approvals').get() as { c: number }).c,
        reworks: (h.db.prepare('SELECT COUNT(*) AS c FROM rework_requests').get() as { c: number })
          .c,
        nodeStatus: h.nodes.get(h.approvalRunId)?.status,
      }

      const again = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'request_changes',
        decidedBy: 'user-1',
        comment: 'fix',
      })) as { ok: boolean; result?: { approval: { id: string } } }
      expect(again.ok).toBe(true)
      expect(again.result?.approval.id).toBe(approvalId)

      const after = {
        approvals: (h.db.prepare('SELECT COUNT(*) AS c FROM approvals').get() as { c: number }).c,
        reworks: (h.db.prepare('SELECT COUNT(*) AS c FROM rework_requests').get() as { c: number })
          .c,
        nodeStatus: h.nodes.get(h.approvalRunId)?.status,
      }
      expect(after).toEqual(before)
      // NodeRun 单次状态迁移：仍是 changes_requested
      expect(after.nodeStatus).toBe('changes_requested')
    } finally {
      h.close()
    }
  })

  it('A11 conflicting decision after a terminal one is rejected', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'approve',
        decidedBy: 'user-1',
      })
      const conflict = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'reject',
        decidedBy: 'user-1',
      })) as { ok: boolean; error?: { code: string } }
      expect(conflict.ok).toBe(false)
      expect(conflict.error?.code).toBe('INVALID_PARAMS')
    } finally {
      h.close()
    }
  })

  it('get returns pending + history; listPending returns the pending row', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      const pending = (await h.dispatch(APPROVAL_GET_METHOD, {
        nodeRunId: h.approvalRunId,
      })) as { ok: boolean; result?: { approval: { status: string } | null; history: unknown[] } }
      expect(pending.ok).toBe(true)
      expect(pending.result?.approval?.status).toBe('pending')
      expect(pending.result?.history).toHaveLength(1)

      await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'approve',
        decidedBy: 'user-1',
      })
      const after = (await h.dispatch(APPROVAL_GET_METHOD, {
        nodeRunId: h.approvalRunId,
      })) as { ok: boolean; result?: { approval: { status: string } | null; history: unknown[] } }
      expect(after.result?.approval).toBeNull()
      expect(after.result?.history).toHaveLength(1)

      const list = (await h.dispatch(APPROVAL_LIST_PENDING_METHOD, {
        runId: h.runId,
      })) as { ok: boolean; result?: { approvals: unknown[] } }
      expect(list.result?.approvals).toEqual([])
    } finally {
      h.close()
    }
  })

  it('approval.decided event carries occurredAt = decision time and is deduped by event_id', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'approve',
        decidedBy: 'user-1',
      })
      const events = h.db
        .prepare(
          "SELECT event_id, occurred_at FROM workflow_events WHERE event_type = 'approval.decided'",
        )
        .all() as { event_id: string; occurred_at: string }[]
      expect(events).toHaveLength(1)
      expect(events[0]?.event_id).toBe(
        `approval:${h.approvals.latestByNodeRun(h.approvalRunId)?.id}:approval.decided:1`,
      )
      // occurredAt = 决策时刻（注入时钟 NOW），不是 sink 执行时刻
      expect(events[0]?.occurred_at).toBe(NOW)

      // 重复决策（幂等 no-op）不追加第二条事件
      await h.dispatch(APPROVAL_DECIDE_METHOD, {
        nodeRunId: h.approvalRunId,
        decision: 'approve',
        decidedBy: 'user-1',
      })
      const again = h.db
        .prepare("SELECT COUNT(*) AS c FROM workflow_events WHERE event_type = 'approval.decided'")
        .get() as { c: number }
      expect(again.c).toBe(1)
    } finally {
      h.close()
    }
  })
})

describe('A15 · 审批决策写 audit_logs（actor/action/target 三维度可查）', () => {
  it('writes one audit row per decision for all three decision kinds', async () => {
    // 三种决策各跑一次：approve / request_changes / reject
    const decisions = [
      { decision: 'approve' as const, comment: undefined },
      { decision: 'request_changes' as const, comment: 'please fix' },
      { decision: 'reject' as const, comment: undefined },
    ]
    for (const { decision, comment } of decisions) {
      const h = setup(afterExecuteDefinition())
      try {
        const result = (await h.dispatch(APPROVAL_DECIDE_METHOD, {
          nodeRunId: h.approvalRunId,
          decision,
          decidedBy: 'user-15',
          comment,
        })) as { ok: boolean }
        expect(result.ok).toBe(true)

        // ① 按 action 查
        const byAction = h.audit.listByAction('workflow.approval.decided')
        expect(byAction).toHaveLength(1)
        // ② 按 target 查
        const byTarget = h.audit.listByTarget(
          'approval',
          h.approvals.latestByNodeRun(h.approvalRunId)?.id ?? '',
        )
        expect(byTarget).toHaveLength(1)
        expect(byTarget[0]?.id).toBe(byAction[0]?.id)
        // ③ 按 actor 查（A15 要求 actor 维度可查）
        const byActor = byAction.filter(
          (row) => row.actorType === 'user' && row.actorId === 'user-15',
        )
        expect(byActor).toHaveLength(1)
        // 行内容：actor / action / target / details 齐备
        expect(byAction[0]).toMatchObject({
          actorType: 'user',
          actorId: 'user-15',
          action: 'workflow.approval.decided',
          targetType: 'approval',
          details: {
            runId: h.runId,
            nodeRunId: h.approvalRunId,
            round: 1,
            decision,
            comment: comment ?? null,
          },
        })
      } finally {
        h.close()
      }
    }
  })

  it('does not write a duplicate audit row on idempotent replay (A11 consistency)', async () => {
    const h = setup(afterExecuteDefinition())
    try {
      const params = {
        nodeRunId: h.approvalRunId,
        decision: 'approve' as const,
        decidedBy: 'user-15',
      }
      await h.dispatch(APPROVAL_DECIDE_METHOD, params)
      await h.dispatch(APPROVAL_DECIDE_METHOD, params)
      expect(h.audit.listByAction('workflow.approval.decided')).toHaveLength(1)
    } finally {
      h.close()
    }
  })
})

describe('A10 · 重启后待审批状态恢复', () => {
  it('pending approval and rework state survive a full close/reopen of the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-approval-restart-'))
    dirs.push(dir)
    const file = path.join(dir, 'agentra.db')

    // 第一次"进程"：创建 pending 审批
    const first = openDatabase(file)
    try {
      const h = setupInDb(first, afterExecuteDefinition())
      const record = h.approvals.findPendingByNodeRun('nrn-approval')
      expect(record?.status).toBe('pending')
    } finally {
      first.close()
    }

    // 第二次"进程"：重新打开，pending 仍在，决策可执行
    const second = openDatabase(file)
    try {
      const approvalRepository = new ApprovalRepository(second)
      const pending = approvalRepository.findPendingByNodeRun('nrn-approval')
      expect(pending?.status).toBe('pending')

      const nodes = new NodeRunRepository(second)
      const branches = new BranchRunRepository(second)
      const approvalService = new ApprovalService(
        second,
        approvalRepository,
        nodes,
        branches,
        () => NOW,
      )
      const decided = approvalService.decide('nrn-approval', 'approve', {
        decidedBy: 'user-1',
      })
      expect(decided.status).toBe('approved')
      expect(nodes.get('nrn-approval')?.status).toBe('succeeded')
    } finally {
      second.close()
    }
  })
})

function setupInDb(
  db: Database,
  definition: WorkflowDefinition,
): {
  approvals: ApprovalRepository
} {
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const draft = definitionService.createDraft(template.id, definition)
  definitionService.publish(draft.id)
  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const approvalRepository = new ApprovalRepository(db)
  const approvalService = new ApprovalService(db, approvalRepository, nodes, branches, () => NOW)
  runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, NOW)
  runs.transition('run-1', ['pending'], 'running', NOW)
  const root = branches.create({ id: 'br-root', workflowRunId: 'run-1', branchKey: 'root' }, NOW)
  for (const definitionNode of definition.nodes) {
    nodes.create(
      {
        id: `nrn-${definitionNode.key}`,
        workflowRunId: 'run-1',
        workflowNodeKey: definitionNode.key,
        branchRunId: root.id,
      },
      NOW,
    )
  }
  nodes.transition('nrn-approval', ['blocked'], 'ready', NOW)
  nodes.transition('nrn-approval', ['ready'], 'running', NOW)
  void enterHumanApproval(
    { db, runs, branches, nodes, definitions, approvals: approvalService, now: () => NOW },
    'nrn-approval',
  )
  return { approvals: approvalRepository }
}
