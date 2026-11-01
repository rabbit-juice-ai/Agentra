import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ApprovalRepository } from '../db/repositories/approval-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../services/workflow-definition-service'
import { ApprovalService } from './approval-service'
import {
  type ControlNodeDeps,
  completeEndNode,
  completeJoinNode,
  completeSplitNode,
  completeStartNode,
} from './control-nodes'
import { type DispatchContext, defaultDispatchGates, type ResourcePorts } from './dispatch-gates'
import { WorkflowFairDispatcher } from './fair-dispatcher'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { ensureBranchRuns, WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const settings = {
  defaults: { timeoutSeconds: 1800, maxAttempts: 1 },
  reworkPolicy: { maxRounds: 2 },
  failureStrategy: 'fail_branch',
  concurrency: { maxParallelNodes: 4 },
}

const node = (key: string, type: string, config: Record<string, unknown> = {}, y = 0) => ({
  key,
  type,
  label: '',
  position: { x: 0, y },
  config,
})
const task = (key: string, role: string, y = 1) =>
  node(key, 'agent_task', { assignmentSelector: { workRole: role }, taskPrompt: 'x' }, y)

function linearDefinition(role: string): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      task('task_1', role),
      task('task_2', role, 2),
      node('end', 'end', {}, 3),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'task_2' },
      { key: 'e3', source: 'task_2', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

function parallelDefinition(role: string): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      node('start', 'start'),
      node('split_1', 'parallel_split', {}, 1),
      task('a', role, 2),
      task('b', role, 2),
      node('join', 'join', { pairWith: 'split_1' }, 3),
      node('end', 'end', {}, 4),
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'split_1' },
      { key: 'e2', source: 'split_1', target: 'a', branchKey: 'a' },
      { key: 'e3', source: 'split_1', target: 'b', branchKey: 'b' },
      { key: 'e4', source: 'a', target: 'join' },
      { key: 'e5', source: 'b', target: 'join' },
      { key: 'e6', source: 'join', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

type RunSpec = { id: string; definition: WorkflowDefinition }

type Harness = {
  db: Database
  runs: WorkflowRunRepository
  nodes: NodeRunRepository
  dispatcher: WorkflowFairDispatcher
  active: Map<string, number>
  roleAgents: Map<string, string>
  finishTask: (runId: string, nodeKey: string) => void
  close: () => void
}

function setup(specs: RunSpec[], roleAgents: Record<string, string>, maxConcurrency = 1): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-fair-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)

  const workflowRepo = new WorkflowRepository(db)
  const definitions = new PublishedDefinitionProvider(workflowRepo)
  const definitionService = new WorkflowDefinitionService(db, workflowRepo, () => NOW)
  const runs = new WorkflowRunRepository(db)
  const branches = new BranchRunRepository(db)
  const nodes = new NodeRunRepository(db)
  const roleAgentMap = new Map(Object.entries(roleAgents))
  const active = new Map<string, number>()

  const agentOf = (context: DispatchContext): string | null => {
    if (context.node.type !== 'agent_task') return null
    return roleAgentMap.get(context.node.config.assignmentSelector.workRole) ?? null
  }

  for (const spec of specs) {
    const template = definitionService.createTemplate({ name: spec.id })
    const draft = definitionService.createDraft(template.id, spec.definition)
    definitionService.publish(draft.id)
    runs.create({ id: spec.id, workId: 'work-1', workflowVersionId: draft.id }, NOW)
    runs.transition(spec.id, ['pending'], 'running', NOW)
    const branchRuns = ensureBranchRuns(branches, spec.id, spec.definition, NOW)
    const branchByKey = new Map(branchRuns.map((branch) => [branch.branchKey, branch.id]))
    const branchKeys = new Map(
      spec.definition.nodes.map((definitionNode) => {
        if (definitionNode.type === 'start' || definitionNode.type === 'parallel_split') {
          return [definitionNode.key, 'root'] as const
        }
        if (definitionNode.key === 'a') return [definitionNode.key, 'split_1/a'] as const
        if (definitionNode.key === 'b') return [definitionNode.key, 'split_1/b'] as const
        return [definitionNode.key, 'root'] as const
      }),
    )
    for (const definitionNode of spec.definition.nodes) {
      const branchKey = branchKeys.get(definitionNode.key) ?? 'root'
      nodes.create(
        {
          id: `nrn-${spec.id}-${definitionNode.key}`,
          workflowRunId: spec.id,
          workflowNodeKey: definitionNode.key,
          branchRunId: branchByKey.get(branchKey) ?? null,
        },
        NOW,
      )
    }
  }

  const approvalService = new ApprovalService(
    db,
    new ApprovalRepository(db),
    nodes,
    branches,
    () => NOW,
  )
  const controlDeps: ControlNodeDeps = {
    db,
    runs,
    branches,
    nodes,
    definitions,
    approvals: approvalService,
    now: () => NOW,
  }

  const ports: ResourcePorts = {
    agentCapacity: {
      hasCapacity: (context) => {
        const agentId = agentOf(context)
        if (!agentId) return true
        return (active.get(agentId) ?? 0) < maxConcurrency
      },
    },
    providerAvailability: { isAvailable: () => true },
    workdirAvailability: { isAvailable: () => true },
    inputArtifacts: { isAvailable: () => true },
  }

  const scheduler = new WorkflowScheduler({
    runs,
    branches,
    nodes,
    definitions,
    gates: defaultDispatchGates(ports),
    agentResolver: agentOf,
    onNodeStarted: (context) => {
      const nodeRunId = context.nodeRun.id
      switch (context.node.type) {
        case 'start':
          completeStartNode(controlDeps, nodeRunId)
          break
        case 'parallel_split':
          completeSplitNode(controlDeps, nodeRunId)
          break
        case 'join':
          completeJoinNode(controlDeps, nodeRunId)
          break
        case 'end':
          completeEndNode(controlDeps, nodeRunId)
          break
        case 'agent_task': {
          const agentId = agentOf(context)
          if (agentId) active.set(agentId, (active.get(agentId) ?? 0) + 1)
          break
        }
      }
    },
    now: () => NOW,
  })

  const finishTask = (runId: string, nodeKey: string): void => {
    const latest = nodes.listByRunAndKey(runId, nodeKey).at(-1)
    if (!latest) throw new Error(`missing ${nodeKey}`)
    nodes.transition(latest.id, ['running'], 'succeeded', NOW)
    const definitionNode = specs
      .find((spec) => spec.id === runId)
      ?.definition.nodes.find((candidate) => candidate.key === nodeKey)
    if (definitionNode?.type !== 'agent_task') throw new Error(`not an agent_task: ${nodeKey}`)
    const agentId = roleAgentMap.get(definitionNode.config.assignmentSelector.workRole)
    if (agentId) active.set(agentId, Math.max(0, (active.get(agentId) ?? 1) - 1))
  }

  return {
    db,
    runs,
    nodes,
    dispatcher: new WorkflowFairDispatcher({ runs, scheduler }),
    active,
    roleAgents: roleAgentMap,
    finishTask,
    close: () => db.close(),
  }
}

describe('WorkflowFairDispatcher · C-1 公平性', () => {
  it('rotates multiple Runs of the same Agent and leaves real scheduling output', async () => {
    const h = setup(
      [
        { id: 'run-a', definition: linearDefinition('dev') },
        { id: 'run-b', definition: linearDefinition('dev') },
      ],
      { dev: 'agent-1' },
      1,
    )
    try {
      const first = await h.dispatcher.tickAll()
      expect(first.started.map((start) => `${start.runId}:${start.nodeKey}`)).toEqual([
        'run-a:start',
        'run-b:start',
        'run-b:task_1',
      ])

      h.finishTask('run-b', 'task_1')
      const second = await h.dispatcher.tickAll()
      expect(second.started.map((start) => `${start.runId}:${start.nodeKey}`)).toEqual([
        'run-a:task_1',
      ])

      h.finishTask('run-a', 'task_1')
      const third = await h.dispatcher.tickAll()
      expect(third.started.map((start) => `${start.runId}:${start.nodeKey}`)).toEqual([
        'run-b:task_2',
      ])

      h.finishTask('run-b', 'task_2')
      const fourth = await h.dispatcher.tickAll()
      expect(fourth.started.map((start) => `${start.runId}:${start.nodeKey}`)).toEqual([
        'run-a:task_2',
        'run-b:end',
      ])

      h.finishTask('run-a', 'task_2')
      const final = await h.dispatcher.tickAll()
      expect(final.started.map((start) => `${start.runId}:${start.nodeKey}`)).toEqual(['run-a:end'])
      expect(h.runs.get('run-a')?.status).toBe('completed')
      expect(h.runs.get('run-b')?.status).toBe('completed')
    } finally {
      h.close()
    }
  })

  it('keeps each Agent slot independent: A full does not block B', async () => {
    const h = setup(
      [
        { id: 'run-a', definition: linearDefinition('dev') },
        { id: 'run-b', definition: linearDefinition('qa') },
      ],
      { dev: 'agent-dev', qa: 'agent-qa' },
      1,
    )
    try {
      const report = await h.dispatcher.tickAll()
      const taskStarts = report.started.filter((start) => start.nodeKey === 'task_1')
      expect(taskStarts.map((start) => start.runId).sort()).toEqual(['run-a', 'run-b'])
      expect(
        h.nodes.listByRun('run-a').find((nodeRun) => nodeRun.workflowNodeKey === 'task_1')?.status,
      ).toBe('running')
      expect(
        h.nodes.listByRun('run-b').find((nodeRun) => nodeRun.workflowNodeKey === 'task_1')?.status,
      ).toBe('running')
    } finally {
      h.close()
    }
  })

  it('fills free slots and keeps running non-zero while work remains', async () => {
    const h = setup([{ id: 'run-a', definition: parallelDefinition('dev') }], { dev: 'agent-1' }, 2)
    try {
      const report = await h.dispatcher.tickAll()
      const running = h.nodes
        .listByRun('run-a')
        .filter((nodeRun) => nodeRun.status === 'running')
        .map((nodeRun) => nodeRun.workflowNodeKey)
        .sort()
      expect(running).toEqual(['a', 'b'])
      expect(report.passes).toBeGreaterThan(1)
    } finally {
      h.close()
    }
  })
})
