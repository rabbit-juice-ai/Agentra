import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlanDraft } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import {
  PlanCommentRepository,
  PlanRepository,
  PlanThreadRepository,
  PlanVersionRepository,
} from '../db/repositories/plan-repository'
import { PlanService } from './plan-service'

const NOW = '2026-11-06T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-plan-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO works (
      id, name, description, objective, status, priority, root_path, repository_path,
      settings_json, created_at, updated_at, completed_at
    ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)

  const plan = PlanDraft.parse({
    agentraPlanVersion: 1,
    goal: 'build a feature',
    tasks: [
      {
        key: 'frontend',
        title: 'Frontend',
        description: 'build the UI',
        responsibilityRole: 'frontend',
        requiredCapabilities: ['frontend'],
        suggestedAgentId: 'agt-fe',
        outputs: ['ui'],
      },
    ],
  })
  const validation = {
    valid: true,
    violations: [],
    assignments: [{ taskKey: 'frontend', agentId: 'agt-fe', agentName: 'FE Agent' }],
  }
  let definition: unknown = null
  let duringStart: (() => void) | null = null
  let agentProfiles: unknown[] = []
  let workAssignments: unknown[] = []
  const overrides: unknown[] = []
  let exhaustedRequests: unknown[] = []
  let nodeRuns: Record<string, unknown> = {}
  const runtimeListeners: ((event: unknown) => void)[] = []
  const chatStarts: unknown[] = []
  let chatOutput: Record<string, unknown> = { text: 'agent reply' }

  const service = new PlanService({
    db,
    plans: new PlanRepository(db),
    versions: new PlanVersionRepository(db),
    threads: new PlanThreadRepository(db),
    comments: new PlanCommentRepository(db),
    overrides: {
      upsert: (record: unknown) => overrides.push(record),
      get: () => null,
      listByRun: () => [],
    } as never,
    rework: {
      continueExhausted: () => ({ status: 'in_rework', round: 3 }),
      takeOverExhausted: () => ({ status: 'exhausted', round: 3 }),
    } as never,
    reworks: { listByRun: () => exhaustedRequests } as never,
    nodes: { get: (id: string) => nodeRuns[id] ?? null } as never,
    workService: {
      create: (input: { name: string; rootPath: string; projectId?: string }) => {
        const projectId = input.projectId ?? 'prj-default'
        db.prepare(
          `INSERT INTO works (
            id, name, description, objective, status, priority, root_path, repository_path,
            project_id, settings_json, created_at, updated_at, completed_at
          ) VALUES ('work-new', ?, '', '', 'draft', 'normal', ?, NULL, ?, '{}', ?, ?, NULL)`,
        ).run(input.name, input.rootPath, projectId, NOW, NOW)
        return {
          id: 'work-new',
          name: input.name,
          description: '',
          objective: '',
          status: 'draft',
          priority: 'normal',
          rootPath: input.rootPath,
          repositoryPath: null,
          projectId,
          settings: {},
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: null,
        }
      },
    } as never,
    projectService: {
      create: (input: { name: string; description?: string }) => {
        db.prepare(
          `INSERT INTO projects (id, name, description, status, created_at, updated_at)
           VALUES ('prj-new', ?, ?, 'active', ?, ?)`,
        ).run(input.name, input.description ?? '', NOW, NOW)
        return {
          id: 'prj-new',
          name: input.name,
          description: input.description ?? '',
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        }
      },
    } as never,
    hub: {
      subscribe: (listener: (event: unknown) => void) => {
        runtimeListeners.push(listener)
        return () => {}
      },
    } as never,
    chatExecutions: {
      start: async (params: unknown) => {
        chatStarts.push(params)
        return { id: 'exe-chat' }
      },
    } as never,
    extractOutput: () => chatOutput,
    planner: {
      generate: async () => ({
        plan,
        validation,
        plannerExecutionId: null,
        source: 'fallback' as const,
        fallbackReason: 'test',
      }),
    } as never,
    agents: { list: () => agentProfiles } as never,
    assignments: {
      listByWork: () => workAssignments,
      create: (input: { workId: string; agentId: string; workRole: string }) => ({
        id: 'asg-1',
        workId: input.workId,
        agentId: input.agentId,
        teamId: null,
        workRole: input.workRole,
        taskScope: '',
        status: 'active',
        concurrencyLimit: null,
        contextRef: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      resume: (id: string) => ({ id, workRole: 'plan-agt-fe' }),
    } as never,
    works: {
      get: () => ({
        id: 'work-1',
        name: 'Work',
        description: '',
        objective: '',
        status: 'active',
        priority: 'normal',
        rootPath: '/tmp',
        repositoryPath: null,
        projectId: null,
        settings: {},
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      }),
      listTeamIds: () => [],
    } as never,
    runs: {
      get: (id: string) =>
        id === 'run-race'
          ? {
              id: 'run-race',
              workId: 'work-1',
              workflowVersionId: 'wfv-1',
              status: 'running',
              startedAt: NOW,
              endedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            }
          : null,
    },
    workflows: {
      createTemplate: () => ({ id: 'wft-1' }),
      createDraft: (_templateId: string, input: unknown) => {
        definition = input
        return { id: 'wfv-1' }
      },
      publish: () => ({ id: 'wfv-1' }),
    } as never,
    engine: {
      startRun: async () => {
        duringStart?.()
        return {
          run: {
            id: 'run-1',
            workId: 'work-1',
            workflowVersionId: 'wfv-1',
            status: 'running',
            startedAt: NOW,
            endedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          schedulingError: null,
        }
      },
      kick: async () => {},
    } as never,
    now: () => NOW,
  })
  return {
    service,
    db,
    definition: () => definition,
    duringStart: (callback: () => void) => {
      duringStart = callback
    },
    setAgents: (items: unknown[]) => {
      agentProfiles = items
    },
    setWorkAssignments: (items: unknown[]) => {
      workAssignments = items
    },
    setExhausted: (requests: unknown[], nodes: Record<string, unknown>) => {
      exhaustedRequests = requests
      nodeRuns = nodes
    },
    overrides: () => overrides,
    chatStarts: () => chatStarts,
    setChatOutput: (output: Record<string, unknown>) => {
      chatOutput = output
    },
    emitRuntimeEvent: (event: unknown) => {
      for (const listener of runtimeListeners) listener(event)
    },
  }
}

describe('PlanService', () => {
  it('persists a plan, approves it, starts a compiled run, and keeps threads', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    expect(generated.status).toBe('pending_approval')
    expect(generated.planId).toBeTruthy()

    const loaded = h.service.get(generated.planId)
    expect(loaded.plan.status).toBe('pending_approval')
    expect(loaded.threads).toHaveLength(1)
    expect(loaded.threads[0]?.comments[0]?.authorType).toBe('system')

    const approved = h.service.approve(generated.planId, 'boss')
    expect(approved.plan.status).toBe('approved')
    expect(approved.version.status).toBe('approved')

    const started = await h.service.startRun(
      generated.planId,
      '11111111-2222-4333-8444-555555555555',
    )
    expect(started.plan.status).toBe('running')
    expect(started.plan.workflowRunId).toBe('run-1')
    expect(started.run.id).toBe('run-1')
    expect(h.definition()).toMatchObject({
      schemaVersion: 1,
      nodes: expect.arrayContaining([
        expect.objectContaining({ key: 'frontend', type: 'agent_task' }),
      ]),
    })

    const after = h.service.get(generated.planId)
    expect(after.plan.workflowVersionId).toBe('wfv-1')
    expect(
      after.threads[0]?.comments.some((comment) => comment.content.includes('执行已启动')),
    ).toBe(true)
  })

  it('writes task lifecycle events into the matching task thread', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')

    h.service.recordTaskEvent({
      kind: 'started',
      runId: 'run-1',
      nodeKey: 'frontend',
      nodeRunId: 'nrn-1',
      attempt: 1,
      agentId: 'agt-fe',
    })
    h.service.recordTaskEvent({
      kind: 'verification',
      runId: 'run-1',
      nodeKey: 'frontend',
      nodeRunId: 'nrn-1',
      attempt: 1,
      agentId: 'agt-fe',
      passed: false,
      failureReason: 'ui broken',
      relatedTasks: ['frontend'],
    })

    const messages = h.service
      .get(generated.planId)
      .threads.flatMap((thread) => thread.comments.map((comment) => comment.content))
    expect(messages.some((message) => message.includes('开始执行任务「Frontend」'))).toBe(true)
    expect(
      messages.some(
        (message) =>
          message.includes('验收未通过') &&
          message.includes('ui broken') &&
          message.includes('frontend'),
      ),
    ).toBe(true)
  })

  it('keeps task events that arrive before the plan-run mapping is committed', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    h.duringStart(() => {
      h.service.recordTaskEvent({
        kind: 'started',
        runId: 'run-race',
        nodeKey: 'frontend',
        nodeRunId: 'nrn-race',
        attempt: 1,
        agentId: 'agt-fe',
      })
    })

    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')

    const messages = h.service
      .get(generated.planId)
      .threads.flatMap((thread) => thread.comments.map((comment) => comment.content))
    const runStartedIndex = messages.findIndex((message) => message.includes('执行已启动'))
    const taskStartedIndex = messages.findIndex((message) =>
      message.includes('开始执行任务「Frontend」'),
    )
    expect(runStartedIndex).toBeGreaterThanOrEqual(0)
    expect(taskStartedIndex).toBeGreaterThan(runStartedIndex)
  })

  it('reassigns a running task to another active agent with the same role', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')
    h.setAgents([
      {
        id: 'agt-fe',
        name: 'FE Agent',
        status: 'active',
        toolPermissions: { version: 1, allow: ['Read'], deny: [] },
      },
      {
        id: 'agt-fe2',
        name: 'FE Agent 2',
        status: 'active',
        toolPermissions: { version: 1, allow: ['Read'], deny: [] },
      },
    ])
    h.setWorkAssignments([
      { id: 'asg-1', workId: 'work-1', agentId: 'agt-fe', workRole: 'dev', status: 'active' },
      { id: 'asg-2', workId: 'work-1', agentId: 'agt-fe2', workRole: 'dev', status: 'active' },
    ])

    const result = h.service.reassignTask({
      planId: generated.planId,
      taskKey: 'frontend',
      agentId: 'agt-fe2',
      decidedBy: 'boss',
    })

    expect(result).toMatchObject({
      taskKey: 'frontend',
      agentId: 'agt-fe2',
      agentName: 'FE Agent 2',
    })
    expect(h.overrides()).toEqual([
      expect.objectContaining({
        workflowRunId: 'run-1',
        workflowNodeKey: 'frontend',
        agentId: 'agt-fe2',
        assignedBy: 'boss',
      }),
    ])
    const messages = h.service
      .get(generated.planId)
      .threads.flatMap((thread) => thread.comments.map((comment) => comment.content))
    expect(messages.some((message) => message.includes('改派给 Agent「FE Agent 2」'))).toBe(true)
  })

  it('rejects reassignment without an active same-role assignment', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')
    h.setAgents([
      {
        id: 'agt-fe2',
        name: 'FE Agent 2',
        status: 'active',
        toolPermissions: { version: 1, allow: ['Read'], deny: [] },
      },
    ])
    h.setWorkAssignments([
      { id: 'asg-1', workId: 'work-1', agentId: 'agt-fe', workRole: 'dev', status: 'active' },
      { id: 'asg-2', workId: 'work-1', agentId: 'agt-fe2', workRole: 'review', status: 'active' },
    ])

    expect(() =>
      h.service.reassignTask({
        planId: generated.planId,
        taskKey: 'frontend',
        agentId: 'agt-fe2',
        decidedBy: 'boss',
      }),
    ).toThrow(/no "dev" assignment/)
    expect(h.overrides()).toEqual([])
  })

  it('continues an exhausted rework by creating the next round', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')
    h.setExhausted([{ id: 'rwk-1', status: 'exhausted', round: 2, targetNodeRunId: 'nrn-1' }], {
      'nrn-1': { workflowNodeKey: 'frontend' },
    })

    const result = await h.service.continueRework({
      planId: generated.planId,
      taskKey: 'frontend',
      decidedBy: 'boss',
    })
    expect(result).toMatchObject({ taskKey: 'frontend', reworkStatus: 'in_rework', round: 3 })
  })

  it('takes over an exhausted rework and keeps the task thread informed', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.service.approve(generated.planId, 'boss')
    await h.service.startRun(generated.planId, '11111111-2222-4333-8444-555555555555')
    h.setExhausted([{ id: 'rwk-1', status: 'exhausted', round: 2, targetNodeRunId: 'nrn-1' }], {
      'nrn-1': { workflowNodeKey: 'frontend' },
    })

    const result = h.service.takeOverRework({
      planId: generated.planId,
      taskKey: 'frontend',
      decidedBy: 'boss',
    })
    expect(result).toMatchObject({ taskKey: 'frontend', reworkStatus: 'exhausted', round: 3 })
    const messages = h.service
      .get(generated.planId)
      .threads.flatMap((thread) => thread.comments.map((comment) => comment.content))
    expect(messages.some((message) => message.includes('老板已接管任务「Frontend」'))).toBe(true)
  })

  it('notifies a mentioned agent and posts its reply into the task thread', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    h.setAgents([
      {
        id: 'agt-fe',
        name: 'FE Agent',
        status: 'active',
        toolPermissions: { version: 1, allow: ['Read'], deny: [] },
      },
    ])
    h.setWorkAssignments([
      { id: 'asg-1', workId: 'work-1', agentId: 'agt-fe', workRole: 'dev', status: 'active' },
    ])

    const result = await h.service.comment({
      planId: generated.planId,
      taskKey: 'frontend',
      authorId: 'boss',
      content: '@FE Agent 看一下',
      mentions: ['agt-fe'],
    })

    expect(result.comment.authorType).toBe('user')
    expect(h.chatStarts()).toEqual([
      expect.objectContaining({ agentId: 'agt-fe', workId: 'work-1' }),
    ])
    h.emitRuntimeEvent({
      eventType: 'execution.exited',
      aggregateId: 'exe-chat',
      payload: {
        executionId: 'exe-chat',
        sequenceNo: 1,
        exitCode: 0,
        signal: null,
        reason: 'exited',
        timestamp: NOW,
      },
    })
    const thread = h.service
      .get(generated.planId)
      .threads.find((item) => item.thread.taskKey === 'frontend')
    expect(
      thread?.comments.some(
        (comment) => comment.authorType === 'agent' && comment.content === 'agent reply',
      ),
    ).toBe(true)
  })

  it('converts a standalone plan to a task', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build standalone', mode: 'fast' })
    const converted = h.service.convertToTask({
      planId: generated.planId,
      name: '独立任务',
      rootPath: '/tmp/standalone-task',
    })
    expect(converted.plan.workId).toBe('work-new')
    expect(converted.work).toMatchObject({ id: 'work-new', projectId: 'prj-default' })
    expect(h.service.get(generated.planId).plan.workId).toBe('work-new')
  })

  it('converts a standalone plan to a project and task', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build standalone', mode: 'fast' })
    const converted = h.service.convertToProject({
      planId: generated.planId,
      projectName: '独立项目',
      taskName: '独立任务',
      rootPath: '/tmp/standalone-project',
    })
    expect(converted.project).toMatchObject({ id: 'prj-new', name: '独立项目' })
    expect(converted.work).toMatchObject({ id: 'work-new', projectId: 'prj-new' })
    expect(converted.plan.workId).toBe('work-new')
  })

  it('rejects a pending plan and blocks starting it', async () => {
    const h = harness()
    const generated = await h.service.generate({ goal: 'build', workId: 'work-1', mode: 'fast' })
    const rejected = h.service.reject(generated.planId, 'boss', 'not now')
    expect(rejected.plan.status).toBe('rejected')
    expect(
      h.service
        .get(generated.planId)
        .threads[0]?.comments.some((c) => c.content.includes('not now')),
    ).toBe(true)
    await expect(h.service.startRun(generated.planId)).rejects.toThrow(/cannot start run/)
  })
})
