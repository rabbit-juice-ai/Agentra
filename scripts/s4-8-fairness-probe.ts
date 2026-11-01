/**
 * S4-8 公平性探针：两个 Run 竞争同一个 Agent（maxConcurrency=1），
 * 用真实 WorkflowScheduler + WorkflowFairDispatcher 打印跨 Run 启动顺序。
 *
 * 运行：pnpm exec tsx scripts/s4-8-fairness-probe.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowDefinition } from '@agentra/workflow-schema'
import { openDatabase } from '../apps/core/src/db/database'
import { migrate } from '../apps/core/src/db/migrations'
import { ApprovalRepository } from '../apps/core/src/db/repositories/approval-repository'
import { BranchRunRepository } from '../apps/core/src/db/repositories/branch-run-repository'
import { NodeRunRepository } from '../apps/core/src/db/repositories/node-run-repository'
import { WorkflowRepository } from '../apps/core/src/db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../apps/core/src/db/repositories/workflow-run-repository'
import { WorkflowDefinitionService } from '../apps/core/src/services/workflow-definition-service'
import { ApprovalService } from '../apps/core/src/workflow/approval-service'
import {
  type ControlNodeDeps,
  completeEndNode,
  completeStartNode,
} from '../apps/core/src/workflow/control-nodes'
import { defaultDispatchGates, type ResourcePorts } from '../apps/core/src/workflow/dispatch-gates'
import { WorkflowFairDispatcher } from '../apps/core/src/workflow/fair-dispatcher'
import { PublishedDefinitionProvider } from '../apps/core/src/workflow/published-definition-provider'
import { ensureBranchRuns, WorkflowScheduler } from '../apps/core/src/workflow/scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
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
const task = (key: string, y = 1) =>
  node(key, 'agent_task', { assignmentSelector: { workRole: 'dev' }, taskPrompt: 'x' }, y)

function definition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [node('start', 'start'), task('task_1'), task('task_2', 2), node('end', 'end', {}, 3)],
    edges: [
      { key: 'e1', source: 'start', target: 'task_1' },
      { key: 'e2', source: 'task_1', target: 'task_2' },
      { key: 'e3', source: 'task_2', target: 'end' },
    ],
    settings,
  } as unknown as WorkflowDefinition
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-fair-probe-'))
  const db = openDatabase(path.join(dir, 'agentra.db'))
  try {
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
    const active = new Map<string, number>()
    const agentOf = (context: {
      node: { type: string; config: { assignmentSelector?: { workRole: string } } }
    }) => (context.node.type === 'agent_task' ? 'agent-1' : null)

    for (const runId of ['run-a', 'run-b']) {
      const template = definitionService.createTemplate({ name: runId })
      const draft = definitionService.createDraft(template.id, definition())
      definitionService.publish(draft.id)
      runs.create({ id: runId, workId: 'work-1', workflowVersionId: draft.id }, NOW)
      runs.transition(runId, ['pending'], 'running', NOW)
      const branchRuns = ensureBranchRuns(branches, runId, definition(), NOW)
      const root = branchRuns.find((branch) => branch.branchKey === 'root')
      for (const definitionNode of definition().nodes) {
        nodes.create(
          {
            id: `nrn-${runId}-${definitionNode.key}`,
            workflowRunId: runId,
            workflowNodeKey: definitionNode.key,
            branchRunId: root?.id ?? null,
          },
          NOW,
        )
      }
    }

    const controlDeps: ControlNodeDeps = {
      db,
      runs,
      branches,
      nodes,
      definitions,
      approvals: new ApprovalService(db, new ApprovalRepository(db), nodes, branches, () => NOW),
      now: () => NOW,
    }
    const ports: ResourcePorts = {
      agentCapacity: {
        hasCapacity: (context) => {
          const agentId = agentOf(context as never)
          return agentId ? (active.get(agentId) ?? 0) < 1 : true
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
      agentResolver: (context) => agentOf(context as never),
      onNodeStarted: (context) => {
        switch (context.node.type) {
          case 'start':
            completeStartNode(controlDeps, context.nodeRun.id)
            break
          case 'end':
            completeEndNode(controlDeps, context.nodeRun.id)
            break
          case 'agent_task':
            active.set('agent-1', (active.get('agent-1') ?? 0) + 1)
            break
        }
      },
      now: () => NOW,
    })
    const dispatcher = new WorkflowFairDispatcher({ runs, scheduler })
    const sequence: string[] = []

    for (let round = 0; round < 20; round += 1) {
      const report = await dispatcher.tickAll()
      for (const start of report.started) {
        sequence.push(`${start.runId}:${start.nodeKey}`)
      }
      if (runs.listRunning().length === 0) break
      // 模拟执行完成：把所有 running 任务收尾，释放 Agent 槽位。
      let finished = false
      for (const run of runs.listRunning()) {
        for (const nodeRun of nodes.listByRun(run.id)) {
          if (nodeRun.status !== 'running') continue
          nodes.transition(nodeRun.id, ['running'], 'succeeded', NOW)
          active.set('agent-1', Math.max(0, (active.get('agent-1') ?? 1) - 1))
          finished = true
        }
      }
      if (!finished) break
    }

    console.log(`FAIRNESS_SEQUENCE=${sequence.join(',')}`)
    console.log(`RUN_STATUS=${runs.get('run-a')?.status},${runs.get('run-b')?.status}`)
    console.log('S4_8_FAIRNESS_PROBE_PASS')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

void main()
