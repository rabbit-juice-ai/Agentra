import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { WorkflowAssignmentError, WorkflowAssignmentResolver } from './assignment-resolver'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowRunCreationError, WorkflowRunService } from './run-service'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function definition(
  options: { role?: string; policy?: 'work_root' | 'worktree' } = {},
): WorkflowDefinition {
  const role = options.role ?? 'dev'
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
          assignmentSelector: { workRole: role },
          taskPrompt: 'x',
          ...(options.policy ? { workingDirectoryPolicy: options.policy } : {}),
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

function parallelDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      { key: 'split_1', type: 'parallel_split', label: '', position: { x: 0, y: 1 }, config: {} },
      {
        key: 'ui',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 2 },
        config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'ui' },
      },
      {
        key: 'api',
        type: 'agent_task',
        label: '',
        position: { x: 1, y: 2 },
        config: { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'api' },
      },
      {
        key: 'join',
        type: 'join',
        label: '',
        position: { x: 0, y: 3 },
        config: { pairWith: 'split_1' },
      },
      { key: 'end', type: 'end', label: '', position: { x: 0, y: 4 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'ui', branchKey: 'ui' },
      { key: 'e3', source: 'split_1', target: 'api', branchKey: 'api' },
      { key: 'e4', source: 'ui', target: 'join' },
      { key: 'e5', source: 'api', target: 'join' },
      { key: 'e6', source: 'join', target: 'end' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

function setup(options: { repositoryPath?: string | null } = {}): {
  db: Database
  service: WorkflowRunService
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  createVersion: (definition: WorkflowDefinition) => string
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-run-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', ?, '{}', ?, ?, NULL)`,
  ).run(options.repositoryPath ?? null, NOW, NOW)
  const insertAgent = db.prepare(
    `INSERT INTO agent_profiles (id, name, role, description, system_prompt, skills_json,
       default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
       tool_permissions_json)
     VALUES (?, ?, 'dev', '', '', '[]', NULL, 1, 'active', ?, ?, NULL,
       '{"version":1,"allow":["Read"],"deny":[]}')`,
  )
  for (const id of ['agent-1', 'agent-2']) insertAgent.run(id, id, NOW, NOW)
  db.prepare(
    `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
       concurrency_limit, context_ref, created_at, updated_at)
     VALUES ('as-1', 'work-1', 'agent-1', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
  ).run(NOW, NOW)

  const repo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(repo)
  const definitionService = new WorkflowDefinitionService(db, repo, () => NOW)
  const template = definitionService.createTemplate({ name: 't' })
  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const service = new WorkflowRunService(
    db,
    runs,
    branches,
    nodes,
    new WorkRepository(db),
    definitions,
    new WorkflowAssignmentResolver(new AssignmentRepository(db)),
    () => NOW,
  )
  return {
    db,
    service,
    runs,
    branches,
    nodes,
    createVersion: (value) => {
      const draft = definitionService.createDraft(template.id, value)
      return definitionService.publish(draft.id).id
    },
    close: () => db.close(),
  }
}

function counts(db: Database): { runs: number; branches: number; nodes: number } {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  return { runs: count('workflow_runs'), branches: count('branch_runs'), nodes: count('node_runs') }
}

describe('WorkflowRunService', () => {
  it('persists request idempotency across service recreation and rejects key reuse', () => {
    const h = setup()
    try {
      const versionId = h.createVersion(definition())
      const request = {
        workId: 'work-1',
        workflowVersionId: versionId,
        requestId: '8d292af5-364d-4bee-96c3-aaebfdbeafde',
      }
      const first = h.service.createRun(request)
      expect(h.service.createRun(request).id).toBe(first.id)
      expect(counts(h.db)).toEqual({ runs: 1, branches: 1, nodes: 3 })
      expect(() => h.service.createRun({ ...request, workflowVersionId: 'missing' })).toThrow(
        /requestId/,
      )
    } finally {
      h.close()
    }
  })

  it('rejects a missing Work, unavailable Work and missing version without writes', () => {
    const h = setup()
    try {
      const versionId = h.createVersion(definition())
      expect(() =>
        h.service.createRun({ workId: 'missing', workflowVersionId: versionId }),
      ).toThrow(/work not found/)
      expect(() => h.service.createRun({ workId: 'work-1', workflowVersionId: 'missing' })).toThrow(
        /not found/,
      )
      h.db.prepare("UPDATE works SET status='cancelled' WHERE id='work-1'").run()
      expect(() => h.service.createRun({ workId: 'work-1', workflowVersionId: versionId })).toThrow(
        /cannot create/,
      )
      expect(counts(h.db)).toEqual({ runs: 0, branches: 0, nodes: 0 })
    } finally {
      h.close()
    }
  })
  it('creates the run, root branch and a blocked NodeRun per node', () => {
    const h = setup()
    try {
      const versionId = h.createVersion(definition())
      const run = h.service.createRun({ workId: 'work-1', workflowVersionId: versionId })
      expect(run.status).toBe('running')
      expect(run.startedAt).toBe(NOW)
      expect(counts(h.db)).toEqual({ runs: 1, branches: 1, nodes: 3 })
      expect(h.branches.listByRun(run.id)[0]?.branchKey).toBe('root')
      expect(h.nodes.listByRun(run.id).every((node) => node.status === 'blocked')).toBe(true)
    } finally {
      h.close()
    }
  })

  it('links every NodeRun to the BranchRun of its parallel region', () => {
    const h = setup()
    try {
      const versionId = h.createVersion(parallelDefinition())
      const run = h.service.createRun({ workId: 'work-1', workflowVersionId: versionId })
      const branches = new Map(
        h.branches.listByRun(run.id).map((branch) => [branch.branchKey, branch.id]),
      )
      const nodeBranches = new Map(
        h.nodes.listByRun(run.id).map((node) => [node.workflowNodeKey, node.branchRunId]),
      )
      expect(nodeBranches.get('ui')).toBe(branches.get('split_1/ui'))
      expect(nodeBranches.get('api')).toBe(branches.get('split_1/api'))
      expect(nodeBranches.get('join')).toBe(branches.get('root'))
      expect(nodeBranches.get('end')).toBe(branches.get('root'))
    } finally {
      h.close()
    }
  })

  it('fails before any write when an assignment cannot be resolved', () => {
    const h = setup()
    try {
      const versionId = h.createVersion(definition({ role: 'ghost' }))
      expect(() => h.service.createRun({ workId: 'work-1', workflowVersionId: versionId })).toThrow(
        WorkflowAssignmentError,
      )
      expect(counts(h.db)).toEqual({ runs: 0, branches: 0, nodes: 0 })
    } finally {
      h.close()
    }
  })

  it('rejects worktree policy when the work has no repository_path, before any write', () => {
    const h = setup({ repositoryPath: null })
    try {
      const versionId = h.createVersion(definition({ policy: 'worktree' }))
      expect(() => h.service.createRun({ workId: 'work-1', workflowVersionId: versionId })).toThrow(
        WorkflowRunCreationError,
      )
      expect(counts(h.db)).toEqual({ runs: 0, branches: 0, nodes: 0 })
    } finally {
      h.close()
    }
  })
})
