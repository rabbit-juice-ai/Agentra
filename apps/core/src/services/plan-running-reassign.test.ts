import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlanDraft, type PlanRecord, type PlanVersion } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
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
import { AssignmentService } from './assignment-service'
import { PlanAssignmentService } from './plan-assignment-service'
import { PlanService } from './plan-service'
import { TeamService } from './team-service'

const NOW = '2026-11-07T04:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('PlanService running team reassign', () => {
  it('creates a same-workRole Assignment for a team member who has none yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-team-reassign-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    migrate(db)
    for (const id of ['agt-current', 'agt-target']) {
      db.prepare(
        `INSERT INTO agent_profiles (
          id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
          model, tool_permissions_json, default_provider_id, max_concurrency, status,
          created_at, updated_at, archived_at
        ) VALUES (?, ?, '🤖', '', '', '[]', 'edit', NULL, NULL,
          '{"version":1,"allow":["Read"],"deny":[]}', NULL, 5, 'active', ?, ?, NULL)`,
      ).run(id, id, NOW, NOW)
    }
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
    const teamService = new TeamService(db, teamRepository, agentRepository, () => NOW)
    const team = teamService.create({ name: 'Delivery' })
    teamService.addMember(team.id, 'agt-current')
    teamService.addMember(team.id, 'agt-target')
    const assignmentService = new AssignmentService(
      db,
      assignmentRepository,
      workRepository,
      agentRepository,
      teamRepository,
      new SessionRepository(db),
      () => NOW,
    )
    assignmentService.create({
      workId: 'work-1',
      agentId: 'agt-current',
      workRole: 'dev',
      teamId: team.id,
    })

    const planRepository = new PlanRepository(db)
    const versionRepository = new PlanVersionRepository(db)
    const threadRepository = new PlanThreadRepository(db)
    const commentRepository = new PlanCommentRepository(db)
    const planAssignmentRepository = new PlanTaskAssignmentRepository(db)
    const dispatchRepository = new PlanDispatchRepository(db)
    const attemptRepository = new PlanStartAttemptRepository(db)
    const plan: PlanRecord = {
      id: 'plan-1',
      workId: 'work-1',
      goal: 'run team task',
      status: 'running',
      currentVersion: 1,
      workflowVersionId: 'wfv-1',
      workflowRunId: 'run-1',
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
      approvedBy: 'boss',
    }
    const planDraft = PlanDraft.parse({
      agentraPlanVersion: 1,
      goal: 'run team task',
      tasks: [
        {
          key: 'build',
          title: 'Build',
          description: 'build',
          responsibilityRole: 'frontend',
          requiredAccessMode: 'edit',
          teamId: team.id,
        },
      ],
    })
    const version: PlanVersion = {
      id: 'plnv-1',
      planId: plan.id,
      version: 1,
      plan: planDraft,
      validation: {
        valid: true,
        violations: [],
        assignments: [{ taskKey: 'build', agentId: null, agentName: null }],
      },
      assignments: [{ taskKey: 'build', agentId: null, agentName: null }],
      checksum: 'checksum',
      status: 'running',
      source: 'planner',
      fallbackReason: null,
      createdAt: NOW,
      approvedAt: NOW,
      approvedBy: 'boss',
    }
    planRepository.create(plan)
    versionRepository.create(version)
    threadRepository.create({ id: 'pth-1', planId: plan.id, taskKey: 'build', createdAt: NOW })
    planAssignmentRepository.insert({
      id: 'pta-1',
      planId: plan.id,
      planVersionId: version.id,
      taskKey: 'build',
      teamId: team.id,
      agentId: 'agt-current',
      source: 'leader',
      assignedBy: 'leader',
      reason: 'initial',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const planAssignments = new PlanAssignmentService({
      db,
      assignments: planAssignmentRepository,
      dispatches: dispatchRepository,
      startAttempts: attemptRepository,
      teams: teamRepository,
      agents: agentRepository,
      threads: threadRepository,
      comments: commentRepository,
      now: () => NOW,
    })
    const overrides: { workflowRunId: string; workflowNodeKey: string; agentId: string }[] = []
    const service = new PlanService({
      db,
      plans: planRepository,
      versions: versionRepository,
      threads: threadRepository,
      comments: commentRepository,
      overrides: {
        upsert: (record: { workflowRunId: string; workflowNodeKey: string; agentId: string }) =>
          overrides.push(record),
        get: () => null,
        listByRun: () => [],
      } as never,
      rework: {} as never,
      reworks: {} as never,
      nodes: {} as never,
      workService: {} as never,
      projectService: {} as never,
      chatExecutions: {} as never,
      extractOutput: () => ({}),
      planner: {} as never,
      agents: agentRepository,
      assignments: assignmentService,
      planAssignments,
      dispatches: dispatchRepository,
      startAttempts: attemptRepository,
      startService: {} as never,
      dispatchService: {} as never,
      teams: teamRepository,
      works: workRepository,
      runs: {
        get: () => ({
          id: 'run-1',
          workId: 'work-1',
          workflowVersionId: 'wfv-1',
          status: 'running',
          startedAt: NOW,
          endedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      },
      engine: { kick: async () => {} },
      now: () => NOW,
    })

    const result = service.reassignTask({
      planId: plan.id,
      taskKey: 'build',
      agentId: 'agt-target',
      decidedBy: 'boss',
      reason: 'target is closer to the module',
    })
    expect(result.agentName).toBe('agt-target')
    const targetAssignment = assignmentRepository.findByWorkAndAgent('work-1', 'agt-target')
    expect(targetAssignment).toMatchObject({ workRole: 'dev', status: 'active', teamId: team.id })
    expect(overrides).toEqual([
      expect.objectContaining({
        workflowRunId: 'run-1',
        workflowNodeKey: 'build',
        agentId: 'agt-target',
      }),
    ])
    const comments = commentRepository.listByThread('pth-1')
    expect(comments.some((comment) => comment.content.includes('target is closer'))).toBe(true)
  })
})
