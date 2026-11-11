import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlanDraft } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrations'
import {
  PlanDispatchRepository,
  PlanStartAttemptRepository,
  PlanTaskAssignmentRepository,
} from './plan-dispatch-repository'

const NOW = '2026-11-07T03:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-plan-dispatch-db-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (
      id, name, description, objective, status, priority, root_path, repository_path,
      settings_json, created_at, updated_at, completed_at
    ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  for (const [id, accessMode] of [
    ['agt-a', 'edit'],
    ['agt-b', 'edit'],
  ] as const) {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
        model, tool_permissions_json, default_provider_id, max_concurrency, status,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, '🤖', '', '', '[]', ?, NULL, NULL,
        '{"version":1,"allow":["Read"],"deny":[]}', NULL, 5, 'active', ?, ?, NULL)`,
    ).run(id, id, accessMode, NOW, NOW)
  }
  db.prepare(
    `INSERT INTO teams (id, name, description, instructions, settings_json, status, created_at, updated_at, archived_at)
     VALUES ('team-1', 'Team', '', '', '{}', 'active', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO plans (
      id, work_id, goal, status, current_version, workflow_version_id, workflow_run_id,
      created_at, updated_at, approved_at, approved_by
    ) VALUES ('plan-1', 'work-1', 'goal', 'approved', 1, NULL, NULL, ?, ?, ?, 'boss')`,
  ).run(NOW, NOW, NOW)
  const plan = PlanDraft.parse({
    agentraPlanVersion: 1,
    goal: 'goal',
    tasks: [
      {
        key: 'build',
        title: 'Build',
        description: 'build',
        responsibilityRole: 'frontend',
        requiredAccessMode: 'edit',
        teamId: 'team-1',
      },
    ],
  })
  db.prepare(
    `INSERT INTO plan_versions (
      id, plan_id, version, plan_json, validation_json, assignments_json, checksum, status,
      source, fallback_reason, created_at, approved_at, approved_by
    ) VALUES ('plnv-1', 'plan-1', 1, ?, ?, '[]', 'checksum', 'approved', 'planner', NULL, ?, ?, 'boss')`,
  ).run(
    JSON.stringify(plan),
    JSON.stringify({ valid: true, violations: [], assignments: [] }),
    NOW,
    NOW,
  )
  return { db, plan }
}

describe('plan dispatch repositories', () => {
  it('enforces one active assignment per plan version + task and supports supersede', () => {
    const h = harness()
    const assignments = new PlanTaskAssignmentRepository(h.db)
    const base = {
      planId: 'plan-1',
      planVersionId: 'plnv-1',
      taskKey: 'build',
      teamId: 'team-1',
      agentId: 'agt-a',
      source: 'leader' as const,
      assignedBy: 'agt-leader',
      reason: null,
      status: 'active' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }
    assignments.insert({ ...base, id: 'pta-1' })
    expect(() => assignments.insert({ ...base, id: 'pta-2', agentId: 'agt-b' })).toThrow(
      /UNIQUE constraint failed/,
    )
    expect(assignments.supersedeActive('plnv-1', 'build', NOW)).toBe(true)
    assignments.insert({ ...base, id: 'pta-2', agentId: 'agt-b', source: 'user' })
    expect(assignments.listByVersion('plnv-1').map((item) => [item.id, item.status])).toEqual([
      ['pta-1', 'superseded'],
      ['pta-2', 'active'],
    ])
  })

  it('allows only one active start attempt and frees it on failure', () => {
    const h = harness()
    const attempts = new PlanStartAttemptRepository(h.db)
    const base = {
      planId: 'plan-1',
      planVersionId: 'plnv-1',
      status: 'preparing' as const,
      assignmentSnapshotJson: '[]',
      planChecksum: 'checksum',
      workflowVersionId: null,
      workflowRunId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    attempts.insert({ ...base, id: 'psa-1', requestId: 'req-1' })
    expect(() => attempts.insert({ ...base, id: 'psa-2', requestId: 'req-2' })).toThrow(
      /UNIQUE constraint failed/,
    )
    expect(attempts.markFailed('psa-1', 'INTERRUPTED', 'gone', NOW)).toBe(true)
    expect(() => attempts.insert({ ...base, id: 'psa-2', requestId: 'req-2' })).not.toThrow()
  })

  it('enforces one dispatch row per plan version + team and CAS claim/retry', () => {
    const h = harness()
    const dispatches = new PlanDispatchRepository(h.db)
    const base = {
      planId: 'plan-1',
      planVersionId: 'plnv-1',
      teamId: 'team-1',
      leaderAgentId: 'agt-a',
      status: 'pending' as const,
      attempt: 1,
      executionId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    dispatches.insert({ ...base, id: 'pdp-1' })
    expect(() => dispatches.insert({ ...base, id: 'pdp-2' })).toThrow(/UNIQUE constraint failed/)
    expect(dispatches.claim('pdp-1', 'agt-a', NOW)).toBe(true)
    expect(dispatches.claim('pdp-1', 'agt-a', NOW)).toBe(false)
    expect(dispatches.markFailed('pdp-1', 'MISSING_TASK', 'missing', NOW)).toBe(true)
    expect(dispatches.claim('pdp-1', 'agt-a', NOW)).toBe(true)
    expect(dispatches.get('pdp-1')?.attempt).toBe(2)
  })
})
