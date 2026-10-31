import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { IllegalWorkflowTransitionError } from './state-machine'
import type { NodeFailure } from './types'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): {
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-wf-repo-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES ('wft-1', 'T', '', '', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_versions (
       id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at
     ) VALUES ('wfv-1', 'wft-1', 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'sum', 'published', ?, ?)`,
  ).run(NOW, NOW)
  return {
    runs: new WorkflowRunRepository(db),
    branches: new BranchRunRepository(db),
    nodes: new NodeRunRepository(db),
    close: () => db.close(),
  }
}

describe('WorkflowRunRepository', () => {
  it('creates a run and performs CAS transitions', () => {
    const { runs, close } = setup()
    try {
      const run = runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      expect(run.status).toBe('pending')
      expect(run.startedAt).toBeNull()

      expect(runs.transition('run-1', ['pending'], 'running', '2026-11-01T00:01:00.000Z')).toBe(
        true,
      )
      expect(runs.get('run-1')?.startedAt).toBe('2026-11-01T00:01:00.000Z')

      // 状态已被改走：同一 CAS 条件再执行必须失败
      expect(runs.transition('run-1', ['pending'], 'running', '2026-11-01T00:02:00.000Z')).toBe(
        false,
      )

      expect(runs.transition('run-1', ['running'], 'completed', '2026-11-01T00:03:00.000Z')).toBe(
        true,
      )
      const done = runs.get('run-1')
      expect(done?.status).toBe('completed')
      expect(done?.endedAt).toBe('2026-11-01T00:03:00.000Z')
      expect(runs.listUnfinished()).toEqual([])
    } finally {
      close()
    }
  })

  it('rejects transitions the state machine forbids', () => {
    const { runs, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      expect(() => runs.transition('run-1', ['pending'], 'completed', NOW)).toThrow(
        IllegalWorkflowTransitionError,
      )
    } finally {
      close()
    }
  })
})

describe('BranchRunRepository', () => {
  it('creates branches, pauses/resumes with metadata, and enforces uniqueness', () => {
    const { runs, branches, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      const branch = branches.create({ id: 'br-1', workflowRunId: 'run-1', branchKey: 'ui' }, NOW)
      expect(branch.status).toBe('active')
      expect(branches.getByKey('run-1', 'ui')?.id).toBe('br-1')

      expect(() =>
        branches.create({ id: 'br-2', workflowRunId: 'run-1', branchKey: 'ui' }, NOW),
      ).toThrow(/UNIQUE constraint failed/)

      expect(branches.pause('br-1', 'user_paused', '2026-11-01T00:05:00.000Z')).toBe(true)
      const paused = branches.get('br-1')
      expect(paused?.status).toBe('paused')
      expect(paused?.pauseReason).toBe('user_paused')
      expect(paused?.pausedAt).toBe('2026-11-01T00:05:00.000Z')

      expect(branches.resume('br-1', '2026-11-01T00:06:00.000Z')).toBe(true)
      const resumed = branches.get('br-1')
      expect(resumed?.status).toBe('active')
      expect(resumed?.resumedAt).toBe('2026-11-01T00:06:00.000Z')

      expect(branches.transition('br-1', ['active'], 'completed', NOW)).toBe(true)
    } finally {
      close()
    }
  })
})

describe('NodeRunRepository', () => {
  it('walks blocked → ready → running → succeeded with timestamps', () => {
    const { runs, nodes, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      nodes.create(
        {
          id: 'node-1',
          workflowRunId: 'run-1',
          workflowNodeKey: 'task_1',
          inputSnapshot: { a: 1 },
        },
        NOW,
      )
      expect(nodes.transition('node-1', ['blocked'], 'ready', NOW)).toBe(true)
      expect(nodes.transition('node-1', ['ready'], 'running', '2026-11-01T00:01:00.000Z')).toBe(
        true,
      )
      const running = nodes.get('node-1')
      expect(running?.startedAt).toBe('2026-11-01T00:01:00.000Z')

      // CAS：状态已变，旧的期望状态不再命中
      expect(nodes.transition('node-1', ['ready'], 'running', NOW)).toBe(false)

      expect(
        nodes.transition('node-1', ['running'], 'succeeded', '2026-11-01T00:02:00.000Z', {
          outputSnapshot: { pass: true },
        }),
      ).toBe(true)
      const done = nodes.get('node-1')
      expect(done?.status).toBe('succeeded')
      expect(done?.endedAt).toBe('2026-11-01T00:02:00.000Z')
      expect(done?.outputSnapshot).toEqual({ pass: true })
      expect(done?.inputSnapshot).toEqual({ a: 1 })
    } finally {
      close()
    }
  })

  it('fails a node with a structured error (category + nodeKey)', () => {
    const { runs, nodes, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      nodes.create({ id: 'node-1', workflowRunId: 'run-1', workflowNodeKey: 'task_1' }, NOW)
      nodes.transition('node-1', ['blocked'], 'ready', NOW)
      nodes.transition('node-1', ['ready'], 'running', NOW)

      expect(
        nodes.fail(
          'node-1',
          ['running'],
          {
            category: 'assignment_unresolved',
            nodeKey: 'task_1',
            message: 'no active assignment for role "dev"',
            details: { workRole: 'dev' },
          },
          '2026-11-01T00:03:00.000Z',
        ),
      ).toBe(true)

      const failed = nodes.get('node-1')
      expect(failed?.status).toBe('failed')
      expect(failed?.error).toEqual({
        category: 'assignment_unresolved',
        nodeKey: 'task_1',
        message: 'no active assignment for role "dev"',
        details: { workRole: 'dev' },
      })

      // 终态不能再失败；失败入口同样受状态机约束
      expect(() =>
        nodes.fail(
          'node-1',
          ['succeeded'],
          { category: 'internal', nodeKey: 'task_1', message: 'x' },
          NOW,
        ),
      ).toThrow(IllegalWorkflowTransitionError)
    } finally {
      close()
    }
  })

  it('rejects a failure without category and leaves the row untouched (F-1)', () => {
    const { runs, nodes, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      nodes.create({ id: 'node-1', workflowRunId: 'run-1', workflowNodeKey: 'task_1' }, NOW)
      nodes.transition('node-1', ['blocked'], 'ready', NOW)
      nodes.transition('node-1', ['ready'], 'running', NOW)

      // 从 JSON 构造的对象绕过了 TypeScript：缺 category
      const missingCategory = {
        nodeKey: 'task_1',
        message: 'no category here',
      } as unknown as NodeFailure
      expect(() => nodes.fail('node-1', ['running'], missingCategory, NOW)).toThrow(/category/)

      const after = nodes.get('node-1')
      expect(after?.status).toBe('running')
      expect(after?.error).toBeNull()
      expect(after?.endedAt).toBeNull()
    } finally {
      close()
    }
  })

  it('rejects an unknown failure category and leaves the row untouched (F-1)', () => {
    const { runs, nodes, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      nodes.create({ id: 'node-1', workflowRunId: 'run-1', workflowNodeKey: 'task_1' }, NOW)
      nodes.transition('node-1', ['blocked'], 'ready', NOW)
      nodes.transition('node-1', ['ready'], 'running', NOW)

      const bogusCategory = {
        category: 'totally_bogus',
        nodeKey: 'task_1',
        message: 'x',
      } as unknown as NodeFailure
      expect(() => nodes.fail('node-1', ['running'], bogusCategory, NOW)).toThrow(/category/)

      const after = nodes.get('node-1')
      expect(after?.status).toBe('running')
      expect(after?.error).toBeNull()
      expect(after?.endedAt).toBeNull()
    } finally {
      close()
    }
  })

  it('supports multiple attempts and looks them up by node key', () => {
    const { runs, nodes, close } = setup()
    try {
      runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1' }, NOW)
      nodes.create({ id: 'node-a1', workflowRunId: 'run-1', workflowNodeKey: 'task_1' }, NOW)
      nodes.create(
        { id: 'node-a2', workflowRunId: 'run-1', workflowNodeKey: 'task_1', attempt: 2 },
        NOW,
      )
      const attempts = nodes.listByRunAndKey('run-1', 'task_1')
      expect(attempts.map((node) => node.attempt)).toEqual([1, 2])
      expect(() =>
        nodes.create(
          { id: 'node-a3', workflowRunId: 'run-1', workflowNodeKey: 'task_1', attempt: 0 },
          NOW,
        ),
      ).toThrow(/attempt/)
    } finally {
      close()
    }
  })
})
