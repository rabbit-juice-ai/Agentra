import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { ExecutionRepository } from '../db/repositories/execution-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { ProviderRegistry } from '../services/provider-registry'
import { WorkdirLockService } from '../services/workdir-lock-service'
import { WorkflowAssignmentResolver } from './assignment-resolver'
import type { DispatchContext } from './dispatch-gates'
import {
  createAgentCapacityPort,
  createProviderAvailabilityPort,
  createWorkdirAvailabilityPort,
} from './ports'

const NOW = '2026-11-01T00:00:00.000Z'
const BOOT = { status: 'known' as const, uuid: '11111111-1111-4111-8111-111111111111' }
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): { db: Database; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-ports-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (id, name, description, objective, status, priority, root_path,
       repository_path, settings_json, created_at, updated_at, completed_at)
     VALUES ('work-1', 'W', '', '', 'active', 'normal', '/tmp/w', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO agent_profiles (id, name, avatar, description, system_prompt, skill_ids_json,
       access_mode, system_kind, default_provider_id, max_concurrency, status, created_at, updated_at, archived_at,
       tool_permissions_json)
     VALUES ('agent-1', 'A', '🤖', '', '', '[]', 'edit', NULL, NULL, 1, 'active', ?, ?, NULL,
       '{"version":1,"allow":["Read"],"deny":[]}')`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO assignments (id, work_id, agent_id, team_id, work_role, task_scope, status,
       concurrency_limit, context_ref, created_at, updated_at)
     VALUES ('as-1', 'work-1', 'agent-1', NULL, 'dev', '', 'active', NULL, NULL, ?, ?)`,
  ).run(NOW, NOW)
  return { db, close: () => db.close() }
}

function context(
  node: Record<string, unknown> = {
    type: 'agent_task',
    config: { assignmentSelector: { workRole: 'dev' }, workingDirectoryPolicy: 'work_root' },
  },
): DispatchContext {
  return {
    run: { workId: 'work-1' } as never,
    node: node as never,
    nodeRun: {} as never,
    branch: {} as never,
    branchKey: 'root',
    definition: {} as never,
  }
}

function seedExecution(db: Database, id: string, status: string): void {
  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json,
       health_status, created_at, updated_at)
     VALUES ('prov-1', 'cli', 'claude', ?, 'healthy', ?, ?)`,
  ).run(
    '{"streaming":"native","structuredEvents":"native","interrupt":"native","resume":"native","checkpoint":"unsupported","permissionRequests":"unsupported","sessionPersistence":"native","workingDirectory":"native","toolControl":"native"}',
    NOW,
    NOW,
  )
  db.prepare(
    `INSERT INTO agent_sessions (id, assignment_id, provider_id, external_session_id,
       context_ref, status, created_at, updated_at, last_active_at)
     VALUES ('ses-1', NULL, 'prov-1', NULL, 'agent-1', 'active', ?, ?, NULL)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO executions (id, session_id, node_run_id, provider_id, status, working_directory,
       capabilities_snapshot_json, created_at, updated_at)
     VALUES (?, 'ses-1', NULL, 'prov-1', ?, '/tmp/w', '{}', ?, ?)`,
  ).run(id, status, NOW, NOW)
}

describe('AgentCapacityPort', () => {
  it('reports capacity from the agent concurrency limit', () => {
    const { db, close } = setup()
    try {
      seedExecution(db, 'exe-1', 'running')
      const port = createAgentCapacityPort({
        resolver: new WorkflowAssignmentResolver(new AssignmentRepository(db)),
        agents: new AgentRepository(db),
        executions: new ExecutionRepository(db),
      })
      expect(port.hasCapacity(context())).toBe(false)
      db.prepare("UPDATE executions SET status = 'succeeded' WHERE id = 'exe-1'").run()
      expect(port.hasCapacity(context())).toBe(true)
    } finally {
      close()
    }
  })
})

describe('ProviderAvailabilityPort', () => {
  it('reflects provider health', () => {
    const { db, close } = setup()
    try {
      seedExecution(db, 'exe-1', 'succeeded')
      const registry = new ProviderRegistry(new ProviderRepository(db), {} as never)
      const port = createProviderAvailabilityPort(registry)
      expect(port.isAvailable(context())).toBe(true)
      db.prepare(
        "UPDATE runtime_providers SET health_status = 'unavailable' WHERE id = 'prov-1'",
      ).run()
      expect(port.isAvailable(context())).toBe(false)
    } finally {
      close()
    }
  })
})

describe('WorkdirAvailabilityPort', () => {
  it('blocks work_root while the directory is locked and allows worktree', () => {
    const { db, close } = setup()
    try {
      const locks = new WorkdirLockService(db, () => NOW, process.pid, BOOT)
      const port = createWorkdirAvailabilityPort({ works: new WorkRepository(db), locks })
      const workRoot = context()
      expect(port.isAvailable(workRoot)).toBe(true)

      locks.acquire('/tmp/w', 'exe-other', 'work-1')
      expect(port.isAvailable(workRoot)).toBe(false)

      const worktreeNode = context({
        type: 'agent_task',
        config: {
          assignmentSelector: { workRole: 'dev' },
          workingDirectoryPolicy: 'worktree',
        },
      })
      expect(port.isAvailable(worktreeNode)).toBe(true)
      locks.releaseByExecution('exe-other')
      expect(port.isAvailable(workRoot)).toBe(true)
    } finally {
      close()
    }
  })
})
