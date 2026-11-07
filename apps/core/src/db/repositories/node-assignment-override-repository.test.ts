import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowDefinitionService } from '../../services/workflow-definition-service'
import { WorkflowAssignmentResolver } from '../../workflow/assignment-resolver'
import { PublishedDefinitionProvider } from '../../workflow/published-definition-provider'
import { WorkflowRunService } from '../../workflow/run-service'
import { openDatabase } from '../database'
import { migrate } from '../migrations'
import { AssignmentRepository } from './assignment-repository'
import { BranchRunRepository } from './branch-run-repository'
import { NodeAssignmentOverrideRepository } from './node-assignment-override-repository'
import { NodeRunRepository } from './node-run-repository'
import { WorkRepository } from './work-repository'
import { WorkflowRepository } from './workflow-repository'
import { WorkflowRunRepository } from './workflow-run-repository'

const NOW = '2026-11-06T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function definition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task_1',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 1 },
        config: {
          assignmentSelector: { workRole: 'dev', agentProfileId: 'agent-1' },
          taskPrompt: 'do it',
        },
      },
      { key: 'end', type: 'end', label: '', position: { x: 0, y: 2 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'end' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

describe('NodeAssignmentOverrideRepository', () => {
  it('upserts one override per run/node and preserves created_at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-assignment-override-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    migrate(db)
    db.prepare(
      `INSERT INTO works (id, name, description, objective, status, priority, root_path,
         repository_path, settings_json, created_at, updated_at, completed_at)
       VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
    ).run(NOW, NOW)
    const insertAgent = db.prepare(
      `INSERT INTO agent_profiles (id, name, avatar, description, system_prompt, skill_ids_json,
         access_mode, system_kind, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
         tool_permissions_json)
       VALUES (?, ?, '🤖', '', '', '[]', 'edit', NULL, NULL, 1, 'active', ?, ?, NULL,
         '{"version":1,"allow":["Read"],"deny":[]}')`,
    )
    for (const id of ['agent-1', 'agent-2']) insertAgent.run(id, id, NOW, NOW)
    db.prepare(
      `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
         concurrency_limit, context_ref, created_at, updated_at)
       VALUES ('as-1', 'work-1', 'agent-1', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
    ).run(NOW, NOW)
    db.prepare(
      `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
         concurrency_limit, context_ref, created_at, updated_at)
       VALUES ('as-2', 'work-1', 'agent-2', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
    ).run(NOW, NOW)

    const workRepo = new WorkRepository(db)
    const assignmentRepo = new AssignmentRepository(db)
    const workflowRepo = new WorkflowRepository(db)
    const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
    const template = definitionService.createTemplate({ name: 't' })
    const draft = definitionService.createDraft(template.id, definition())
    definitionService.publish(draft.id)
    const runService = new WorkflowRunService(
      db,
      new WorkflowRunRepository(db),
      new BranchRunRepository(db),
      new NodeRunRepository(db),
      workRepo,
      new PublishedDefinitionProvider(workflowRepo),
      new WorkflowAssignmentResolver(assignmentRepo),
      () => NOW,
    )
    const run = runService.createRun({ workId: 'work-1', workflowVersionId: draft.id })

    const overrides = new NodeAssignmentOverrideRepository(db)
    overrides.upsert({
      id: 'nao-1',
      workflowRunId: run.id,
      workflowNodeKey: 'task_1',
      agentId: 'agent-1',
      assignedBy: 'boss',
      createdAt: NOW,
      updatedAt: NOW,
    })
    overrides.upsert({
      id: 'nao-2',
      workflowRunId: run.id,
      workflowNodeKey: 'task_1',
      agentId: 'agent-2',
      assignedBy: 'boss-2',
      createdAt: '2026-11-06T01:00:00.000Z',
      updatedAt: '2026-11-06T01:00:00.000Z',
    })

    expect(overrides.listByRun(run.id)).toEqual([
      {
        id: 'nao-1',
        workflowRunId: run.id,
        workflowNodeKey: 'task_1',
        agentId: 'agent-2',
        assignedBy: 'boss-2',
        createdAt: NOW,
        updatedAt: '2026-11-06T01:00:00.000Z',
      },
    ])
    expect(overrides.get(run.id, 'task_1')?.agentId).toBe('agent-2')
    expect(overrides.get(run.id, 'missing')).toBeNull()
    db.close()
  })
})
