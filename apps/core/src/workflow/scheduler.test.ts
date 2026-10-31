import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { assertWorkflowConsistency } from './consistency'
import {
  allowAllResourcePorts,
  type DispatchGate,
  defaultDispatchGates,
  type ResourcePorts,
} from './dispatch-gates'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowScheduler } from './scheduler'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function definition(): WorkflowDefinition {
  const task = (key: string, role: string, y: number) => ({
    key,
    type: 'agent_task' as const,
    label: '',
    position: { x: 0, y },
    config: { assignmentSelector: { workRole: role }, taskPrompt: 'x' },
  })
  return {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      task('prd', 'product', 1),
      { key: 'split_1', type: 'parallel_split', label: '', position: { x: 0, y: 2 }, config: {} },
      { ...task('ui', 'ui', 3), position: { x: -1, y: 3 } },
      { ...task('backend', 'backend', 3), position: { x: 1, y: 3 } },
      {
        key: 'join_1',
        type: 'join',
        label: '',
        position: { x: 0, y: 4 },
        config: { pairWith: 'split_1' },
      },
      task('qa', 'qa', 5),
      { key: 'end_1', type: 'end', label: '', position: { x: 0, y: 6 }, config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'prd' },
      { key: 'e2', source: 'prd', target: 'split_1' },
      { key: 'e3', source: 'split_1', target: 'ui', branchKey: 'ui' },
      { key: 'e4', source: 'split_1', target: 'backend', branchKey: 'backend' },
      { key: 'e5', source: 'ui', target: 'join_1' },
      { key: 'e6', source: 'backend', target: 'join_1' },
      { key: 'e7', source: 'join_1', target: 'qa' },
      { key: 'e8', source: 'qa', target: 'end_1' },
    ],
    settings: {
      defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
      reworkPolicy: { maxRounds: 2 },
      failureStrategy: 'fail_branch',
      concurrency: { maxParallelNodes: 4 },
    },
  } as unknown as WorkflowDefinition
}

type Harness = {
  db: Database
  runs: WorkflowRunRepository
  branches: BranchRunRepository
  nodes: NodeRunRepository
  definitions: PublishedDefinitionProvider
  scheduler: WorkflowScheduler
  runId: string
  definition: WorkflowDefinition
  started: string[]
  advance: (ms: number) => void
  now: () => string
  makeScheduler: (
    overrides?: Partial<{
      gates: DispatchGate[]
      ports: ResourcePorts
      logger: { warn: (message: string, meta?: Record<string, unknown>) => void }
      onNodeStarted: (context: {
        nodeRun: { id: string }
        node: { key: string }
      }) => void | Promise<void>
    }>,
  ) => WorkflowScheduler
  close: () => void
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-scheduler-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)

  let clock = Date.parse('2026-11-01T00:00:00.000Z')
  const now = () => new Date(clock).toISOString()
  const advance = (ms: number) => {
    clock += ms
  }

  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(now(), now())
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json,
       health_status, created_at, updated_at)
     VALUES ('prov-1', 'cli', 'claude', '{}', 'healthy', ?, ?)`,
  ).run(now(), now())

  const repo = new WorkflowRepository(db)
  const service = new WorkflowDefinitionService(db, repo, now)
  const template = service.createTemplate({ name: 't' })
  const draft = service.createDraft(template.id, definition())
  service.publish(draft.id)

  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const definitions = new PublishedDefinitionProvider(repo)

  runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: draft.id }, now())
  runs.transition('run-1', ['pending'], 'running', now())

  const started: string[] = []
  const defaultHandler = (context: { node: { key: string } }) => {
    started.push(context.node.key)
  }

  const makeScheduler: Harness['makeScheduler'] = (overrides = {}) =>
    new WorkflowScheduler({
      runs,
      branches,
      nodes,
      definitions,
      gates: overrides.gates ?? defaultDispatchGates(overrides.ports ?? allowAllResourcePorts()),
      logger: overrides.logger,
      onNodeStarted:
        overrides.onNodeStarted ??
        (defaultHandler as unknown as (context: {
          nodeRun: { id: string }
          node: { key: string }
        }) => void),
      now,
    })

  const scheduler = makeScheduler()
  scheduler.ensureBranches('run-1', definition())
  for (const node of definition().nodes) {
    nodes.create({ id: `nr-${node.key}`, workflowRunId: 'run-1', workflowNodeKey: node.key }, now())
  }

  return {
    db,
    runs,
    branches,
    nodes,
    scheduler,
    definitions,
    runId: 'run-1',
    definition: definition(),
    started,
    advance,
    now,
    makeScheduler,
    close: () => db.close(),
  }
}

function nodeStatus(h: Harness, key: string): string | undefined {
  return h.nodes.listByRun(h.runId).find((node) => node.workflowNodeKey === key)?.status
}

function succeed(h: Harness, key: string): void {
  h.nodes.transition(`nr-${key}`, ['running'], 'succeeded', h.now())
}

describe('WorkflowScheduler · 基本推进', () => {
  it('promotes blocked → ready and dispatches ready → running', async () => {
    const h = harness()
    try {
      const result = await h.scheduler.tick(h.runId)
      expect(result.promoted).toEqual(['start'])
      expect(result.startedAttempts).toEqual(['start'])
      expect(nodeStatus(h, 'start')).toBe('running')

      succeed(h, 'start')
      const next = await h.scheduler.tick(h.runId)
      expect(next.promoted).toEqual(['prd'])
      expect(next.startedAttempts).toEqual(['prd'])
      expect(h.started).toEqual(['start', 'prd'])
    } finally {
      h.close()
    }
  })

  it('does not start a node twice once it is running (CAS)', async () => {
    const h = harness()
    try {
      await h.scheduler.tick(h.runId)
      const second = await h.scheduler.tick(h.runId)
      expect(second.startedAttempts).toEqual([])
      expect(h.started).toEqual(['start'])
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · 闸门', () => {
  it('keeps a node ready when a resource gate denies it', async () => {
    const h = harness()
    try {
      await h.scheduler.tick(h.runId)
      succeed(h, 'start')

      const deniedPorts: ResourcePorts = {
        ...allowAllResourcePorts(),
        agentCapacity: { hasCapacity: (context) => context.node.key !== 'prd' },
      }
      const denied = h.makeScheduler({ ports: deniedPorts })
      const blocked = await denied.tick(h.runId)
      expect(blocked.promoted).toEqual(['prd'])
      expect(blocked.startedAttempts).toEqual([])
      expect(blocked.skippedGates).toEqual([
        { nodeKey: 'prd', gate: 'agent_capacity', reason: 'agent concurrency limit reached' },
      ])
      expect(nodeStatus(h, 'prd')).toBe('ready')

      // 资源恢复后同一 ready 节点可以被派发
      const allowed = h.makeScheduler()
      const resumed = await allowed.tick(h.runId)
      expect(resumed.startedAttempts).toEqual(['prd'])
    } finally {
      h.close()
    }
  })

  it('marks the node failed with a structured error when the start handler throws', async () => {
    const h = harness()
    try {
      const failing = h.makeScheduler({
        onNodeStarted: () => {
          throw new Error('bridge unavailable')
        },
      })
      await failing.tick(h.runId)
      const node = h.nodes.listByRun(h.runId).find((item) => item.workflowNodeKey === 'start')
      expect(node?.status).toBe('failed')
      expect(node?.error).toEqual({
        category: 'internal',
        nodeKey: 'start',
        message: 'node start handler failed: bridge unavailable',
      })
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · 分支暂停（C-4：60 秒窗口）', () => {
  it('blocks only the paused branch and never starts it within the 60s window', async () => {
    const h = harness()
    try {
      await h.scheduler.tick(h.runId) // start
      succeed(h, 'start')
      await h.scheduler.tick(h.runId) // prd
      succeed(h, 'prd')
      await h.scheduler.tick(h.runId) // split
      succeed(h, 'split_1')

      // split 成功后由 S4-5 激活两条分支；这里直接激活
      for (const key of ['split_1/ui', 'split_1/backend']) {
        const branch = h.branches.getByKey(h.runId, key)
        if (!branch) throw new Error(`missing branch ${key}`)
        h.branches.transition(branch.id, ['blocked'], 'active', h.now())
      }

      expect(h.scheduler.pauseBranch(h.runId, 'split_1/ui', 'user_paused')).toBe(true)
      const pausedAt = h.branches.getByKey(h.runId, 'split_1/ui')?.pausedAt
      expect(pausedAt).not.toBeNull()

      // 60 秒窗口：每秒 tick 一次
      for (let second = 0; second < 60; second += 1) {
        h.advance(1000)
        await h.scheduler.tick(h.runId)
      }

      expect(nodeStatus(h, 'ui')).toBe('ready')
      expect(nodeStatus(h, 'backend')).toBe('running')
      expect(h.started).not.toContain('ui')
      expect(h.started).toContain('backend')

      // 恢复后只派发满足依赖的节点
      expect(h.scheduler.resumeBranch(h.runId, 'split_1/ui')).toBe(true)
      const resumed = await h.scheduler.tick(h.runId)
      expect(resumed.startedAttempts).toEqual(['ui'])
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · Work 级暂停', () => {
  it('stops promotion and dispatch while the run is paused, and resumes afterwards', async () => {
    const h = harness()
    try {
      await h.scheduler.tick(h.runId)
      succeed(h, 'start')

      expect(h.scheduler.pauseRun(h.runId)).toBe(true)
      const paused = await h.scheduler.tick(h.runId)
      expect(paused.promoted).toEqual([])
      expect(paused.startedAttempts).toEqual([])
      expect(nodeStatus(h, 'prd')).toBe('blocked')

      expect(h.scheduler.resumeRun(h.runId)).toBe(true)
      const resumed = await h.scheduler.tick(h.runId)
      expect(resumed.startedAttempts).toEqual(['prd'])
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · 一致性边界', () => {
  it('passes the consistency check after a tick whose handler persisted an execution', async () => {
    const h = harness()
    try {
      const withExecution = h.makeScheduler({
        onNodeStarted: (context: { nodeRun: { id: string } }) => {
          h.started.push('start')
          const sessionId = `ses-${context.nodeRun.id}`
          h.db
            .prepare(
              `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
                 context_ref, status, created_at, updated_at, last_active_at)
               VALUES (?, NULL, 'prov-1', NULL, 'agt-1', 'active', ?, ?, NULL)`,
            )
            .run(sessionId, h.now(), h.now())
          h.db
            .prepare(
              `INSERT INTO executions (id, session_id, node_run_id, provider_id,
                 external_execution_id, process_id, status, working_directory,
                 capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
               VALUES (?, ?, ?, 'prov-1', NULL, NULL, 'running', '/tmp/w', '{}', NULL, ?, ?)`,
            )
            .run(`exe-${context.nodeRun.id}`, sessionId, context.nodeRun.id, h.now(), h.now())
        },
      })
      await withExecution.tick(h.runId)

      // 只在一致性边界（tick 结束后、事务已提交）调用
      expect(() => assertWorkflowConsistency(h.db)).not.toThrow()
    } finally {
      h.close()
    }
  })
})

async function readyParallelBranches(h: Harness): Promise<void> {
  await h.scheduler.tick(h.runId)
  succeed(h, 'start')
  await h.scheduler.tick(h.runId)
  succeed(h, 'prd')
  await h.scheduler.tick(h.runId)
  succeed(h, 'split_1')

  for (const key of ['split_1/ui', 'split_1/backend']) {
    const branch = h.branches.getByKey(h.runId, key)
    if (!branch) throw new Error(`missing branch ${key}`)
    h.branches.transition(branch.id, ['blocked'], 'active', h.now())
  }

  // 用拒绝派发的端口把两条分支的节点推进到 ready，但不启动
  const denyPorts: ResourcePorts = {
    ...allowAllResourcePorts(),
    agentCapacity: { hasCapacity: () => false },
  }
  await h.makeScheduler({ ports: denyPorts }).tick(h.runId)
  if (nodeStatus(h, 'ui') !== 'ready' || nodeStatus(h, 'backend') !== 'ready') {
    throw new Error('expected ui/backend to be ready')
  }
}

describe('WorkflowScheduler · 同 tick 内暂停（F-3）', () => {
  it('pausing a branch inside onNodeStarted blocks later nodes of the same tick (S-12)', async () => {
    const h = harness()
    try {
      await readyParallelBranches(h)

      let active: WorkflowScheduler | null = null
      const scheduler = h.makeScheduler({
        onNodeStarted: (context) => {
          if (context.node.key === 'ui') {
            active?.pauseBranch(h.runId, 'split_1/backend', 'paused during tick')
          }
        },
      })
      active = scheduler

      const result = await scheduler.tick(h.runId)
      expect(result.startedAttempts).toEqual(['ui'])
      expect(nodeStatus(h, 'backend')).toBe('ready')
      expect(result.skippedGates).toEqual([
        { nodeKey: 'backend', gate: 'branch_active', reason: 'branch is paused' },
      ])
    } finally {
      h.close()
    }
  })

  it('pausing the run inside onNodeStarted stops the rest of the tick (S-16)', async () => {
    const h = harness()
    try {
      await readyParallelBranches(h)

      let active: WorkflowScheduler | null = null
      const scheduler = h.makeScheduler({
        onNodeStarted: (context) => {
          if (context.node.key === 'ui') active?.pauseRun(h.runId)
        },
      })
      active = scheduler

      const result = await scheduler.tick(h.runId)
      expect(result.startedAttempts).toEqual(['ui'])
      expect(nodeStatus(h, 'backend')).toBe('ready')
      expect(result.skippedGates).toEqual([])
      expect(h.runs.get(h.runId)?.status).toBe('paused')
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · 构造契约（F-4）', () => {
  it('requires explicit dispatch gates (compile-time + runtime)', () => {
    const h = harness()
    try {
      expect(
        () =>
          // @ts-expect-error gates 必填：漏传必须在编译期失败
          new WorkflowScheduler({
            runs: h.runs,
            branches: h.branches,
            nodes: h.nodes,
            definitions: h.definitions,
          }),
      ).toThrow(/explicit dispatch gates/)
    } finally {
      h.close()
    }
  })
})

describe('WorkflowScheduler · 失败兜底可观测性（O-1）', () => {
  it('warns when the node cannot be marked failed because its state changed concurrently', async () => {
    const h = harness()
    try {
      const warns: { message: string; meta?: Record<string, unknown> }[] = []
      const scheduler = h.makeScheduler({
        logger: { warn: (message, meta) => warns.push({ message, meta }) },
        onNodeStarted: (context) => {
          // 模拟并发改走：handler 先把节点取消，再抛错 → fail() 的 CAS 落空
          h.nodes.transition(context.nodeRun.id, ['running'], 'cancelled', h.now())
          throw new Error('boom')
        },
      })

      await scheduler.tick(h.runId)
      const node = h.nodes.listByRun(h.runId).find((item) => item.workflowNodeKey === 'start')
      expect(node?.status).toBe('cancelled')
      expect(warns).toHaveLength(1)
      expect(warns[0]?.message).toContain('failed to transition to failed')
      expect(warns[0]?.meta).toEqual({ nodeKey: 'start', nodeRunId: 'nr-start' })
    } finally {
      h.close()
    }
  })
})
