import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../daemon/daemon-client'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { WorkflowRepository } from '../db/repositories/workflow-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { checkWorkflowConsistency } from './consistency'
import { allowAllResourcePorts, defaultDispatchGates } from './dispatch-gates'
import { PublishedDefinitionProvider } from './published-definition-provider'
import { WorkflowRecoveryService } from './recovery-service'
import { WorkflowScheduler } from './scheduler'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CAPS = {
  streaming: 'native',
  structuredEvents: 'native',
  interrupt: 'native',
  resume: 'native',
  checkpoint: 'unsupported',
  permissionRequests: 'native',
  sessionPersistence: 'native',
  workingDirectory: 'native',
  toolControl: 'native',
} as const

class FakeRuntime implements RuntimeClient {
  readonly interrupts: string[] = []
  active: string[] = ['exe-1']
  async discover(): Promise<never[]> {
    return []
  }
  async start(): Promise<never> {
    throw new Error('not used')
  }
  async sendMessage(): Promise<void> {}
  async interrupt(executionId: string): Promise<{ interrupted: boolean }> {
    this.interrupts.push(executionId)
    // 真实 CLI 中断后进程退出：从 active 移除
    this.active = this.active.filter((id) => id !== executionId)
    return { interrupted: true }
  }
  async cancel(): Promise<void> {}
  async status(): Promise<never> {
    throw new Error('not used')
  }
  async listActive(): Promise<string[]> {
    return [...this.active]
  }
  subscribe(): () => void {
    return () => {}
  }
  close(): void {}
}

type Harness = {
  db: Database
  scheduler: WorkflowScheduler
  executions: ExecutionRepository
  audit: AuditRepository
  runId: string
  branchId: string
  nodeRunId: string
  recovery: (runtime: FakeRuntime) => Promise<void>
  close: () => void
}

function setup(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-pause-int-'))
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
    `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json, checksum, status, created_at, published_at)
     VALUES ('wfv-1', 'wft-1', 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}', 'sum', 'published', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_runs (id, work_id, workflow_version_id, status, started_at, runtime_state_json, created_at, updated_at)
     VALUES ('run-1', 'work-1', 'wfv-1', 'running', ?, '{}', ?, ?)`,
  ).run(NOW, NOW, NOW)
  db.prepare(
    `INSERT INTO branch_runs (id, workflow_run_id, branch_key, status, created_at, updated_at)
     VALUES ('br-root', 'run-1', 'root', 'active', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO node_runs (id, workflow_run_id, workflow_node_key, branch_run_id, status, attempt, input_snapshot_json, created_at, updated_at)
     VALUES ('nrn-1', 'run-1', 'task_1', 'br-root', 'running', 1, '{}', ?, ?)`,
  ).run(NOW, NOW)

  const audit = new AuditRepository(db)
  const executions = new ExecutionRepository(db)
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
     VALUES ('prov-1', 'cli', 'P', '{}', 'healthy', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id, context_ref, status, created_at, updated_at, last_active_at)
     VALUES ('ses-1', NULL, 'prov-1', NULL, NULL, 'active', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO executions (
       id, session_id, node_run_id, provider_id, status, working_directory,
       capabilities_snapshot_json, created_at, updated_at
     ) VALUES ('exe-1', 'ses-1', 'nrn-1', 'prov-1', 'running', '/tmp/w', ?, ?, ?)`,
  ).run(JSON.stringify(CAPS), NOW, NOW)

  const scheduler = new WorkflowScheduler({
    runs: new WorkflowRunRepository(db),
    branches: new BranchRunRepository(db),
    nodes: new NodeRunRepository(db),
    definitions: new PublishedDefinitionProvider(new WorkflowRepository(db)),
    gates: defaultDispatchGates(allowAllResourcePorts()),
    audit,
    executionsRepo: executions,
    now: () => NOW,
  })

  const recovery = async (runtime: FakeRuntime): Promise<void> => {
    // 模拟 reconcile 补记账 + 恢复服务：执行被中断 → 终态 → 节点不留在 running。
    for (const execution of executions.listActive()) {
      if (!runtime.active.includes(execution.id)) {
        executions.finish(execution.id, {
          status: 'cancelled',
          endedAt: NOW,
          recoveryState: { reason: 'branch_paused' },
        })
      }
    }
    const branchRepo = new BranchRunRepository(db)
    const recoveryService = new WorkflowRecoveryService(
      new WorkflowRunRepository(db),
      branchRepo,
      new NodeRunRepository(db),
      executions,
      new WorkflowScheduler({
        runs: new WorkflowRunRepository(db),
        branches: branchRepo,
        nodes: new NodeRunRepository(db),
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        now: () => NOW,
      }),
      undefined,
      undefined,
      undefined,
      () => NOW,
    )
    await recoveryService.recover()
  }

  return {
    db,
    scheduler,
    executions,
    audit,
    runId: 'run-1',
    branchId: 'br-root',
    nodeRunId: 'nrn-1',
    recovery,
    close: () => db.close(),
  }
}

describe('S4-07 · 暂停—中断—恢复—重启 集成', () => {
  it('interrupt on pause keeps node reconciliation clean and recovery closes the loop', async () => {
    const h = setup()
    try {
      const runtime = new FakeRuntime()
      // pauseBranch 走真实 ExecutionRepository：interrupt 能力可用 → 执行被打断
      const scheduler = new WorkflowScheduler({
        runs: new WorkflowRunRepository(h.db),
        branches: new BranchRunRepository(h.db),
        nodes: new NodeRunRepository(h.db),
        definitions: new PublishedDefinitionProvider(new WorkflowRepository(h.db)),
        gates: defaultDispatchGates(allowAllResourcePorts()),
        audit: h.audit,
        executionsRepo: h.executions,
        pauseExecutor: { interrupt: (id) => runtime.interrupt(id) },
        now: () => NOW,
      })

      const paused = await scheduler.pauseBranch(h.runId, 'root', 'user_paused')
      expect(paused).toBe(true)
      expect(runtime.interrupts).toEqual(['exe-1'])
      expect(h.audit.listByAction('workflow.execution.interrupted')[0]?.details).toMatchObject({
        runId: 'run-1',
        branchRunId: 'br-root',
        nodeRunId: 'nrn-1',
        interrupted: true,
        resumeUsable: true,
      })

      // 恢复服务：被中断执行按终态补记账，节点不留在 running
      await h.recovery(runtime)
      const execution = h.executions.get('exe-1')
      expect(execution?.status).toBe('cancelled')
      const nodeRepo = new NodeRunRepository(h.db)
      const node = nodeRepo.get('nrn-1')
      expect(['cancelled', 'reconciliation_required', 'succeeded', 'failed']).toContain(
        node?.status,
      )
      expect(
        checkWorkflowConsistency(h.db).filter(
          (issue) => issue.code !== 'run_running_without_started_at',
        ),
      ).toEqual([])
    } finally {
      h.close()
    }
  })
})
