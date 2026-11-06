import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { WorkflowAssignmentError, WorkflowAssignmentResolver } from './assignment-resolver'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): { db: Database; resolver: WorkflowAssignmentResolver } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-assign-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const insertAgent = db.prepare(
    `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json,
       default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
       tool_permissions_json)
     VALUES (?, ?, 'dev', '', '', '[]', NULL, 1, 'active', ?, ?, NULL,
       '{"version":1,"allow":["Read"],"deny":[]}')`,
  )
  for (const id of ['agent-1', 'agent-2', 'agent-3']) insertAgent.run(id, id, NOW, NOW)
  return { db, resolver: new WorkflowAssignmentResolver(new AssignmentRepository(db)) }
}

function addAssignment(
  db: Database,
  id: string,
  agentId: string,
  role: string,
  status = 'active',
): void {
  db.prepare(
    `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
       concurrency_limit, context_ref, created_at, updated_at)
     VALUES (?, 'work-1', ?, NULL, ?, '', ?, NULL, NULL, ?, ?)`,
  ).run(id, agentId, role, status, NOW, NOW)
}

function taskNode(key: string, workRole: string, agentProfileId?: string): Record<string, unknown> {
  return {
    key,
    type: 'agent_task',
    label: '',
    position: { x: 0, y: 0 },
    config: {
      assignmentSelector: { workRole, ...(agentProfileId ? { agentProfileId } : {}) },
      taskPrompt: 'x',
    },
  }
}

describe('WorkflowAssignmentResolver', () => {
  it('resolves a unique active assignment by workRole', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      const assignment = resolver.resolveForNode('work-1', taskNode('task_1', 'dev') as never)
      expect(assignment.agentId).toBe('agent-1')
    } finally {
      db.close()
    }
  })

  it('reports assignment_unresolved when nothing matches', () => {
    const { db, resolver } = setup()
    try {
      try {
        resolver.resolveForNode('work-1', taskNode('task_1', 'dev') as never)
        throw new Error('expected an assignment error')
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowAssignmentError)
        expect((error as WorkflowAssignmentError).code).toBe('assignment_unresolved')
      }
    } finally {
      db.close()
    }
  })

  it('reports assignment_ambiguous with candidates when multiple assignments match', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      addAssignment(db, 'as-2', 'agent-2', 'dev')
      try {
        resolver.resolveForNode('work-1', taskNode('task_1', 'dev') as never)
        throw new Error('expected an assignment error')
      } catch (error) {
        const typed = error as WorkflowAssignmentError
        expect(typed.code).toBe('assignment_ambiguous')
        expect(typed.candidates.sort()).toEqual(['agent-1', 'agent-2'])
      }
    } finally {
      db.close()
    }
  })

  it('disambiguates with agentProfileId', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      addAssignment(db, 'as-2', 'agent-2', 'dev')
      const assignment = resolver.resolveForNode(
        'work-1',
        taskNode('task_1', 'dev', 'agent-2') as never,
      )
      expect(assignment.agentId).toBe('agent-2')
    } finally {
      db.close()
    }
  })

  it('reports assignment_inactive when the only match is paused', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev', 'paused')
      try {
        resolver.resolveForNode('work-1', taskNode('task_1', 'dev') as never)
        throw new Error('expected an assignment error')
      } catch (error) {
        expect((error as WorkflowAssignmentError).code).toBe('assignment_inactive')
      }
    } finally {
      db.close()
    }
  })

  it('prechecks every agent_task node and fails fast', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      const definition = {
        schemaVersion: 1,
        nodes: [taskNode('task_1', 'dev'), taskNode('task_2', 'qa')],
        edges: [],
        settings: {
          defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
          reworkPolicy: { maxRounds: 2 },
          failureStrategy: 'fail_branch',
          concurrency: { maxParallelNodes: 4 },
        },
      } as unknown as WorkflowDefinition
      try {
        resolver.precheck('work-1', definition)
        throw new Error('expected an assignment error')
      } catch (error) {
        expect((error as WorkflowAssignmentError).nodeKey).toBe('task_2')
      }
    } finally {
      db.close()
    }
  })
})

describe('WorkflowAssignmentResolver · 显式改派', () => {
  it('resolves the override agent when it has an active same-role assignment', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      addAssignment(db, 'as-2', 'agent-2', 'dev')
      const node = taskNode('task_1', 'dev', 'agent-1') as never
      expect(resolver.resolveForNode('work-1', node).agentId).toBe('agent-1')
      expect(resolver.resolveForNode('work-1', node, 'agent-2').agentId).toBe('agent-2')
    } finally {
      db.close()
    }
  })

  it('fails closed when the override agent has no active assignment', () => {
    const { db, resolver } = setup()
    try {
      addAssignment(db, 'as-1', 'agent-1', 'dev')
      addAssignment(db, 'as-2', 'agent-2', 'dev', 'paused')
      const node = taskNode('task_1', 'dev', 'agent-1') as never
      expect(() => resolver.resolveForNode('work-1', node, 'agent-2')).toThrow(
        /no active assignment for reassigned agent/,
      )
    } finally {
      db.close()
    }
  })
})
