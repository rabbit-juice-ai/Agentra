import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROTOCOL_VERSION,
  WORKFLOW_RUN_GET_METHOD,
  WORKFLOW_RUN_LIST_BY_WORK_METHOD,
  WORKFLOW_TEMPLATE_ARCHIVE_METHOD,
  WORKFLOW_TEMPLATE_CREATE_METHOD,
  WORKFLOW_TEMPLATE_GET_METHOD,
  WORKFLOW_TEMPLATE_LIST_METHOD,
  WORKFLOW_TEMPLATE_UPDATE_METHOD,
  WORKFLOW_VERSION_CREATE_DRAFT_METHOD,
  WORKFLOW_VERSION_GET_METHOD,
  WORKFLOW_VERSION_LIST_METHOD,
  WORKFLOW_VERSION_PUBLISH_METHOD,
  WORKFLOW_VERSION_VALIDATE_METHOD,
} from '@agentra/protocol'
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
import { WorkflowRepository } from '../db/repositories/workflow-repository'
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
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
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
    workflows: new WorkflowDefinitionService(db, new WorkflowRepository(db), () => NOW),
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

function definition(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      nodes: [
        { key: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          key: 'task',
          type: 'agent_task',
          position: { x: 0, y: 1 },
          config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'do it' },
        },
        { key: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'task' },
        { key: 'e2', source: 'task', target: 'end' },
      ],
    }),
  ) as Record<string, unknown>
}

function invalidDefinition(): Record<string, unknown> {
  const def = definition()
  def.nodes = (def.nodes as Record<string, unknown>[]).filter((node) => node.type !== 'start')
  return def
}

describe('阶段 3 工作流定义 RPC', () => {
  it('creates, lists, gets, updates and archives templates', async () => {
    const { dispatch } = harness()

    const created = await dispatch(WORKFLOW_TEMPLATE_CREATE_METHOD, {
      name: '研发流程',
      description: 'demo',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const template = (created.result as { template: { id: string; name: string } }).template
    expect(template.name).toBe('研发流程')

    const listed = await dispatch(WORKFLOW_TEMPLATE_LIST_METHOD, {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect((listed.result as { templates: { id: string }[] }).templates).toHaveLength(1)

    const updated = await dispatch(WORKFLOW_TEMPLATE_UPDATE_METHOD, {
      id: template.id,
      name: '研发流程 v2',
    })
    expect(updated.ok).toBe(true)

    const archived = await dispatch(WORKFLOW_TEMPLATE_ARCHIVE_METHOD, { id: template.id })
    expect(archived.ok).toBe(true)

    const hidden = await dispatch(WORKFLOW_TEMPLATE_LIST_METHOD, {})
    if (!hidden.ok) return
    expect((hidden.result as { templates: unknown[] }).templates).toHaveLength(0)

    const withArchived = await dispatch(WORKFLOW_TEMPLATE_LIST_METHOD, { includeArchived: true })
    if (!withArchived.ok) return
    expect((withArchived.result as { templates: unknown[] }).templates).toHaveLength(1)
  })

  it('maps NOT_FOUND to INVALID_PARAMS', async () => {
    const { dispatch } = harness()
    const response = await dispatch(WORKFLOW_TEMPLATE_GET_METHOD, { id: 'missing' })
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('INVALID_PARAMS')
  })

  it('validate returns { valid, violations } and shares the shape with publish failures', async () => {
    const { dispatch } = harness()

    const valid = await dispatch(WORKFLOW_VERSION_VALIDATE_METHOD, { definition: definition() })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.result).toEqual({ valid: true, violations: [] })
    }

    const invalid = await dispatch(WORKFLOW_VERSION_VALIDATE_METHOD, {
      definition: invalidDefinition(),
    })
    expect(invalid.ok).toBe(true)
    if (!invalid.ok) return
    const violations = (invalid.result as { valid: boolean; violations: unknown[] }).violations
    expect((invalid.result as { valid: boolean }).valid).toBe(false)
    expect(violations.length).toBeGreaterThan(0)

    const template = await dispatch(WORKFLOW_TEMPLATE_CREATE_METHOD, { name: 't' })
    if (!template.ok) return
    const templateId = (template.result as { template: { id: string } }).template.id

    const draft = await dispatch(WORKFLOW_VERSION_CREATE_DRAFT_METHOD, {
      templateId,
      definition: invalidDefinition(),
    })
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.error.code).toBe('INVALID_PARAMS')
    const detail = draft.error.detail as { violations: unknown[] }
    // 与 validate 返回的数组结构完全一致（同一 validator、同一输入）
    expect(detail.violations).toEqual(violations)
  })

  it('returns UNKNOWN_NODE_TYPE as an error code without violations', async () => {
    const { dispatch } = harness()
    const def = definition()
    const nodes = def.nodes as Record<string, unknown>[]
    const task = nodes[1]
    if (!task) throw new Error('missing task node')
    task.type = 'retry_loop'

    const validated = await dispatch(WORKFLOW_VERSION_VALIDATE_METHOD, { definition: def })
    expect(validated.ok).toBe(false)
    if (!validated.ok) {
      expect(validated.error.code).toBe('UNKNOWN_NODE_TYPE')
      expect(validated.error.detail).toBeUndefined()
    }

    const template = await dispatch(WORKFLOW_TEMPLATE_CREATE_METHOD, { name: 't' })
    if (!template.ok) return
    const templateId = (template.result as { template: { id: string } }).template.id
    const draft = await dispatch(WORKFLOW_VERSION_CREATE_DRAFT_METHOD, {
      templateId,
      definition: def,
    })
    expect(draft.ok).toBe(false)
    if (!draft.ok) expect(draft.error.code).toBe('UNKNOWN_NODE_TYPE')
  })

  it('creates drafts, lists versions and publishes with cas_failed on the second attempt', async () => {
    const { dispatch } = harness()
    const template = await dispatch(WORKFLOW_TEMPLATE_CREATE_METHOD, { name: 't' })
    if (!template.ok) return
    const templateId = (template.result as { template: { id: string } }).template.id

    const first = await dispatch(WORKFLOW_VERSION_CREATE_DRAFT_METHOD, {
      templateId,
      definition: definition(),
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const draft = (first.result as { version: { id: string; version: number; status: string } })
      .version
    expect(draft.version).toBe(1)
    expect(draft.status).toBe('draft')

    const versions = await dispatch(WORKFLOW_VERSION_LIST_METHOD, { templateId })
    if (!versions.ok) return
    expect((versions.result as { versions: unknown[] }).versions).toHaveLength(1)

    const fetched = await dispatch(WORKFLOW_VERSION_GET_METHOD, { versionId: draft.id })
    expect(fetched.ok).toBe(true)

    const published = await dispatch(WORKFLOW_VERSION_PUBLISH_METHOD, { versionId: draft.id })
    expect(published.ok).toBe(true)
    if (published.ok) {
      expect((published.result as { version: { status: string } }).version.status).toBe('published')
    }

    const again = await dispatch(WORKFLOW_VERSION_PUBLISH_METHOD, { versionId: draft.id })
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.error.code).toBe('INVALID_PARAMS')
      const detail = again.error.detail as { violations: { violation: string }[] }
      expect(detail.violations[0]?.violation).toBe('cas_failed')
    }
  })

  it('version.list degrades unreadable rows instead of returning INTERNAL (F-3)', async () => {
    const { db, dispatch } = harness()
    const template = await dispatch(WORKFLOW_TEMPLATE_CREATE_METHOD, { name: 't' })
    if (!template.ok) return
    const templateId = (template.result as { template: { id: string } }).template.id

    const draft = await dispatch(WORKFLOW_VERSION_CREATE_DRAFT_METHOD, {
      templateId,
      definition: definition(),
    })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    db.prepare(
      `INSERT INTO workflow_versions (
         id, template_id, version, schema_version, definition_json, checksum, status,
         created_at, published_at
       ) VALUES ('wfv-bad', ?, 2, 0, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'x', 'draft', 't0', NULL)`,
    ).run(templateId)

    const listed = await dispatch(WORKFLOW_VERSION_LIST_METHOD, { templateId })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const result = listed.result as {
      versions: { id: string }[]
      skipped: { id: string; reason: string }[]
    }
    expect(result.versions).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.id).toBe('wfv-bad')
  })
})

describe('阶段 3 隔离断言', () => {
  it('exposes only the read-only workflow.run.get query, no execution entry', () => {
    const { methods } = harness()
    const names = Object.keys(methods)
    expect(names).toContain(WORKFLOW_RUN_GET_METHOD)
    for (const forbidden of ['workflow.run.start', 'workflow.run.create', 'workflow.run.cancel']) {
      expect(names).not.toContain(forbidden)
    }
    expect(names).toEqual(
      expect.arrayContaining([
        WORKFLOW_TEMPLATE_LIST_METHOD,
        WORKFLOW_TEMPLATE_GET_METHOD,
        WORKFLOW_TEMPLATE_CREATE_METHOD,
        WORKFLOW_TEMPLATE_UPDATE_METHOD,
        WORKFLOW_TEMPLATE_ARCHIVE_METHOD,
        WORKFLOW_VERSION_LIST_METHOD,
        WORKFLOW_VERSION_GET_METHOD,
        WORKFLOW_VERSION_CREATE_DRAFT_METHOD,
        WORKFLOW_VERSION_PUBLISH_METHOD,
        WORKFLOW_VERSION_VALIDATE_METHOD,
      ]),
    )
  })

  describe('workflow.run.listByWork', () => {
    it('lists runs of a work in descending creation order and rejects nothing for empty works', async () => {
      const h = harness()
      try {
        h.db
          .prepare(
            `INSERT INTO works (id, name, description, objective, status, priority, root_path,
           repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
          )
          .run(NOW, NOW)
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
            `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
         VALUES ('run-1', 'work-1', 'wfv-1', 'running', ?, '{}', ?, ?),
                ('run-2', 'work-1', 'wfv-1', 'completed', ?, '{}', ?, ?)`,
          )
          .run(NOW, NOW, NOW, NOW, NOW, NOW)

        const response = await h.dispatch(WORKFLOW_RUN_LIST_BY_WORK_METHOD, { workId: 'work-1' })
        expect(response.ok).toBe(true)
        if (!response.ok) return
        const result = response.result as { runs: { id: string; status: string }[] }
        // listByWork 按 created_at DESC 排序：run-2 先出现
        expect(result.runs.map((run) => run.id)).toEqual(['run-2', 'run-1'])

        const empty = await h.dispatch(WORKFLOW_RUN_LIST_BY_WORK_METHOD, { workId: 'work-empty' })
        expect(empty).toMatchObject({ ok: true, result: { runs: [] } })
      } finally {
        h.db.close()
      }
    })
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
