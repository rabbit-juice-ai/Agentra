import type { Execution } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BranchRunRepository } from '../db/repositories/branch-run-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { NodeRunRepository } from '../db/repositories/node-run-repository'
import { RecoveryAttemptRepository } from '../db/repositories/recovery-attempt-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import {
  type WorkflowNodeRecoveryExecutionPort,
  WorkflowNodeRecoveryService,
} from './node-recovery-service'

const NOW = '2026-11-10T00:00:00.000Z'
const dbFiles: string[] = []

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

afterEach(() => {
  for (const file of dbFiles.splice(0))
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

function harness(options: { policy?: 'worktree' | 'work_root' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-node-recovery-'))
  const file = path.join(dir, 'agentra.db')
  dbFiles.push(file)
  const db = openDatabase(file)
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/root', '/tmp/repo', '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO runtime_providers (
       id, provider_type, provider_name, executable_path, version, capabilities_json,
       health_status, last_discovered_at, created_at, updated_at
     ) VALUES ('prov-test', 'cli', 'test', '/bin/true', '1', '{}', 'healthy', NULL, ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, category, created_at, updated_at, archived_at)
     VALUES ('tpl-1', 'T', '', '', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const definition = {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', label: '', position: { x: 0, y: 0 }, config: {} },
      {
        key: 'task_1',
        type: 'agent_task',
        label: '',
        position: { x: 0, y: 1 },
        config: {
          assignmentSelector: { workRole: 'dev' },
          taskPrompt: 'do it',
          inputArtifactRefs: [],
          artifacts: [],
          workingDirectoryPolicy: options.policy ?? 'worktree',
          outputContract: { profile: 'generic', fields: [] },
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
  }
  db.prepare(
    `INSERT INTO workflow_versions (id, template_id, version, schema_version, definition_json,
       checksum, status, created_at, published_at)
     VALUES ('wfv-1', 'tpl-1', 1, 1, ?, 'checksum', 'published', ?, ?)`,
  ).run(JSON.stringify(definition), NOW, NOW)
  const runs = new WorkflowRunRepository(db)
  runs.create({ id: 'run-1', workId: 'work-1', workflowVersionId: 'wfv-1', status: 'running' }, NOW)
  const branches = new BranchRunRepository(db)
  branches.create({ id: 'brn-1', workflowRunId: 'run-1', branchKey: 'root', status: 'active' }, NOW)
  const nodes = new NodeRunRepository(db)
  nodes.create(
    {
      id: 'nrn-a',
      workflowRunId: 'run-1',
      workflowNodeKey: 'task_1',
      branchRunId: 'brn-1',
      status: 'reconciliation_required',
      attempt: 1,
    },
    NOW,
  )
  db.prepare(
    `INSERT INTO task_checkpoints (
       id, work_id, seq, base_dedupe_key, dedupe_key, attempt_no, state, kind, stage,
       execution_id, session_id, node_run_id, team_run_id, parent_checkpoint_id,
       acceptance_criteria_work_version, task_memory_version, risk_level, evidence_status,
       side_effect_completeness, checkpoint_json, evidence_json, verification_json,
       error_json, content_hash, created_at
     ) VALUES ('chk-1', 'work-1', 1, 'base', 'dedupe', 1, 'valid', 'stage_complete', 'task_1',
       NULL, NULL, 'nrn-a', NULL, NULL, 1, NULL, 'low', 'verified', 'not_tracked',
       '{}', '{}', '{}', NULL, 'hash', ?)`,
  ).run(NOW)
  const attempts = new RecoveryAttemptRepository(db)
  const executions = new ExecutionRepository(db)
  const checkpoint = {
    id: 'chk-1',
    workId: 'work-1',
    seq: 1,
    kind: 'stage_complete',
    state: 'valid',
    nodeRunId: 'nrn-a',
    riskLevel: 'low',
    evidenceStatus: 'verified',
    sideEffectCompleteness: 'not_tracked',
    executionId: 'exe-old',
    createdAt: NOW,
  }
  const worktrees = {
    branchName: () => 'agentra/run/task-1/abc-r1',
    prepare: () => ({
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt-1',
      branchName: 'agentra/run/task-1/abc-r1',
      baseCommit: 'a'.repeat(40),
      gitCommonDir: '/tmp/repo/.git',
      registeredWorktreePath: '/tmp/wt-1',
      worktreeOwnerToken: 'owner-token',
    }),
    validate: () => undefined,
  }
  const prepared: { executionId: string; sessionId: string }[] = []
  const reentered: string[] = []
  const executionRunner: WorkflowNodeRecoveryExecutionPort = {
    prepareRecoveryForNode: (_tx, nodeRunId, _params, _options) => {
      const index = prepared.length + 1
      const value = { executionId: `exe-new-${index}`, sessionId: `ses-${index}` }
      db.prepare(
        `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
           context_ref, status, created_at, updated_at, last_active_at)
         VALUES (?, NULL, 'prov-test', NULL, NULL, 'active', ?, ?, ?)`,
      ).run(value.sessionId, NOW, NOW, NOW)
      db.prepare(
        `INSERT INTO executions (id, session_id, node_run_id, provider_id, external_execution_id,
           process_id, status, working_directory, started_at, ended_at, exit_code,
           capabilities_snapshot_json, recovery_state_json, created_at, updated_at)
         VALUES (?, ?, ?, 'prov-test', NULL, NULL, 'pending', '/tmp/wt-1', NULL, NULL, NULL,
           '{}', NULL, ?, ?)`,
      ).run(value.executionId, value.sessionId, nodeRunId, NOW, NOW)
      prepared.push(value)
      return value
    },
    spawnPreparedRecovery: async (executionId) =>
      ({ id: executionId, status: 'running' }) as unknown as Execution,
    discardPreparedRecovery: () => undefined,
    classifyPendingStart: async () => 'not_started',
  }
  const service = new WorkflowNodeRecoveryService({
    db,
    runs,
    branches,
    nodes,
    works: new WorkRepository(db),
    attempts,
    executions,
    definitions: {
      get: () => ({ definition }),
    } as never,
    assignments: {
      resolveForNode: () => ({ id: 'asg-1', agentId: 'agt-1' }),
    } as never,
    checkpoints: {
      getCheckpoint: () => checkpoint as never,
      getRecoveryPlan: () =>
        ({
          eligibility: {
            status: 'eligible',
            reasonCodes: [],
            riskLevel: 'low',
            evidenceStatus: 'verified',
            sideEffectCompleteness: 'not_tracked',
          },
          plan: {
            sections: { p0: 'p0', p1: '', p2: '', p3: '' },
            manifest: { trimmed: { p1: false, p2: false, p3: false } },
          },
        }) as never,
      assertCanStart: () => undefined,
    },
    executionRunner,
    worktrees: worktrees as never,
    audit: new AuditRepository(db),
    onRunReentered: (runId) => reentered.push(runId),
    now: () => NOW,
  })
  return { db, service, attempts, nodes, prepared, reentered, checkpoint }
}

describe('WorkflowNodeRecoveryService', () => {
  it('plans a recoverable agent_task with worktree policy and checkpoint', async () => {
    const h = harness()
    const plan = await h.service.plan({ workflowRunId: 'run-1', nodeRunId: 'nrn-a' })
    expect(plan.eligibility.status).toBe('eligible')
    expect(plan.target.recoveryChainId).toBe('nrn-a')
    expect(plan.worktree.policy).toBe('worktree')
    expect(plan.chain.attemptNo).toBe(1)
    expect(plan.limits.attemptsUsed).toBe(0)
    h.db.close()
  })

  it('blocks shared working directories', async () => {
    const h = harness({ policy: 'work_root' })
    const plan = await h.service.plan({ workflowRunId: 'run-1', nodeRunId: 'nrn-a' })
    expect(plan.eligibility.status).toBe('blocked')
    expect(plan.eligibility.reasonCodes).toContain('NODE_RECOVERY_WORKTREE_REQUIRED')
    h.db.close()
  })

  it('starts a recovery, creates a new NodeRun and marks the attempt running', async () => {
    const h = harness()
    const result = await h.service.start({
      workflowRunId: 'run-1',
      nodeRunId: 'nrn-a',
      confirm: true,
      idempotencyKey: 'idem-1',
    })
    expect(result.idempotentReplay).toBe(false)
    expect(result.newNodeRunId).toBeTruthy()
    expect(h.prepared).toHaveLength(1)
    const attempt = h.attempts.get(result.recoveryAttemptId)
    expect(attempt?.status).toBe('running')
    expect(attempt?.nodeRunId).toBe(result.newNodeRunId)
    expect(h.nodes.get('nrn-a')?.status).toBe('failed')
    h.db.close()
  })

  it('reenters a reconciliation-required Run only when no blockers remain and kicks', () => {
    const h = harness()
    h.db
      .prepare("UPDATE workflow_runs SET status = 'reconciliation_required' WHERE id = 'run-1'")
      .run()
    expect(h.service.reconcileRun('run-1')).toBe(false)
    h.db.prepare("UPDATE node_runs SET status = 'failed' WHERE id = 'nrn-a'").run()
    expect(h.service.reconcileRun('run-1')).toBe(true)
    expect(h.reentered).toEqual(['run-1'])
    h.db.close()
  })

  it('startup reconciler turns a ready-but-unstarted Worktree into an orphan and fails R', async () => {
    const h = harness()
    h.attempts.insert({
      id: 'rec-startup',
      workId: 'work-1',
      checkpointId: 'chk-1',
      kind: 'workflow_node',
      baseDedupeKey: 'workflow_node:nrn-a',
      dedupeKey: 'workflow_node:nrn-a:1',
      idempotencyKey: 'idem-startup',
      attemptNo: 1,
      status: 'starting',
      riskLevel: 'low',
      eligibilityStatus: 'eligible',
      originalWorkStatus: null,
      reopenReason: null,
      operatorConfirmationJson: '{}',
      planHash: 'hash',
      contextManifestJson: JSON.stringify({
        worktree: {
          state: 'ready',
          worktreeId: 'wt-1',
          worktreePath: '/tmp/wt-1',
          branchName: 'agentra/run/task-1/abc-r1',
          newNodeRunId: 'nrn-b',
          worktreeOwnerToken: 'owner-token',
        },
      }),
      executionId: null,
      sessionId: null,
      teamRunId: null,
      nodeRunId: null,
      workflowRunId: 'run-1',
      branchRunId: 'brn-1',
      recoveredNodeRunId: 'nrn-a',
      chainAttemptNo: 1,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null,
      endedAt: null,
    })
    const attempt = h.attempts.get('rec-startup')
    expect(attempt).not.toBeNull()
    await h.service.reconcileStartup(attempt as never)
    const updated = h.attempts.get('rec-startup')
    expect(updated?.status).toBe('failed')
    expect(updated?.contextManifestJson).toContain('orphaned')
    h.db.close()
  })

  it('converges a T3 failure to failed + orphaned worktree', async () => {
    const h = harness()
    h.attempts.insert({
      id: 'rec-t3',
      workId: 'work-1',
      checkpointId: 'chk-1',
      kind: 'workflow_node',
      baseDedupeKey: 'workflow_node:nrn-a',
      dedupeKey: 'workflow_node:nrn-a:1',
      idempotencyKey: 'idem-t3',
      attemptNo: 1,
      status: 'starting',
      riskLevel: 'low',
      eligibilityStatus: 'eligible',
      originalWorkStatus: null,
      reopenReason: null,
      operatorConfirmationJson: '{}',
      planHash: 'hash',
      contextManifestJson: JSON.stringify({
        worktree: {
          state: 'ready',
          worktreeId: 'wt-1',
          worktreePath: '/tmp/wt-1',
          branchName: 'agentra/run/task-1/abc-r1',
          newNodeRunId: 'nrn-b',
          worktreeOwnerToken: 'owner-token',
        },
      }),
      executionId: null,
      sessionId: null,
      teamRunId: null,
      nodeRunId: null,
      workflowRunId: 'run-1',
      branchRunId: 'brn-1',
      recoveredNodeRunId: 'nrn-a',
      chainAttemptNo: 1,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null,
      endedAt: null,
    })
    await h.service.convergeAfterT3Failure('rec-t3', 'TEST_T3', true)
    const attempt = h.attempts.get('rec-t3')
    expect(attempt?.status).toBe('failed')
    h.db.close()
  })
})
