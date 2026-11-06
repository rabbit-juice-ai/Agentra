import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ASSIGNMENT_COMPLETE_METHOD,
  ASSIGNMENT_CREATE_METHOD,
  ASSIGNMENT_LIST_METHOD,
  ASSIGNMENT_PAUSE_METHOD,
  PROTOCOL_VERSION,
  RpcErrorCode,
  TEAM_CREATE_METHOD,
  TEAM_LIST_METHOD,
  WORK_CREATE_METHOD,
  WORK_LINK_TEAM_METHOD,
  WORK_PAUSE_METHOD,
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

/** 只用于构造 CoreMethodServices；阶段 2 的 RPC 测试不触发执行路径。 */
const unusedRuntime: RuntimeClient = {
  discover: async () => [],
  start: async () => {
    throw new Error('runtime.start is not used in phase 2 rpc tests')
  },
  sendMessage: async () => {},
  interrupt: async () => ({ interrupted: false }),
  cancel: async () => {},
  status: async () => {
    throw new Error('runtime.status is not used in phase 2 rpc tests')
  },
  listActive: async () => [],
  subscribe: () => () => {},
  close: () => {},
}

function harness(): {
  db: Database
  dispatch: (method: string, params: unknown) => Promise<unknown>
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-rpc-'))
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

  const methods: MethodTable = coreMethods('0.1.0', '/tmp/none.sock', {
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

  const dispatch = async (method: string, params: unknown) => {
    const frame = JSON.stringify({
      requestId: 'req-phase2-test',
      protocolVersion: PROTOCOL_VERSION,
      method,
      params,
    })
    return createDispatcher(methods)(frame)
  }
  return { db, dispatch }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('阶段 2 RPC 方法表', () => {
  it('declares the WORKDIR_LOCKED error code (B2 只声明，行为在 B3)', () => {
    expect(RpcErrorCode.options).toContain('WORKDIR_LOCKED')
  })

  it('drives Team / Work / Assignment end to end over the dispatcher', async () => {
    const h = harness()

    const teamResponse = (await h.dispatch(TEAM_CREATE_METHOD, { name: 'Alpha' })) as {
      ok: boolean
      result?: { team: { id: string; status: string } }
    }
    expect(teamResponse.ok).toBe(true)
    const teamId = teamResponse.result?.team.id ?? ''
    expect(teamResponse.result?.team.status).toBe('active')

    const listTeams = (await h.dispatch(TEAM_LIST_METHOD, {})) as {
      result?: { teams: { id: string }[] }
    }
    expect(listTeams.result?.teams.map((team) => team.id)).toContain(teamId)

    const workResponse = (await h.dispatch(WORK_CREATE_METHOD, {
      name: 'W1',
      rootPath: '/tmp/w1',
    })) as { ok: boolean; result?: { work: { id: string; status: string; teamIds: string[] } } }
    const workId = workResponse.result?.work.id ?? ''
    expect(workResponse.result?.work.status).toBe('draft')

    const linked = (await h.dispatch(WORK_LINK_TEAM_METHOD, { workId, teamId })) as {
      result?: { work: { teamIds: string[] } }
    }
    expect(linked.result?.work.teamIds).toEqual([teamId])

    const assignmentResponse = (await h.dispatch(ASSIGNMENT_CREATE_METHOD, {
      workId,
      agentId: 'agt-missing',
      workRole: 'engineer',
    })) as { ok: boolean; error?: { code: string } }
    // 未知 Agent：错误码透传
    expect(assignmentResponse.ok).toBe(false)
    expect(assignmentResponse.error?.code).toBe('AGENT_NOT_FOUND')
  })

  it('rejects illegal transitions over RPC with INVALID_PARAMS (状态机经 RPC 仍生效)', async () => {
    const h = harness()
    const team = (await h.dispatch(TEAM_CREATE_METHOD, { name: 'Alpha' })) as {
      ok: boolean
      result: { team: { id: string } }
    }
    const work = (await h.dispatch(WORK_CREATE_METHOD, { name: 'W1', rootPath: '/tmp/w1' })) as {
      result: { work: { id: string } }
    }

    // draft 不能直接 pause（WorkService 状态机）
    const pauseDraft = (await h.dispatch(WORK_PAUSE_METHOD, { id: work.result.work.id })) as {
      ok: boolean
      error?: { code: string; message: string }
    }
    expect(pauseDraft.ok).toBe(false)
    expect(pauseDraft.error?.code).toBe('INVALID_PARAMS')
    expect(pauseDraft.error?.message).toContain('cannot transition')

    // 未知 Team 关联 → INVALID_PARAMS
    const badLink = (await h.dispatch(WORK_LINK_TEAM_METHOD, {
      workId: work.result.work.id,
      teamId: 'team-missing',
    })) as { ok: boolean; error?: { code: string } }
    expect(badLink.error?.code).toBe('INVALID_PARAMS')
    expect(team.ok).toBe(true)
  })

  it('keeps CAS semantics: a completed assignment cannot be paused again', async () => {
    const h = harness()
    const agent = h.db.prepare('SELECT id FROM agent_profiles LIMIT 1').get() as
      | { id: string }
      | undefined
    if (!agent) {
      h.db
        .prepare(
          `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json, tool_permissions_json, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at)
           VALUES ('agt-1', 'A', 'engineer', '', '', '[]', '{"version":1,"allow":["Read"],"deny":[]}', NULL, 1, 'active', ?, ?, NULL)`,
        )
        .run(NOW, NOW)
    }
    const work = (await h.dispatch(WORK_CREATE_METHOD, { name: 'W1', rootPath: '/tmp/w1' })) as {
      result: { work: { id: string } }
    }
    const assignment = (await h.dispatch(ASSIGNMENT_CREATE_METHOD, {
      workId: work.result.work.id,
      agentId: agent?.id ?? 'agt-1',
      workRole: 'engineer',
    })) as { ok: boolean; result?: { assignment: { id: string } } }
    expect(assignment.ok).toBe(true)
    const assignmentId = assignment.result?.assignment.id ?? ''

    const completed = (await h.dispatch(ASSIGNMENT_COMPLETE_METHOD, { id: assignmentId })) as {
      result?: { assignment: { status: string } }
    }
    expect(completed.result?.assignment.status).toBe('completed')

    const pauseAgain = (await h.dispatch(ASSIGNMENT_PAUSE_METHOD, { id: assignmentId })) as {
      ok: boolean
      error?: { code: string }
    }
    expect(pauseAgain.ok).toBe(false)
    expect(pauseAgain.error?.code).toBe('INVALID_PARAMS')

    const list = (await h.dispatch(ASSIGNMENT_LIST_METHOD, {
      workId: work.result.work.id,
    })) as { result?: { assignments: { id: string; status: string }[] } }
    // 状态没有被静默改回去
    expect(list.result?.assignments[0]).toMatchObject({ id: assignmentId, status: 'completed' })
  })
})
