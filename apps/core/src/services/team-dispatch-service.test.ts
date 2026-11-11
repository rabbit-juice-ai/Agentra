import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type AgentProfile,
  type Execution,
  type PlanDraft,
  PlanDraft as PlanDraftSchema,
  type PlanRecord,
  type PlanVersion,
  type RuntimeProviderRecord,
} from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import {
  PlanDispatchRepository,
  PlanStartAttemptRepository,
  PlanTaskAssignmentRepository,
} from '../db/repositories/plan-dispatch-repository'
import {
  PlanCommentRepository,
  PlanRepository,
  PlanThreadRepository,
  PlanVersionRepository,
} from '../db/repositories/plan-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { PlanAssignmentError, PlanAssignmentService } from './plan-assignment-service'
import { TeamDispatchService } from './team-dispatch-service'
import { TeamService } from './team-service'

const NOW = '2026-11-07T01:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function agent(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  const { id, ...rest } = overrides
  const accessMode = overrides.accessMode ?? 'edit'
  return {
    id,
    name: overrides.name ?? id,
    avatar: '🤖',
    description: '',
    systemPrompt: '',
    skillIds: [],
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: 'provider-1',
    maxConcurrency: 5,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...rest,
  }
}

function provider(toolControl: 'native' | 'emulated' | 'unsupported'): RuntimeProviderRecord {
  return {
    id: 'provider-1',
    providerType: 'cli',
    providerName: 'Test Provider',
    executablePath: '/bin/true',
    version: '1.0.0',
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl,
    },
    healthStatus: 'healthy',
    authMethod: null,
    healthDetail: null,
    lastDiscoveredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function execution(id = 'exe-leader'): Execution {
  return {
    id,
    sessionId: 'ses-leader',
    providerId: 'provider-1',
    agentId: 'agt-leader',
    externalExecutionId: null,
    processId: null,
    status: 'running',
    workingDirectory: '/tmp/leader',
    startedAt: NOW,
    endedAt: null,
    exitCode: null,
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function insertAgent(db: ReturnType<typeof openDatabase>, profile: AgentProfile): void {
  db.prepare(
    `INSERT INTO agent_profiles (
      id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
      model, tool_permissions_json, default_provider_id, max_concurrency, status,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, '[]', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    profile.id,
    profile.name,
    profile.avatar,
    profile.description,
    profile.systemPrompt,
    profile.accessMode,
    JSON.stringify(profile.toolPermissions),
    profile.defaultProviderId,
    profile.maxConcurrency,
    profile.status,
    profile.createdAt,
    profile.updatedAt,
  )
}

function planDraft(teamId: string): PlanDraft {
  return PlanDraftSchema.parse({
    agentraPlanVersion: 1,
    goal: 'ship a team feature',
    tasks: [
      {
        key: 'fe',
        title: 'Frontend',
        description: 'build UI',
        responsibilityRole: 'frontend',
        requiredAccessMode: 'edit',
        teamId,
        outputs: ['ui'],
      },
      {
        key: 'be',
        title: 'Backend',
        description: 'build API',
        responsibilityRole: 'backend',
        requiredAccessMode: 'edit',
        teamId,
        outputs: ['api'],
      },
    ],
  })
}

function harness(
  options: {
    withLeader?: boolean
    toolControl?: 'native' | 'emulated' | 'unsupported'
    output?: unknown
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-dispatch-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO runtime_providers (
      id, provider_type, provider_name, executable_path, version, capabilities_json, health_status,
      last_discovered_at, created_at, updated_at
    ) VALUES ('provider-1', 'cli', 'Test Provider', '/bin/true', '1.0.0', ?, 'healthy', ?, ?, ?)`,
  ).run(
    JSON.stringify({
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    }),
    NOW,
    NOW,
    NOW,
  )
  const leader = agent({ id: 'agt-leader', name: 'Leader', accessMode: 'analyze' })
  const memberA = agent({ id: 'agt-a', name: 'Member A' })
  const memberB = agent({ id: 'agt-b', name: 'Member B' })
  const outsider = agent({ id: 'agt-out', name: 'Outsider' })
  for (const profile of [leader, memberA, memberB, outsider]) insertAgent(db, profile)
  db.prepare(
    `INSERT INTO works (
      id, name, description, objective, status, priority, root_path, repository_path,
      settings_json, created_at, updated_at, completed_at
    ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const teamRepository = new TeamRepository(db)
  const agentRepository = new AgentRepository(db)
  const teamService = new TeamService(db, teamRepository, agentRepository, () => NOW)
  const team = teamService.create({ name: 'Delivery', instructions: 'run tests first' })
  teamService.addMember(team.id, 'agt-a')
  teamService.addMember(team.id, 'agt-b')
  if (options.withLeader !== false) {
    teamService.update(team.id, { leaderAgentId: 'agt-leader' })
  }

  const planRepository = new PlanRepository(db)
  const versionRepository = new PlanVersionRepository(db)
  const plan: PlanRecord = {
    id: 'plan-1',
    workId: 'work-1',
    goal: 'ship a team feature',
    status: 'approved',
    currentVersion: 1,
    workflowVersionId: null,
    workflowRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    approvedAt: NOW,
    approvedBy: 'boss',
  }
  const version: PlanVersion = {
    id: 'plnv-1',
    planId: plan.id,
    version: 1,
    plan: planDraft(team.id),
    validation: {
      valid: true,
      violations: [],
      assignments: [
        { taskKey: 'fe', agentId: null, agentName: null },
        { taskKey: 'be', agentId: null, agentName: null },
      ],
    },
    assignments: [
      { taskKey: 'fe', agentId: null, agentName: null },
      { taskKey: 'be', agentId: null, agentName: null },
    ],
    checksum: 'checksum',
    status: 'approved',
    source: 'planner',
    fallbackReason: null,
    createdAt: NOW,
    approvedAt: NOW,
    approvedBy: 'boss',
  }
  planRepository.create(plan)
  versionRepository.create(version)

  const assignmentRepository = new PlanTaskAssignmentRepository(db)
  const dispatchRepository = new PlanDispatchRepository(db)
  const startAttemptRepository = new PlanStartAttemptRepository(db)
  const assignments = new PlanAssignmentService({
    db,
    assignments: assignmentRepository,
    dispatches: dispatchRepository,
    startAttempts: startAttemptRepository,
    teams: teamRepository,
    agents: agentRepository,
    threads: new PlanThreadRepository(db),
    comments: new PlanCommentRepository(db),
    now: () => NOW,
  })
  let output: unknown = options.output ?? {
    assignments: [
      { taskKey: 'fe', agentId: 'agt-a', reason: 'frontend match' },
      { taskKey: 'be', agentId: 'agt-b', reason: 'backend match' },
    ],
  }
  const startSystemCalls: { params: unknown; options: unknown }[] = []
  const dispatchService = new TeamDispatchService({
    db,
    plans: planRepository,
    versions: versionRepository,
    teams: teamRepository,
    agents: agentRepository,
    dispatches: dispatchRepository,
    startAttempts: startAttemptRepository,
    assignments,
    executions: {
      startSystem: async (params, systemOptions) => {
        startSystemCalls.push({ params, options: systemOptions })
        return execution()
      },
      get: () => ({ ...execution('exe-leader'), status: 'succeeded' }),
      list: () => [],
      cancel: async () => execution('exe-leader'),
    },
    providers: { list: () => [provider(options.toolControl ?? 'native')] },
    extractOutput: () => output as Record<string, unknown>,
    now: () => NOW,
  })
  dispatchService.ensureDispatches(plan, version)
  return {
    db,
    plan,
    version,
    team,
    teamRepository,
    assignmentRepository,
    dispatchRepository,
    assignments,
    dispatchService,
    startSystemCalls,
    setOutput: (next: unknown) => {
      output = next
    },
  }
}

describe('TeamDispatchService', () => {
  it('dispatches a whole team atomically and records leader assignments', async () => {
    const h = harness()
    const rows = await h.dispatchService.dispatch(h.plan.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      teamId: h.team.id,
      status: 'succeeded',
      attempt: 1,
      executionId: 'exe-leader',
    })
    const active = h.assignmentRepository.listActiveByVersion(h.version.id)
    expect(active.map((assignment) => [assignment.taskKey, assignment.agentId])).toEqual([
      ['be', 'agt-b'],
      ['fe', 'agt-a'],
    ])
    expect(active.every((assignment) => assignment.source === 'leader')).toBe(true)
    expect(h.startSystemCalls).toHaveLength(1)
    expect(h.startSystemCalls[0]?.options).toMatchObject({
      purpose: 'team_dispatch',
      toolPermissions: { version: 1, allow: [], deny: expect.arrayContaining(['Bash']) },
    })
  })

  it('fails closed when the team has no leader and writes no assignments', async () => {
    const h = harness({ withLeader: false })
    const rows = await h.dispatchService.dispatch(h.plan.id)
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'LEADER_NOT_SET' })
    expect(h.assignmentRepository.listActiveByVersion(h.version.id)).toEqual([])
  })

  it('rejects an incomplete leader result without partial assignment writes', async () => {
    const h = harness({
      output: { assignments: [{ taskKey: 'fe', agentId: 'agt-a', reason: 'only one' }] },
    })
    const rows = await h.dispatchService.dispatch(h.plan.id)
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'MISSING_TASK' })
    expect(h.assignmentRepository.listActiveByVersion(h.version.id)).toEqual([])
  })

  it('rejects the leader itself and non-members', async () => {
    const self = harness({
      output: {
        assignments: [
          { taskKey: 'fe', agentId: 'agt-leader', reason: 'self' },
          { taskKey: 'be', agentId: 'agt-b', reason: 'backend' },
        ],
      },
    })
    const rows = await self.dispatchService.dispatch(self.plan.id)
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'AGENT_NOT_MEMBER' })
    expect(self.assignmentRepository.listActiveByVersion(self.version.id)).toEqual([])

    const outsider = harness({
      output: {
        assignments: [
          { taskKey: 'fe', agentId: 'agt-out', reason: 'outsider' },
          { taskKey: 'be', agentId: 'agt-b', reason: 'backend' },
        ],
      },
    })
    const outsiderRows = await outsider.dispatchService.dispatch(outsider.plan.id)
    expect(outsiderRows[0]).toMatchObject({ status: 'failed', errorCode: 'AGENT_NOT_MEMBER' })
    expect(outsider.assignmentRepository.listActiveByVersion(outsider.version.id)).toEqual([])
  })

  it('requires native toolControl for the leader provider', async () => {
    const h = harness({ toolControl: 'emulated' })
    const rows = await h.dispatchService.dispatch(h.plan.id)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'LEADER_TOOL_CONTROL_UNSUPPORTED',
    })
    expect(h.startSystemCalls).toEqual([])
  })

  it('retries a failed dispatch and increments the attempt', async () => {
    const h = harness({ output: { assignments: [] } })
    const failed = await h.dispatchService.dispatch(h.plan.id)
    expect(failed[0]).toMatchObject({ status: 'failed', errorCode: 'MISSING_TASK', attempt: 1 })
    h.setOutput({
      assignments: [
        { taskKey: 'fe', agentId: 'agt-a', reason: 'frontend' },
        { taskKey: 'be', agentId: 'agt-b', reason: 'backend' },
      ],
    })
    const retried = await h.dispatchService.dispatch(h.plan.id)
    expect(retried[0]).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(h.assignmentRepository.listActiveByVersion(h.version.id)).toHaveLength(2)
  })

  it('lets the boss reassign an already-dispatched task and keeps history', async () => {
    const h = harness()
    await h.dispatchService.dispatch(h.plan.id)
    const result = h.assignments.assignTask({
      plan: h.plan,
      version: h.version,
      taskKey: 'fe',
      agentId: 'agt-b',
      reason: 'boss prefers B',
      decidedBy: 'boss',
    })
    expect(result).toMatchObject({ taskKey: 'fe', agentId: 'agt-b', source: 'user' })
    const all = h.assignmentRepository.listByVersion(h.version.id)
    expect(all.filter((assignment) => assignment.taskKey === 'fe')).toEqual([
      expect.objectContaining({ agentId: 'agt-a', status: 'superseded', source: 'leader' }),
      expect.objectContaining({ agentId: 'agt-b', status: 'active', source: 'user' }),
    ])
  })

  it('rejects boss reassignment while a team dispatch is running', async () => {
    const h = harness()
    const row = h.dispatchRepository.listByVersion(h.version.id)[0]
    expect(row).toBeDefined()
    if (!row) throw new Error('dispatch row missing')
    expect(h.dispatchRepository.claim(row.id, 'agt-leader', NOW)).toBe(true)
    expect(() =>
      h.assignments.assignTask({
        plan: h.plan,
        version: h.version,
        taskKey: 'fe',
        agentId: 'agt-a',
        reason: 'too early',
        decidedBy: 'boss',
      }),
    ).toThrow(PlanAssignmentError)
  })

  it('fails a running dispatch closed on Core recovery instead of auto-retrying', async () => {
    const h = harness()
    const row = h.dispatchRepository.listByVersion(h.version.id)[0]
    if (!row) throw new Error('dispatch row missing')
    expect(h.dispatchRepository.claim(row.id, 'agt-leader', NOW)).toBe(true)
    await h.dispatchService.recoverRunningDispatches()
    expect(h.dispatchRepository.get(row.id)).toMatchObject({
      status: 'failed',
      errorCode: 'INTERRUPTED',
    })
    expect(h.assignmentRepository.listActiveByVersion(h.version.id)).toEqual([])
  })
})
