import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type AgentProfile,
  type PlanDraft,
  PlanDraft as PlanDraftSchema,
  type PlanRecord,
  type PlanVersion,
  type WorkflowRun,
} from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, transaction } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
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
import { SessionRepository } from '../db/repositories/session-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { AssignmentService } from './assignment-service'
import { PlanAssignmentService } from './plan-assignment-service'
import { PlanStartService } from './plan-start-service'
import { TeamService } from './team-service'

const NOW = '2026-11-07T02:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function agent(id: string, accessMode: AgentProfile['accessMode']): AgentProfile {
  return {
    id,
    name: id,
    avatar: '🤖',
    description: '',
    systemPrompt: '',
    skillIds: [],
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: null,
    maxConcurrency: 5,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }
}

function insertAgent(db: ReturnType<typeof openDatabase>, profile: AgentProfile): void {
  db.prepare(
    `INSERT INTO agent_profiles (
      id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
      model, tool_permissions_json, default_provider_id, max_concurrency, status,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, '[]', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    profile.id,
    profile.name,
    profile.avatar,
    profile.description,
    profile.systemPrompt,
    profile.accessMode,
    JSON.stringify(profile.toolPermissions),
    profile.maxConcurrency,
    profile.status,
    profile.createdAt,
    profile.updatedAt,
  )
}

function planDraft(teamId: string | null): PlanDraft {
  return PlanDraftSchema.parse({
    agentraPlanVersion: 1,
    goal: 'start a plan',
    tasks: [
      {
        key: 'build',
        title: 'Build',
        description: 'build it',
        responsibilityRole: 'frontend',
        requiredAccessMode: 'edit',
        teamId,
        suggestedAgentId: teamId === null ? 'agt-edit' : null,
        outputs: ['code'],
      },
    ],
  })
}

function harness(options: { teamTask?: boolean; legacy?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-plan-start-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const editor = agent('agt-edit', 'edit')
  const leader = agent('agt-leader', 'analyze')
  insertAgent(db, editor)
  insertAgent(db, leader)
  db.prepare(
    `INSERT INTO works (
      id, name, description, objective, status, priority, root_path, repository_path,
      settings_json, created_at, updated_at, completed_at
    ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const agentRepository = new AgentRepository(db)
  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const sessionRepository = new SessionRepository(db)
  const assignmentService = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    sessionRepository,
    () => NOW,
  )
  const teamService = new TeamService(db, teamRepository, agentRepository, () => NOW)
  const team = teamService.create({ name: 'Delivery' })
  teamService.addMember(team.id, 'agt-edit')
  teamService.addMember(team.id, 'agt-leader')
  teamService.update(team.id, { leaderAgentId: 'agt-leader' })

  const planRepository = new PlanRepository(db)
  const versionRepository = new PlanVersionRepository(db)
  const planThreadRepository = new PlanThreadRepository(db)
  const planCommentRepository = new PlanCommentRepository(db)
  const assignmentPlanRepository = new PlanTaskAssignmentRepository(db)
  const dispatchRepository = new PlanDispatchRepository(db)
  const attemptRepository = new PlanStartAttemptRepository(db)
  const plan: PlanRecord = {
    id: 'plan-1',
    workId: 'work-1',
    goal: 'start a plan',
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
    plan: planDraft(options.teamTask ? team.id : null),
    validation: {
      valid: true,
      violations: [],
      assignments: options.teamTask
        ? [{ taskKey: 'build', agentId: null, agentName: null }]
        : [{ taskKey: 'build', agentId: 'agt-edit', agentName: 'agt-edit' }],
    },
    assignments: options.teamTask
      ? [{ taskKey: 'build', agentId: null, agentName: null }]
      : [{ taskKey: 'build', agentId: 'agt-edit', agentName: 'agt-edit' }],
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
  const planAssignments = new PlanAssignmentService({
    db,
    assignments: assignmentPlanRepository,
    dispatches: dispatchRepository,
    startAttempts: attemptRepository,
    teams: teamRepository,
    agents: agentRepository,
    threads: planThreadRepository,
    comments: planCommentRepository,
    now: () => NOW,
  })
  if (!options.legacy) {
    transaction(db, () => {
      if (options.teamTask) {
        assignmentPlanRepository.insert({
          id: 'pta-1',
          planId: plan.id,
          planVersionId: version.id,
          taskKey: 'build',
          teamId: team.id,
          agentId: 'agt-edit',
          source: 'leader',
          assignedBy: 'agt-leader',
          reason: 'leader chose',
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        })
      } else {
        planAssignments.seedPersonalAssignmentsInTransaction(plan, version, 'planner', NOW)
      }
    })
  }
  const runs = new Map<string, WorkflowRun>()
  let versionCreates = 0
  let runCreates = 0
  let kicks = 0
  let failRunCreate = false
  let failWorkflowCreate = false
  let capturedDefinition: unknown = null
  const workflowService = {
    createPublishedVersionInTransaction: (input: { definition: unknown }) => {
      versionCreates += 1
      if (failWorkflowCreate) throw new Error('workflow create failed')
      capturedDefinition = input.definition
      return { id: 'wfv-1' }
    },
  }
  const runService = {
    createRunInTransaction: () => {
      runCreates += 1
      if (failRunCreate) throw new Error('run create failed')
      const run: WorkflowRun = {
        id: 'run-1',
        workId: 'work-1',
        workflowVersionId: 'wfv-1',
        status: 'running',
        startedAt: NOW,
        endedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }
      runs.set(run.id, run)
      return run
    },
  }
  const service = new PlanStartService({
    db,
    plans: planRepository,
    versions: versionRepository,
    assignments: planAssignments,
    startAttempts: attemptRepository,
    dispatches: dispatchRepository,
    workAssignments: assignmentService,
    works: workRepository,
    workflows: workflowService as never,
    runs: { get: (id: string) => (runs.get(id) ?? null) as never },
    runService: runService as never,
    engine: {
      kick: async () => {
        kicks += 1
      },
    },
    threads: planThreadRepository,
    comments: planCommentRepository,
    now: () => NOW,
  })
  return {
    db,
    service,
    plan,
    version,
    team,
    planRepository,
    versionRepository,
    assignmentPlanRepository,
    dispatchRepository,
    attemptRepository,
    assignmentRepository,
    teamRepository,
    failRunCreate: () => {
      failRunCreate = true
    },
    failWorkflowCreate: () => {
      failWorkflowCreate = true
    },
    counts: () => ({ versionCreates, runCreates, kicks }),
    definition: () => capturedDefinition,
    runs,
  }
}

describe('PlanStartService', () => {
  it('claims, snapshots, creates assignments/version/run atomically and kicks once', async () => {
    const h = harness()
    const started = await h.service.startRun(h.plan.id, '11111111-2222-4333-8444-555555555555')
    expect(started.plan.status).toBe('running')
    expect(started.plan.workflowRunId).toBe('run-1')
    expect(started.schedulingError).toBeNull()
    expect(h.counts()).toEqual({ versionCreates: 1, runCreates: 1, kicks: 1 })
    const attempts = h.attemptRepository.listByPlan(h.plan.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      status: 'running',
      workflowVersionId: 'wfv-1',
      workflowRunId: 'run-1',
    })
    const attempt = attempts[0]
    if (!attempt) throw new Error('start attempt missing')
    expect(JSON.parse(attempt.assignmentSnapshotJson)).toEqual([
      expect.objectContaining({
        taskKey: 'build',
        agentId: 'agt-edit',
        workRole: 'plan-agt-edit',
      }),
    ])
    expect(h.assignmentRepository.findByWorkAndAgent('work-1', 'agt-edit')).toMatchObject({
      status: 'active',
      workRole: 'plan-agt-edit',
    })
  })

  it('reuses the same run on retry instead of creating a second version/run', async () => {
    const h = harness()
    const first = await h.service.startRun(h.plan.id, '11111111-2222-4333-8444-555555555555')
    const second = await h.service.startRun(h.plan.id, '11111111-2222-4333-8444-555555555556')
    expect(second.run.id).toBe(first.run.id)
    expect(h.counts()).toEqual({ versionCreates: 1, runCreates: 1, kicks: 2 })
  })

  it('rolls back all writes when run creation fails and leaves plan approved', async () => {
    const h = harness()
    h.failRunCreate()
    await expect(h.service.startRun(h.plan.id)).rejects.toMatchObject({
      code: 'RUN_CREATE_FAILED',
    })
    expect(h.planRepository.get(h.plan.id)?.status).toBe('approved')
    expect(h.planRepository.get(h.plan.id)?.workflowRunId).toBeNull()
    expect(h.attemptRepository.listByPlan(h.plan.id)).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'RUN_CREATE_FAILED' }),
    ])
    expect(h.assignmentRepository.listByWork('work-1')).toEqual([])
  })

  it('rejects start when team tasks are not assigned, without creating an attempt', async () => {
    const h = harness({ teamTask: true, legacy: true })
    await expect(h.service.startRun(h.plan.id)).rejects.toMatchObject({
      code: 'PLAN_NOT_READY',
    })
    expect(h.attemptRepository.listByPlan(h.plan.id)).toEqual([])
    expect(h.counts()).toEqual({ versionCreates: 0, runCreates: 0, kicks: 0 })
  })

  it('rejects start while a team dispatch is running', async () => {
    const h = harness({ teamTask: true })
    h.dispatchRepository.insert({
      id: 'pdp-1',
      planId: h.plan.id,
      planVersionId: h.version.id,
      teamId: h.team.id,
      leaderAgentId: 'agt-leader',
      status: 'running',
      attempt: 1,
      executionId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: NOW,
      endedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await expect(h.service.startRun(h.plan.id)).rejects.toMatchObject({
      code: 'DISPATCH_IN_PROGRESS',
    })
    expect(h.attemptRepository.listByPlan(h.plan.id)).toEqual([])
  })

  it('seeds legacy personal assignments from version.assignments and starts', async () => {
    const h = harness({ legacy: true })
    await h.service.startRun(h.plan.id)
    const active = h.assignmentPlanRepository.listActiveByVersion(h.version.id)
    expect(active).toEqual([
      expect.objectContaining({ taskKey: 'build', agentId: 'agt-edit', source: 'legacy' }),
    ])
    expect(h.counts()).toEqual({ versionCreates: 1, runCreates: 1, kicks: 1 })
  })

  it('reuses an existing Work Assignment role for the compiled node', async () => {
    const h = harness()
    h.assignmentRepository.insert({
      id: 'asg-existing',
      workId: 'work-1',
      agentId: 'agt-edit',
      teamId: null,
      workRole: 'dev',
      taskScope: '',
      status: 'active',
      concurrencyLimit: null,
      contextRef: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await h.service.startRun(h.plan.id)
    expect(JSON.stringify(h.definition())).toContain('"workRole":"dev"')
    expect(h.assignmentRepository.listByWork('work-1')).toHaveLength(1)
  })

  it('starts a team plan only after its active assignment exists', async () => {
    const h = harness({ teamTask: true })
    const started = await h.service.startRun(h.plan.id)
    expect(started.run.id).toBe('run-1')
    expect(h.assignmentPlanRepository.listActiveByVersion(h.version.id)).toHaveLength(1)
  })

  it('fails stale preparing attempts on recovery and allows a fresh start', async () => {
    const h = harness()
    h.attemptRepository.insert({
      id: 'psa-stale',
      planId: h.plan.id,
      planVersionId: h.version.id,
      requestId: '11111111-2222-4333-8444-555555555555',
      status: 'preparing',
      assignmentSnapshotJson: '[]',
      planChecksum: 'checksum',
      workflowVersionId: null,
      workflowRunId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await h.service.recoverStaleAttempts()
    expect(h.attemptRepository.get('psa-stale')).toMatchObject({
      status: 'failed',
      errorCode: 'INTERRUPTED',
    })
    await expect(h.service.startRun(h.plan.id)).resolves.toMatchObject({
      run: { id: 'run-1' },
    })
  })
})
