import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION, WORKFLOW_RUN_GET_METHOD } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../daemon/daemon-client'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { AgentService } from '../services/agent-service'
import { ApprovalRpcService } from '../services/approval-rpc-service'
import { AssignmentService } from '../services/assignment-service'
import { CoreEventHub } from '../services/event-hub'
import { ExecutionService } from '../services/execution-service'
import { ProviderRegistry } from '../services/provider-registry'
import { TeamService } from '../services/team-service'
import { WorkService } from '../services/work-service'
import { WorkdirLockService } from '../services/workdir-lock-service'
import { WorktreeService } from '../services/worktree-service'
import { ApprovalService } from '../workflow/approval-service'
import { WorkflowRunQueryService } from '../workflow/run-query-service'
import { createDispatcher, type MethodTable } from './dispatcher'
import { coreMethods } from './methods'

const TEST_BOOT = { status: 'known' as const, uuid: '11111111-1111-4111-8111-111111111111' }

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

const unusedRuntime: RuntimeClient = {
  discover: async () => [],
  start: async () => {
    throw new Error('runtime.start is not used in workflow rpc tests')
  },
  sendMessage: async () => {},
  interrupt: async () => ({ interrupted: false }),
  cancel: async () => {},
  status: async () => {
    throw new Error('runtime.status is not used in workflow rpc tests')
  },
  listActive: async () => [],
  subscribe: () => () => {},
  close: () => {},
}

type RpcEnvelope =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: { code: string; message: string; detail?: unknown } }

function harness(): {
  db: Database
  methods: MethodTable
  dispatch: (method: string, params: unknown) => Promise<RpcEnvelope>
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-workflow-rpc-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
     VALUES ('claude-code', 'cli', 'Claude Code', '{}', 'healthy', ?, ?)`,
  ).run(NOW, NOW)

  const agentRepository = new AgentRepository(db)
  const providerRepository = new ProviderRepository(db)
  const sessionRepository = new SessionRepository(db)
  const executionRepository = new ExecutionRepository(db)
  const logRepository = new ExecutionLogRepository(db)
  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const auditRepository = new AuditRepository(db)

  const registry = new ProviderRegistry(providerRepository, unusedRuntime)
  const executions = new ExecutionService({
    db,
    runtime: unusedRuntime,
    registry,
    works: workRepository,
    assignments: assignmentRepository,
    worktrees: new WorktreeService(
      db,
      workRepository,
      new AssignmentRepository(db),
      path.join(dir, 'worktrees'),
      () => NOW,
    ),
    locks: new WorkdirLockService(db, () => NOW, undefined, TEST_BOOT),
    agents: agentRepository,
    sessions: sessionRepository,
    executions: executionRepository,
    logs: logRepository,
    hub: new CoreEventHub(),
    scratchRoot: path.join(dir, 'scratch'),
    now: () => NOW,
  })

  const methods = coreMethods('0.1.0', '/tmp/none.sock', {
    agents: new AgentService(db, agentRepository, providerRepository, () => NOW),
    registry,
    executions,
    hub: new CoreEventHub(),
    teams: new TeamService(db, teamRepository, agentRepository, () => NOW),
    works: new WorkService(db, workRepository, teamRepository, auditRepository, () => NOW),
    assignments: new AssignmentService(
      db,
      assignmentRepository,
      workRepository,
      agentRepository,
      teamRepository,
      sessionRepository,
      () => NOW,
    ),
    worktrees: new WorktreeService(
      db,
      workRepository,
      new AssignmentRepository(db),
      path.join(dir, 'worktrees'),
      () => NOW,
    ),
    workflowRuns: new WorkflowRunQueryService(
      new WorkflowRunRepository(db),
      new BranchRunRepository(db),
      new NodeRunRepository(db),
    ),
    approvals: new ApprovalRpcService(
      new ApprovalService(
        db,
        new ApprovalRepository(db),
        new NodeRunRepository(db),
        new BranchRunRepository(db),
      ),
      new ApprovalRepository(db),
    ),
    artifacts: {
      preview: () => {
        throw new Error('not used in this test')
      },
      listByWork: () => ({ artifacts: [] }),
    } as never,
    backups: {
      create: () => {
        throw new Error('not used in this test')
      },
      list: () => [],
      exportTo: () => '',
    } as never,
    backupPrecheck: {
      precheck: () => {
        throw new Error('not used in this test')
      },
    } as never,
  })

  const dispatch = async (method: string, params: unknown): Promise<RpcEnvelope> => {
    const frame = JSON.stringify({
      requestId: 'req-workflow-test',
      protocolVersion: PROTOCOL_VERSION,
      method,
      params,
    })
    return (await createDispatcher(methods)(frame)) as RpcEnvelope
  }

  return { db, methods, dispatch }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('执行内核 RPC 隔离断言', () => {
  it('exposes only the read-only run query and no product workflow entry points', () => {
    const { methods } = harness()
    const names = Object.keys(methods)
    expect(names).toContain(WORKFLOW_RUN_GET_METHOD)
    expect(methods[WORKFLOW_RUN_GET_METHOD]?.access).toBe('read')
    for (const removed of [
      'workflow.run.start',
      'workflow.run.listByWork',
      'workflow.template.list',
      'workflow.template.get',
      'workflow.template.create',
      'workflow.template.update',
      'workflow.template.archive',
      'workflow.version.list',
      'workflow.version.get',
      'workflow.version.createDraft',
      'workflow.version.publish',
      'workflow.version.validate',
      'workflow.run.create',
      'workflow.run.cancel',
    ]) {
      expect(names).not.toContain(removed)
    }
  })

  describe('workflow.run.get', () => {
    it('returns run / branches / nodes including reconciliation_required', async () => {
      const h = harness()
      try {
        h.db
          .prepare(
            `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
         VALUES ('wft-1', 'T', '', '', ?, ?, NULL)`,
          )
          .run(NOW, NOW)
        h.db
          .prepare(
            `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at)
         VALUES ('wfv-1', 'wft-1', 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'sum', 'published', ?, ?)`,
          )
          .run(NOW, NOW)
        h.db
          .prepare(
            `INSERT INTO works (id, name, description, objective, status, priority, root_path,
           repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
          )
          .run(NOW, NOW)
        h.db
          .prepare(
            `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-1', 'work-1', 'wfv-1', 'running', ?, '{}', ?, ?)`,
          )
          .run(NOW, NOW, NOW)
        h.db
          .prepare(
            `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
         VALUES ('br-1', 'run-1', 'root', 'active', ?, ?)`,
          )
          .run(NOW, NOW)
        h.db
          .prepare(
            `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt, input_snapshot_json, created_at, updated_at)
         VALUES ('nrn-1', 'run-1', 'task_1', 'br-1', 'reconciliation_required', 1, '{}', ?, ?)`,
          )
          .run(NOW, NOW)

        const response = await h.dispatch(WORKFLOW_RUN_GET_METHOD, { runId: 'run-1' })
        expect(response.ok).toBe(true)
        if (!response.ok) return
        const result = response.result as {
          run: { id: string; status: string }
          branches: { branchKey: string }[]
          nodes: { workflowNodeKey: string; status: string }[]
        }
        expect(result.run).toMatchObject({ id: 'run-1', status: 'running' })
        expect(result.branches.map((branch) => branch.branchKey)).toEqual(['root'])
        expect(result.nodes).toEqual([
          expect.objectContaining({ workflowNodeKey: 'task_1', status: 'reconciliation_required' }),
        ])

        const missing = await h.dispatch(WORKFLOW_RUN_GET_METHOD, { runId: 'missing' })
        expect(missing).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
      } finally {
        h.db.close()
      }
    })
  })
})
