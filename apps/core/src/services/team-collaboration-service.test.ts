import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile, Execution, RuntimeProviderRecord } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import {
  TeamTaskMessageRepository,
  TeamTaskRunRepository,
  TeamTaskRunStepRepository,
  TeamTaskSubtaskRepository,
} from '../db/repositories/collaboration-repository'
import { ProjectRepository } from '../db/repositories/project-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { AssignmentService } from './assignment-service'
import type { CheckpointService } from './checkpoint-service'
import { TaskMemoryService } from './task-memory-service'
import { TeamCollaborationService } from './team-collaboration-service'
import { TeamService } from './team-service'
import { WorkService } from './work-service'

const NOW = '2026-11-07T06:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function agent(id: string, accessMode: AgentProfile['accessMode']): AgentProfile {
  return {
    id,
    name: id,
    avatar: '🤖',
    description: '',
    systemPrompt: '',
    skillIds: [],
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: 'provider-1',
    maxConcurrency: 5,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }
}

function execution(id: string, agentId: string): Execution {
  return {
    id,
    sessionId: `ses-${id}`,
    providerId: 'provider-1',
    agentId,
    externalExecutionId: null,
    processId: null,
    status: 'running',
    workingDirectory: '/tmp',
    startedAt: NOW,
    endedAt: null,
    exitCode: null,
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function provider(): RuntimeProviderRecord {
  return {
    id: 'provider-1',
    providerType: 'cli',
    providerName: 'Test Provider',
    executablePath: '/bin/true',
    version: '1',
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'unsupported',
      checkpoint: 'unsupported',
      permissionRequests: 'unsupported',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    healthStatus: 'healthy',
    authMethod: null,
    healthDetail: null,
    lastDiscoveredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function harness(options: { checkpoints?: Pick<CheckpointService, 'createForExecution'> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-team-collab-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  db.prepare(
    `INSERT INTO runtime_providers (
      id, provider_type, provider_name, executable_path, version, capabilities_json, health_status,
      last_discovered_at, created_at, updated_at
    ) VALUES ('provider-1', 'cli', 'Test Provider', '/bin/true', '1', ?, 'healthy', ?, ?, ?)`,
  ).run(JSON.stringify(provider().capabilities), NOW, NOW, NOW)
  for (const profile of [agent('agt-leader', 'analyze'), agent('agt-member', 'edit')]) {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
        model, tool_permissions_json, default_provider_id, max_concurrency, status,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, '🤖', '', '', '[]', ?, NULL, NULL, ?, 'provider-1', 5, 'active', ?, ?, NULL)`,
    ).run(
      profile.id,
      profile.name,
      profile.accessMode,
      JSON.stringify(profile.toolPermissions),
      NOW,
      NOW,
    )
  }
  const agentRepository = new AgentRepository(db)
  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const auditRepository = new AuditRepository(db)
  const taskMemoryService = new TaskMemoryService({
    db,
    memories: new TaskMemoryRepository(db),
    audit: auditRepository,
    now: () => NOW,
  })
  const teamService = new TeamService(db, teamRepository, agentRepository, () => NOW)
  const team = teamService.create({ name: 'Delivery', instructions: 'run tests first' })
  teamService.addMember(team.id, 'agt-leader')
  teamService.addMember(team.id, 'agt-member')
  teamService.update(team.id, { leaderAgentId: 'agt-leader' })
  const assignmentService = new AssignmentService(
    db,
    assignmentRepository,
    workRepository,
    agentRepository,
    teamRepository,
    new SessionRepository(db),
    () => NOW,
  )
  const workService = new WorkService(
    db,
    workRepository,
    teamRepository,
    auditRepository,
    () => NOW,
    undefined,
    new ProjectRepository(db),
    taskMemoryService,
  )
  const messages = new TeamTaskMessageRepository(db)
  const subtasks = new TeamTaskSubtaskRepository(db)
  const runs = new TeamTaskRunRepository(db)
  const steps = new TeamTaskRunStepRepository(db)
  const outputs = new Map<string, Record<string, unknown>>()
  const executionLogs = new Map<
    string,
    Array<{ stream: string; content: string; timestamp: string }>
  >()
  const started: Execution[] = []
  const startPrompts: { agentId: string; prompt: string }[] = []
  const sentMessages: { executionId: string; message: string }[] = []
  const plannerCalls: unknown[] = []
  let runtimeListener: ((event: unknown) => void) | null = null
  let executionSeq = 0
  const service = new TeamCollaborationService({
    db,
    works: workService,
    workRepository,
    teams: teamRepository,
    agents: agentRepository,
    assignments: assignmentService,
    taskMemories: taskMemoryService,
    checkpoints: options.checkpoints,
    executions: {
      start: async ({ agentId, prompt }) => {
        const item = execution(`exe-member-${++executionSeq}`, agentId as string)
        started.push(item)
        startPrompts.push({ agentId: agentId as string, prompt })
        return item
      },
      startSystem: async ({ agentId, prompt }) => {
        const item = execution(`exe-leader-${++executionSeq}`, agentId as string)
        started.push(item)
        startPrompts.push({ agentId: agentId as string, prompt })
        return item
      },
      get: (id: string) => started.find((item) => item.id === id) ?? execution(id, 'unknown'),
      list: () => started,
      cancel: async ({ executionId }) => {
        const item =
          started.find((candidate) => candidate.id === executionId) ??
          execution(executionId, 'unknown')
        return item
      },
      sendMessage: async (params) => {
        sentMessages.push(params)
        return { sent: true }
      },
    },
    providers: { list: () => [provider()] },
    extractOutput: (id) => outputs.get(id) ?? { text: 'done' },
    executionLogs: {
      list: (executionId, after = 0, limit = 1000) =>
        (executionLogs.get(executionId) ?? []).slice(after, after + limit).map((log, index) => ({
          id: `log-${after + index + 1}`,
          executionId,
          sequenceNo: after + index + 1,
          stream: log.stream,
          content: log.content,
          timestamp: log.timestamp,
        })) as never,
    },
    messages,
    subtasks,
    runs,
    steps,
    hub: {
      subscribe: (listener) => {
        runtimeListener = listener as (event: unknown) => void
        return () => {
          runtimeListener = null
        }
      },
    },
    planner: {
      escalateFromTeam: async (input) => {
        plannerCalls.push(input)
      },
    },
    now: () => NOW,
  })
  return {
    db,
    service,
    team,
    workService,
    workRepository,
    messages,
    subtasks,
    runs,
    steps,
    started,
    startPrompts,
    taskMemoryService,
    sentMessages,
    plannerCalls,
    setOutput: (executionId: string, output: Record<string, unknown>) => {
      outputs.set(executionId, output)
    },
    addLog: (executionId: string, stream: string, content: string, timestamp = NOW) => {
      const logs = executionLogs.get(executionId) ?? []
      logs.push({ stream, content, timestamp })
      executionLogs.set(executionId, logs)
    },
    emitOutput: (executionId: string, content: string) => {
      runtimeListener?.({
        eventId: `evt-${Math.random().toString(36).slice(2, 12)}`,
        protocolVersion: '1',
        eventType: 'execution.output',
        occurredAt: NOW,
        aggregateType: 'execution',
        aggregateId: executionId,
        payload: {
          executionId,
          sequenceNo: 1,
          stream: 'structured',
          content,
          timestamp: NOW,
        },
        correlationId: null,
      })
    },
  }
}

describe('TeamCollaborationService', () => {
  it('runs leader split -> member execution -> leader review, then enters review status', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '实现备份恢复',
      goal: '完成最小闭环',
      description: '实现备份、导出和恢复预检',
      acceptanceCriteria: ['备份成功', '恢复预检通过'],
      rootPath: '/tmp/agentra-team-task',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.setOutput(leaderRun.executionId as string, {
      reply: '我拆成实现和验收。',
      subtasks: [{ title: '实现备份', description: '实现导出', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: '先做最小闭环',
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    expect(
      h.messages
        .listByWork(workId)
        .some(
          (message) =>
            message.content.startsWith('@agt-member') &&
            message.content.includes('这个交给你') &&
            typeof message.metadata.subtaskId === 'string',
        ),
    ).toBe(true)
    expect(
      h.messages
        .listByWork(workId)
        .some(
          (message) =>
            message.authorType === 'member' && message.content.startsWith('收到，@agt-leader'),
        ),
    ).toBe(true)
    expect(h.subtasks.listByWork(workId)).toEqual([
      expect.objectContaining({
        title: '实现备份',
        assigneeAgentId: 'agt-member',
        status: 'running',
      }),
    ])
    h.emitOutput(
      memberRun.executionId as string,
      JSON.stringify({
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls -la', description: '查看目录' },
      }),
    )
    expect(h.steps.listByRun(memberRun.id)).toEqual([
      expect.objectContaining({
        name: 'Bash',
        stepKey: 'tool-1',
        summary: expect.stringContaining('ls -la'),
      }),
    ])
    h.setOutput(memberRun.executionId as string, {
      reply: '备份已经实现，测试通过。',
      blocked: false,
      question: null,
    })
    await h.service.onExecutionTerminal(memberRun.executionId as string, 'succeeded')
    expect(
      h.messages
        .listByWork(workId)
        .some(
          (message) =>
            message.authorType === 'member' &&
            message.content.startsWith('@agt-leader 已完成「实现备份」，请查收。') &&
            message.content.includes('备份已经实现'),
        ),
    ).toBe(true)
    const reviewRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'leader' && run.executionId ? run : null
    })
    const subtask = h.subtasks.listByWork(workId)[0]
    expect(subtask?.status).toBe('review')
    expect(
      h.messages
        .listByWork(workId)
        .some(
          (message) =>
            message.authorType === 'leader' &&
            message.content.startsWith('收到，@agt-member。「实现备份」我来验收。'),
        ),
    ).toBe(true)
    h.setOutput(reviewRun.executionId as string, {
      reply: '验收通过。',
      subtasks: [],
      completeSubtaskIds: [subtask?.id],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(reviewRun.executionId as string, 'succeeded')
    expect(h.subtasks.listByWork(workId)[0]?.status).toBe('done')
    expect(h.workRepository.get(workId)?.issueStatus).toBe('review')
    expect(h.messages.listByWork(workId).map((message) => message.authorType)).toEqual(
      expect.arrayContaining(['leader', 'member']),
    )
  })

  it('blocks queued team runs when checkpoint policy blocks', async () => {
    let blocked = false
    const calls: string[] = []
    const h = harness({
      checkpoints: {
        createForExecution: (executionId) => {
          calls.push(executionId)
          return {
            outcome: 'created',
            checkpointId: 'chk-1',
            blocked,
            riskLevel: blocked ? 'high' : 'low',
            evidenceStatus: blocked ? 'invalid' : 'not_required',
            sideEffectCompleteness: 'not_tracked',
            reasons: blocked ? ['RISK_TOO_HIGH'] : [],
          }
        },
      },
    })
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: 'Checkpoint gate',
      goal: 'verify blocking',
      description: '',
      acceptanceCriteria: ['done'],
      rootPath: '/tmp/agentra-team-checkpoint-gate',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.setOutput(leaderRun.executionId as string, {
      reply: 'assign',
      subtasks: [{ title: 'implement', description: '', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    blocked = true
    h.setOutput(memberRun.executionId as string, {
      reply: 'implemented',
      blocked: false,
      question: null,
    })
    await h.service.onExecutionTerminal(memberRun.executionId as string, 'succeeded')

    expect(calls).toContain(memberRun.executionId)
    expect(h.runs.getActiveByWork(workId)).toBeNull()
    expect(
      h.messages
        .listByWork(workId)
        .some((message) => message.content.includes('Checkpoint 未通过')),
    ).toBe(true)
  })

  it('injects formal criteria and Task Memory into prompts and refreshes before a new run', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '验收标准注入',
      goal: '验证 Prompt',
      description: '',
      acceptanceCriteria: ['备份成功', '恢复预检通过'],
      rootPath: '/tmp/agentra-team-task-criteria',
    })
    expect(h.workRepository.get(workId)?.acceptanceCriteria).toEqual(['备份成功', '恢复预检通过'])
    expect(h.taskMemoryService.get(workId)?.acceptanceCriteria.items).toHaveLength(2)
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    const firstLeaderPrompt = h.startPrompts.find((entry) => entry.agentId === 'agt-leader')?.prompt
    expect(firstLeaderPrompt).toContain('Formal acceptance criteria (Work v1):')
    expect(firstLeaderPrompt).toContain('- 备份成功')
    expect(firstLeaderPrompt).toContain(`Acceptance criteria (Work v1):`)
    expect(firstLeaderPrompt).toContain(`- [verified] 备份成功 (source: work:${workId})`)

    h.setOutput(leaderRun.executionId as string, {
      reply: '我拆一个子任务。',
      subtasks: [{ title: '实现备份', description: '实现导出', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    const memberPrompt = h.startPrompts.find((entry) => entry.agentId === 'agt-member')?.prompt
    expect(memberPrompt).toContain('Formal acceptance criteria (Work v1):')
    expect(memberPrompt).toContain('- 备份成功')
    expect(memberPrompt).toContain('Task memory (relevant slice):')
    expect(memberPrompt).toContain('Subtask: 实现备份')

    h.setOutput(memberRun.executionId as string, {
      reply: '备份已经实现。',
      blocked: false,
      question: null,
    })
    await h.service.onExecutionTerminal(memberRun.executionId as string, 'succeeded')
    const reviewRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'leader' && run.executionId ? run : null
    })
    const subtask = h.subtasks.listByWork(workId)[0]
    h.setOutput(reviewRun.executionId as string, {
      reply: '验收通过。',
      subtasks: [],
      completeSubtaskIds: [subtask?.id],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(reviewRun.executionId as string, 'succeeded')

    expect(h.workRepository.updateAcceptanceCriteria(workId, 1, ['新标准'], 2, NOW, NOW)).toBe(true)
    await h.service.comment({
      workId,
      content: '请按新标准复核。',
      authorId: 'local-user',
      mentions: ['agt-leader'],
    })
    await waitFor(() => h.runs.getActiveByWork(workId)?.executionId ?? null)
    const latestLeaderPrompt = h.startPrompts
      .filter((entry) => entry.agentId === 'agt-leader')
      .at(-1)?.prompt
    expect(latestLeaderPrompt).toContain('Formal acceptance criteria (Work v2):')
    expect(latestLeaderPrompt).toContain('- 新标准')
    expect(latestLeaderPrompt).toContain('Acceptance criteria (Work v2):')
    expect(h.taskMemoryService.get(workId)?.acceptanceCriteria.workVersion).toBe(2)
    expect(h.taskMemoryService.get(workId)?.acceptanceCriteria.items[0]?.statement).toBe('新标准')
  })

  it('escalates a leader decision to Planner and writes the Planner decision back', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '接口兼容',
      goal: '决定兼容策略',
      description: '',
      acceptanceCriteria: [],
      rootPath: '/tmp/agentra-team-task-2',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.setOutput(leaderRun.executionId as string, {
      reply: '这个兼容策略超出我的权限。',
      subtasks: [],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: true,
      plannerQuestion: '是否需要兼容旧版本？',
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    expect(h.plannerCalls).toEqual([
      expect.objectContaining({ workId, question: '是否需要兼容旧版本？' }),
    ])
    h.service.onPlannerDecision(workId, '保留 v1，新增 v2。')
    expect(
      h.messages
        .listByWork(workId)
        .some((message) => message.authorType === 'planner' && message.content.includes('v1')),
    ).toBe(true)
    const next = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'leader' && run.executionId ? run : null
    })
    expect(next.executionId).toBeTruthy()
  })

  it('injects steer messages and queues normal comments while a run is active', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '协作线程',
      goal: '测试 steering',
      description: '',
      acceptanceCriteria: [],
      rootPath: '/tmp/agentra-team-task-3',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    const steered = await h.service.comment({
      workId,
      content: '先跑现有测试',
      authorId: 'boss',
      mode: 'steer',
    })
    expect(steered.run?.id).toBe(leaderRun.id)
    expect(h.sentMessages).toEqual([
      { executionId: leaderRun.executionId, message: '先跑现有测试' },
    ])
    expect(h.runs.getActiveByWork(workId)?.status).toBe('running')
    expect(h.runs.getQueuedByWork(workId)).toBeNull()
    const queued = await h.service.comment({
      workId,
      content: '完成后告诉我',
      authorId: 'boss',
      mode: 'normal',
    })
    expect(queued.run?.status).toBe('queued')
    const skipped = await h.service.comment({
      workId,
      content: '只是备注',
      authorId: 'boss',
      mode: 'skip',
    })
    expect(skipped.run).toBeNull()
  })

  it('backfills member reports that were stored as the old fallback text', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '历史报告修复',
      goal: '恢复成员报告',
      description: '',
      acceptanceCriteria: [],
      rootPath: '/tmp/agentra-team-task-4',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.setOutput(leaderRun.executionId as string, {
      reply: '拆解完成。',
      subtasks: [{ title: '实现', description: '', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    h.setOutput(memberRun.executionId as string, {
      reply: '真实成员报告：已完成实现并自测通过。',
      blocked: false,
      question: null,
    })
    h.messages.insert({
      id: 'msg-fallback',
      workId,
      authorType: 'member',
      authorId: 'agt-member',
      content: '成员已完成本轮处理。',
      kind: 'message',
      metadata: { runId: memberRun.id, executionId: memberRun.executionId },
      executionId: memberRun.executionId,
      createdAt: NOW,
    })
    expect(h.service.backfillMemberReports()).toBe(1)
    expect(h.messages.get('msg-fallback')?.content).toBe('真实成员报告：已完成实现并自测通过。')
  })

  it('backfills tool steps for historical member runs from execution logs', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '历史运行日志修复',
      goal: '恢复 Bash/Read 步骤',
      description: '',
      acceptanceCriteria: [],
      rootPath: '/tmp/agentra-team-task-5',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.setOutput(leaderRun.executionId as string, {
      reply: '拆解完成。',
      subtasks: [{ title: '实现', description: '', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    h.addLog(
      memberRun.executionId as string,
      'structured',
      JSON.stringify({
        type: 'tool_use',
        id: 'tool-old-1',
        name: 'Bash',
        input: { command: 'ls -la', description: '查看目录' },
      }),
    )
    h.addLog(memberRun.executionId as string, 'stdout', 'ignored stdout')
    expect(h.service.backfillRunSteps()).toBe(1)
    expect(h.steps.listByRun(memberRun.id)).toEqual([
      expect.objectContaining({
        name: 'Bash',
        stepKey: 'tool-old-1',
        summary: expect.stringContaining('ls -la'),
      }),
    ])
  })

  it('starts team runs even when the work lifecycle is completed', async () => {
    const h = harness()
    const { workId } = await h.service.createFromPlanner({
      teamId: h.team.id,
      title: '完成任务继续执行',
      goal: '验证不再被生命周期门控',
      description: '',
      acceptanceCriteria: [],
      rootPath: '/tmp/agentra-team-task-6',
    })
    const leaderRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.executionId ? run : null
    })
    h.workService.complete(workId)
    h.setOutput(leaderRun.executionId as string, {
      reply: '拆解完成。',
      subtasks: [{ title: '实现', description: '', assigneeAgentId: 'agt-member' }],
      completeSubtaskIds: [],
      decision: null,
      escalateToPlanner: false,
      plannerQuestion: null,
    })
    await h.service.onExecutionTerminal(leaderRun.executionId as string, 'succeeded')
    const memberRun = await waitFor(() => {
      const run = h.runs.getActiveByWork(workId)
      return run?.role === 'member' && run.executionId ? run : null
    })
    expect(memberRun.status).toBe('running')
    expect(
      h.messages.listByWork(workId).some((message) => message.content.includes('任务未激活')),
    ).toBe(false)
  })
})
