import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  type Approval,
  ApprovalListPendingResult,
  PROTOCOL_VERSION,
  RpcResponse,
  WorkflowRunGetResult,
  WorkflowRunStartResult,
} from '@agentra/protocol'
import { agentraPaths } from '@agentra/shared'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const entry = fileURLToPath(new URL('../index.ts', import.meta.url))
const cli = fileURLToPath(new URL('./workflow-agent-fixture.mjs', import.meta.url))
const cleanup: Array<() => Promise<void>> = []
async function rpc(socket: string, method: string, params: unknown = {}) {
  return new Promise<ReturnType<typeof RpcResponse.parse>>((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:`)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`RPC timeout: ${method}`))
    }, 20000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          requestId: `req-${randomUUID()}`,
          protocolVersion: PROTOCOL_VERSION,
          method,
          params,
        }),
      ),
    )
    ws.on('message', (data) => {
      clearTimeout(timer)
      ws.close()
      resolve(RpcResponse.parse(JSON.parse(String(data))))
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
async function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a-loop-'))
  const paths = agentraPaths(home)
  let stderr = ''
  const launch = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: { ...process.env, AGENTRA_DATA_DIR: home, AGENTRA_CLAUDE_PATH: cli },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    return child
  }
  let core = launch()
  const call = (method: string, params: unknown = {}) => rpc(paths.coreSocket, method, params)
  const ok = async (method: string, params: unknown = {}) => {
    const result = await call(method, params)
    if (!result.ok) throw new Error(`${method}: ${result.error.code}: ${result.error.message}`)
    return result.result
  }
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      try {
        if (((await ok('core.maintenance.status')) as { state: string }).state === 'normal') return
      } catch {
        /* socket not bound yet */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`Core not ready: ${stderr}`)
  }
  cleanup.push(async () => {
    await stop(core)
    const pidFile = path.join(paths.runtime, 'daemon.pid')
    if (fs.existsSync(pidFile)) {
      const { pid } = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid: number }
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  await ready()
  return {
    home,
    paths,
    ok,
    call,
    read: () => new DatabaseSync(paths.database, { readOnly: true }),
    restart: async () => {
      await stop(core)
      core = launch()
      await ready()
    },
    diagnostics: () => stderr,
  }
}

afterEach(async () => {
  for (const action of cleanup.splice(0)) await action()
})
async function seed(h: Awaited<ReturnType<typeof harness>>, promptA = 'TASK_A') {
  const { work } = (await h.ok('work.create', {
    name: 'Integration Work',
    rootPath: path.join(h.home, randomUUID()),
  })) as { work: { id: string } }
  await h.ok('work.activate', { id: work.id })
  const { agent } = (await h.ok('agent.create', {
    name: 'Fixture Agent',
    role: 'dev',
    toolPermissions: { version: 1, allow: ['Read'], deny: [] },
  })) as { agent: { id: string } }
  await h.ok('assignment.create', { workId: work.id, agentId: agent.id, workRole: 'dev' })
  const { template } = (await h.ok('workflow.template.create', { name: 'Core business loop' })) as {
    template: { id: string }
  }
  const task = (
    key: string,
    prompt: string,
    artifact: string,
    input?: { nodeKey: string; artifactName: string },
  ) => ({
    key,
    type: 'agent_task',
    config: {
      assignmentSelector: { workRole: 'dev' },
      taskPrompt: prompt,
      artifacts: [{ name: artifact, type: 'text', required: true }],
      inputArtifactRefs: input ? [input] : [],
    },
    position: { x: 0, y: 0 },
  })
  const definition = {
    schemaVersion: 1,
    nodes: [
      { key: 'start', type: 'start', config: {}, position: { x: 0, y: 0 } },
      task('a', promptA, 'spec'),
      task('b', 'TASK_B', 'implementation', { nodeKey: 'a', artifactName: 'spec' }),
      {
        key: 'approval',
        type: 'human_approval',
        config: { target: { nodeKey: 'b', phase: 'after_execute' } },
        position: { x: 0, y: 0 },
      },
      task('c', 'TASK_C', 'final', { nodeKey: 'b', artifactName: 'implementation' }),
      { key: 'end', type: 'end', config: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      ['start', 'a'],
      ['a', 'b'],
      ['b', 'approval'],
      ['approval', 'c'],
      ['c', 'end'],
    ].map(([source, target], i) => ({ key: `e${i}`, source, target })),
  }
  const { version } = (await h.ok('workflow.version.createDraft', {
    templateId: template.id,
    definition,
  })) as { version: { id: string } }
  await h.ok('workflow.version.publish', { versionId: version.id })
  return { workId: work.id, workflowVersionId: version.id, requestId: randomUUID() }
}
async function waitRun(
  h: Awaited<ReturnType<typeof harness>>,
  runId: string,
  predicate: (view: WorkflowRunGetResult) => boolean,
) {
  let view: WorkflowRunGetResult | undefined
  for (let i = 0; i < 200; i++) {
    view = WorkflowRunGetResult.parse(await h.ok('workflow.run.get', { runId }))
    if (predicate(view)) return view
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Run stalled: ${JSON.stringify(view)}\n${h.diagnostics()}`)
}
async function pending(h: Awaited<ReturnType<typeof harness>>, runId: string): Promise<Approval> {
  await waitRun(h, runId, (v) => v.nodes.some((n) => n.status === 'waiting_approval'))
  const result = ApprovalListPendingResult.parse(await h.ok('approval.listPending'))
  const approval = result.approvals.find((a) => a.workflowRunId === runId)
  if (!approval) throw new Error('Pending approval not visible')
  return approval
}

describe('MVP: real Core/Daemon/SQLite/files with deterministic CLI (not model E2E)', () => {
  it('starts once, transfers A→B, survives approval restart, and approves C→End', async () => {
    const h = await harness()
    const request = await seed(h)
    const started = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request))
    expect(WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request)).run.id).toBe(
      started.run.id,
    )
    const approval = await pending(h, started.run.id)
    let db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 2 })
    const versions = db.prepare('SELECT * FROM artifact_versions').all()
    expect(versions).toHaveLength(2)
    for (const row of versions) expect(fs.existsSync(String(row.storage_path))).toBe(true)
    db.close()
    await h.restart()
    expect((await pending(h, started.run.id)).id).toBe(approval.id)
    const decision = {
      nodeRunId: approval.nodeRunId,
      decision: 'approve',
      decidedBy: 'integration-user',
    }
    await h.ok('approval.decide', decision)
    await h.ok('approval.decide', decision)
    const view = await waitRun(h, started.run.id, (v) => v.run.status === 'completed')
    expect(view.nodes.every((n) => n.status === 'succeeded')).toBe(true)
    db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 3 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM artifact_versions').get()).toMatchObject({ c: 3 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM workflow_runs').get()).toMatchObject({ c: 1 })
    db.close()
  }, 90000)

  it('reject leaves its branch paused while a second Work can complete', async () => {
    const h = await harness()
    const one = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', await seed(h)))
    const two = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', await seed(h)))
    const first = await pending(h, one.run.id)
    const second = await pending(h, two.run.id)
    expect(
      (
        await h.call('approval.decide', {
          nodeRunId: first.nodeRunId,
          decision: 'invalid',
          decidedBy: 'tester',
        })
      ).ok,
    ).toBe(false)
    await h.ok('approval.decide', {
      nodeRunId: first.nodeRunId,
      decision: 'reject',
      decidedBy: 'tester',
    })
    await h.ok('approval.decide', {
      nodeRunId: second.nodeRunId,
      decision: 'approve',
      decidedBy: 'tester',
    })
    await waitRun(h, two.run.id, (v) => v.run.status === 'completed')
    const rejected = await waitRun(h, one.run.id, (v) =>
      v.nodes.some((n) => n.status === 'rejected'),
    )
    expect(rejected.branches.some((b) => b.status === 'paused')).toBe(true)
    expect(rejected.nodes.find((n) => n.workflowNodeKey === 'c')?.status).toBe('blocked')
  }, 60000)

  it('request_changes returns the same Approval, creates one rework, then returns for round two', async () => {
    const h = await harness()
    const started = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', await seed(h)))
    const approval = await pending(h, started.run.id)
    const decision = {
      nodeRunId: approval.nodeRunId,
      decision: 'request_changes',
      decidedBy: 'tester',
      comment: 'Revise the implementation',
    }
    expect((await h.call('approval.decide', { ...decision, comment: '' })).ok).toBe(false)
    const first = (await h.ok('approval.decide', decision)) as { approval: Approval }
    expect(first.approval.id).toBe(approval.id)
    expect(first.approval.reworkRequestId).not.toBeNull()
    await h.ok('approval.decide', decision)
    const next = await pending(h, started.run.id)
    expect(next.round).toBe(2)
    expect(next.nodeRunId).not.toBe(approval.nodeRunId)
    await h.ok('approval.decide', {
      nodeRunId: next.nodeRunId,
      decision: 'approve',
      decidedBy: 'tester',
    })
    await waitRun(h, started.run.id, (v) => v.run.status === 'completed')
    const db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM rework_requests').get()).toMatchObject({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM artifact_versions').get()).toMatchObject({ c: 4 })
    db.close()
  }, 60000)

  it('Work pause blocks new starts, preserves approval branch state, and resumes without duplicates', async () => {
    const h = await harness()
    const request = await seed(h)
    const run = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request)).run
    const approval = await pending(h, run.id)
    const branchBefore = (await waitRun(h, run.id, () => true)).branches
    await h.ok('work.pause', { id: request.workId })
    await h.ok('work.pause', { id: request.workId })
    await h.ok('approval.decide', {
      nodeRunId: approval.nodeRunId,
      decision: 'approve',
      decidedBy: 'tester',
    })
    const paused = await waitRun(h, run.id, (v) => v.run.status === 'paused')
    expect(paused.nodes.find((n) => n.workflowNodeKey === 'c')?.status).toBe('blocked')
    expect(branchBefore.some((b) => b.status === 'paused')).toBe(true)
    const db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 2 })
    db.close()
    expect((await h.call('workflow.run.start', { ...request, requestId: randomUUID() })).ok).toBe(
      false,
    )
    await h.restart()
    expect((await waitRun(h, run.id, () => true)).run.status).toBe('paused')
    await h.ok('work.resume', { id: request.workId })
    await h.ok('work.resume', { id: request.workId })
    const completed = await waitRun(h, run.id, (v) => v.run.status === 'completed')
    expect(completed.nodes.every((n) => n.attempt === 1)).toBe(true)
  }, 60000)

  it('Work pause interrupts a running CLI; only explicit resume starts a new attempt', async () => {
    const h = await harness()
    const request = await seed(h, 'TASK_A_PAUSE_ONCE')
    const run = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request)).run
    await waitRun(h, run.id, (v) =>
      v.nodes.some((n) => n.workflowNodeKey === 'a' && n.status === 'running'),
    )
    await h.ok('work.pause', { id: request.workId })
    await h.ok('work.pause', { id: request.workId })
    const paused = await waitRun(h, run.id, (v) =>
      v.nodes.some((n) => n.workflowNodeKey === 'a' && n.status === 'reconciliation_required'),
    )
    expect(paused.run.status).toBe('paused')
    const db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM artifact_versions').get()).toMatchObject({ c: 0 })
    db.close()
    await h.restart()
    expect((await waitRun(h, run.id, () => true)).run.status).toBe('paused')
    await h.ok('work.resume', { id: request.workId })
    const approval = await pending(h, run.id)
    await h.ok('approval.decide', {
      nodeRunId: approval.nodeRunId,
      decision: 'approve',
      decidedBy: 'tester',
    })
    const finished = await waitRun(h, run.id, (v) => v.run.status === 'completed')
    expect(
      finished.nodes
        .filter((n) => n.workflowNodeKey === 'a')
        .map((n) => n.attempt)
        .sort(),
    ).toEqual([1, 2])
    expect(finished.nodes.find((n) => n.workflowNodeKey === 'a' && n.attempt === 2)?.status).toBe(
      'succeeded',
    )
  }, 60000)

  it('Work termination cancels the actual CLI, is idempotent, and remains cancelled after restart', async () => {
    const h = await harness()
    const request = await seed(h, 'HANG')
    const run = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request)).run
    await waitRun(h, run.id, (v) =>
      v.nodes.some((n) => n.status === 'running' && n.workflowNodeKey === 'a'),
    )
    let db = h.read()
    const execution = db
      .prepare("SELECT id, process_id FROM executions WHERE status='running'")
      .get()
    db.close()
    expect(execution).toBeDefined()
    const pid = Number(execution?.process_id)
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 0)
    await h.ok('work.terminate', { id: request.workId })
    await h.ok('work.terminate', { id: request.workId })
    expect(() => process.kill(pid, 0)).toThrow()
    const view = await waitRun(h, run.id, (v) => v.run.status === 'cancelled')
    expect(
      view.nodes
        .filter((n) => n.workflowNodeKey !== 'start')
        .every((n) => n.status === 'cancelled'),
    ).toBe(true)
    expect(view.branches.every((b) => b.status === 'cancelled')).toBe(true)
    db = h.read()
    expect(
      db.prepare('SELECT status FROM executions WHERE id = ?').get(String(execution?.id)),
    ).toMatchObject({ status: 'cancelled' })
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action='work.terminated'").get(),
    ).toMatchObject({ c: 1 })
    db.close()
    expect((await h.call('work.resume', { id: request.workId })).ok).toBe(false)
    expect((await h.call('workflow.run.start', { ...request, requestId: randomUUID() })).ok).toBe(
      false,
    )
    await h.restart()
    expect((await waitRun(h, run.id, () => true)).run.status).toBe('cancelled')
    db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 1 })
    db.close()
  }, 60000)

  it('termination and approval decision race cannot resurrect a Run or affect another Work', async () => {
    const h = await harness()
    const oneRequest = await seed(h)
    const one = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', oneRequest)).run
    const twoRequest = await seed(h)
    const two = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', twoRequest)).run
    const a = await pending(h, one.id)
    const b = await pending(h, two.id)
    const results = await Promise.all([
      h.call('work.terminate', { id: oneRequest.workId }),
      h.call('approval.decide', {
        nodeRunId: a.nodeRunId,
        decision: 'approve',
        decidedBy: 'tester',
      }),
    ])
    expect(results[0]?.ok).toBe(true)
    const cancelled = await waitRun(h, one.id, (v) => v.run.status === 'cancelled')
    expect(cancelled.branches.every((branch) => branch.status === 'cancelled')).toBe(true)
    const countDb = h.read()
    const before = countDb
      .prepare(
        'SELECT COUNT(*) AS c FROM executions e JOIN node_runs n ON n.id=e.node_run_id WHERE n.workflow_run_id=?',
      )
      .get(one.id)
    countDb.close()
    expect(
      (
        await h.call('approval.decide', {
          nodeRunId: a.nodeRunId,
          decision: 'request_changes',
          comment: 'late decision',
          decidedBy: 'tester',
        })
      ).ok,
    ).toBe(false)
    await h.ok('approval.decide', {
      nodeRunId: b.nodeRunId,
      decision: 'approve',
      decidedBy: 'tester',
    })
    await waitRun(h, two.id, (v) => v.run.status === 'completed')
    const db = h.read()
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM executions e JOIN node_runs n ON n.id=e.node_run_id WHERE n.workflow_run_id=?',
        )
        .get(one.id),
    ).toEqual(before)
    const approval = db.prepare('SELECT status FROM approvals WHERE id=?').get(a.id)
    expect(['cancelled', 'approved']).toContain(approval?.status)
    db.close()
  }, 60000)

  it('Work resume never unpauses a rejected approval branch', async () => {
    const h = await harness()
    const request = await seed(h)
    const run = WorkflowRunStartResult.parse(await h.ok('workflow.run.start', request)).run
    const approval = await pending(h, run.id)
    await h.ok('approval.decide', {
      nodeRunId: approval.nodeRunId,
      decision: 'reject',
      decidedBy: 'tester',
    })
    const before = (await waitRun(h, run.id, () => true)).branches
    await h.ok('work.pause', { id: request.workId })
    await h.ok('work.resume', { id: request.workId })
    const after = await waitRun(h, run.id, () => true)
    expect(after.branches).toEqual(before)
    expect(after.nodes.find((n) => n.workflowNodeKey === 'approval')?.status).toBe('rejected')
    expect(after.nodes.find((n) => n.workflowNodeKey === 'c')?.status).toBe('blocked')
    const db = h.read()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions').get()).toMatchObject({ c: 2 })
    db.close()
  }, 60000)
})

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Core did not stop'))
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
