import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile, Execution, RuntimeProviderRecord } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { PlannerMessageRepository } from '../db/repositories/collaboration-repository'
import { ProjectRepository } from '../db/repositories/project-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SkillRepository } from '../db/repositories/skill-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { AgentService, toolPermissionsForAccessMode } from './agent-service'
import { PlannerChatService } from './planner-chat-service'
import { TeamService } from './team-service'

const NOW = '2026-11-07T05:00:00.000Z'
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
    status: 'succeeded',
    workingDirectory: '/tmp',
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
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

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-planner-chat-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const planner = agent('agt-planner', 'analyze')
  const lead = agent('agt-lead', 'analyze')
  db.prepare(
    `INSERT INTO runtime_providers (
      id, provider_type, provider_name, executable_path, version, capabilities_json, health_status,
      last_discovered_at, created_at, updated_at
    ) VALUES ('provider-1', 'cli', 'Test Provider', '/bin/true', '1', ?, 'healthy', ?, ?, ?)`,
  ).run(JSON.stringify(provider().capabilities), NOW, NOW, NOW)
  for (const profile of [planner, lead]) {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
        model, tool_permissions_json, default_provider_id, max_concurrency, status,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, '🤖', '', '', '[]', ?, ?, NULL, ?, 'provider-1', 5, 'active', ?, ?, NULL)`,
    ).run(
      profile.id,
      profile.name,
      profile.accessMode,
      profile.id === 'agt-planner' ? 'planner' : null,
      JSON.stringify(profile.toolPermissions),
      NOW,
      NOW,
    )
  }
  const agents = new AgentRepository(db)
  db.prepare(
    `INSERT INTO works (
      id, name, description, objective, status, priority, root_path, repository_path,
      settings_json, created_at, updated_at, completed_at
    ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
  ).run(NOW, NOW)
  const teams = new TeamRepository(db)
  const projects = new ProjectRepository(db)
  const teamService = new TeamService(db, teams, agents, () => NOW)
  const team = teamService.create({ name: 'Delivery', instructions: 'run tests first' })
  teamService.addMember(team.id, 'agt-lead')
  teamService.update(team.id, { leaderAgentId: 'agt-lead' })

  let output: unknown = {
    reply: '我建议发给交付小队，先做最小闭环。',
    action: {
      type: 'create_team_task',
      teamId: team.id,
      title: '实现备份恢复最小闭环',
      goal: '支持手动备份、导出和恢复预检',
      acceptanceCriteria: ['备份成功', '恢复预检通过'],
      rootPath: '/tmp/agentra-planner-task',
    },
  }
  const executionIds: string[] = []
  const teamTaskCalls: unknown[] = []
  const decisions: unknown[] = []
  const service = new PlannerChatService({
    db,
    messages: new PlannerMessageRepository(db),
    agents,
    teams,
    projects,
    teamService,
    agentService: new AgentService(
      db,
      agents,
      new ProviderRepository(db),
      new SkillRepository(db),
      () => NOW,
    ),
    planner: { ensureAgent: () => planner } as never,
    executions: {
      startSystem: async () => {
        const executionId = `exe-planner-${executionIds.length + 1}`
        executionIds.push(executionId)
        return execution(executionId, 'agt-planner')
      },
      get: (id: string) => execution(id, 'agt-planner'),
      cancel: async ({ executionId }) => execution(executionId, 'agt-planner'),
      list: () => [],
    },
    providers: { list: () => [provider()] },
    extractOutput: () => output as Record<string, unknown>,
    teamTasks: {
      createFromPlanner: async (input) => {
        teamTaskCalls.push(input)
        return { workId: 'work-1' }
      },
    },
    onTeamDecision: async (input) => {
      decisions.push(input)
    },
    now: () => NOW,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  })
  return {
    db,
    service,
    team,
    projects,
    setOutput: (next: unknown) => {
      output = next
    },
    teamTaskCalls,
    decisions,
    executionIds,
  }
}

describe('PlannerChatService', () => {
  it('persists chat, proposes a team task, and applies it only after confirmation', async () => {
    const h = harness()
    const sent = await h.service.send('做一个备份恢复的最小闭环')
    expect(sent.userMessage.authorType).toBe('user')
    expect(sent.plannerMessage.actionStatus).toBe('proposed')
    expect(h.teamTaskCalls).toEqual([])

    const applied = await h.service.applyAction(sent.plannerMessage.id, '/tmp/confirmed-root')
    expect(applied).toMatchObject({ workId: 'work-1', teamId: h.team.id })
    expect(h.teamTaskCalls).toEqual([
      expect.objectContaining({
        teamId: h.team.id,
        title: '实现备份恢复最小闭环',
        rootPath: '/tmp/confirmed-root',
        acceptanceCriteria: ['备份成功', '恢复预检通过'],
        projectId: 'prj-default',
      }),
    ])
    const messages = h.service.listMessages()
    expect(messages[0]?.content).toContain('备份恢复')
    expect(messages.some((message) => message.actionStatus === 'applied')).toBe(true)
    expect(messages.some((message) => message.content.includes('已把任务'))).toBe(true)
  })

  it('passes an explicit project to task creation and rejects unavailable projects', async () => {
    const h = harness()
    h.projects.create({
      id: 'prj-alpha',
      name: 'Alpha',
      description: '',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    h.setOutput({
      reply: '放到 Alpha 项目。',
      action: {
        type: 'create_team_task',
        teamId: h.team.id,
        title: 'Alpha 任务',
        goal: '验证项目归属',
        acceptanceCriteria: ['A 标准'],
        projectId: 'prj-alpha',
      },
    })
    const sent = await h.service.send('放到 Alpha 项目')
    await h.service.applyAction(sent.plannerMessage.id)
    expect(h.teamTaskCalls.at(-1)).toMatchObject({
      projectId: 'prj-alpha',
      acceptanceCriteria: ['A 标准'],
    })

    h.setOutput({
      reply: '这个项目不存在。',
      action: {
        type: 'create_team_task',
        teamId: h.team.id,
        title: '无效项目任务',
        goal: '验证拒绝',
        acceptanceCriteria: [],
        projectId: 'prj-missing',
      },
    })
    const invalid = await h.service.send('放到不存在的项目')
    await expect(h.service.applyAction(invalid.plannerMessage.id)).rejects.toThrow(/not available/)
    expect(h.teamTaskCalls).toHaveLength(1)
  })

  it('rejects a proposed action without creating a task', async () => {
    const h = harness()
    const sent = await h.service.send('讨论一下')
    h.service.rejectAction(sent.plannerMessage.id, '不做了')
    expect(h.teamTaskCalls).toEqual([])
    expect(h.service.listMessages().some((message) => message.actionStatus === 'rejected')).toBe(
      true,
    )
  })

  it('posts team escalations to the Planner room and forwards the decision back', async () => {
    const h = harness()
    h.setOutput({
      reply: '同意先兼容旧版本，接口保留 v1；如果老板不接受，再升级给老板。',
      action: null,
    })
    await h.service.escalateFromTeam({
      workId: 'work-1',
      teamId: h.team.id,
      teamName: 'Delivery',
      workTitle: '备份恢复',
      question: '需要兼容旧版本吗？',
      context: '成员在任务线程里提问',
    })
    const messages = h.service.listMessages()
    expect(messages.some((message) => message.content.includes('团队升级'))).toBe(true)
    expect(messages.some((message) => message.content.includes('兼容旧版本'))).toBe(true)
    expect(h.decisions).toEqual([
      expect.objectContaining({
        workId: 'work-1',
        content: expect.stringContaining('兼容旧版本'),
      }),
    ])
  })

  it('can create the team and its agents directly when the boss confirms', async () => {
    const h = harness()
    h.setOutput({
      reply: '现有团队不够，我建议新建一个俄罗斯方块小队。',
      action: {
        type: 'create_team_with_agents',
        name: '俄罗斯方块联机组',
        instructions: '先做服务端，再做前端，最后联调。',
        leader: {
          name: 'tetris-lead',
          description: '项目负责人',
          systemPrompt: '负责拆解、分派和验收。',
          accessMode: 'analyze',
          defaultProviderId: 'provider-1',
        },
        members: [
          {
            name: 'tetris-dev',
            description: '开发',
            systemPrompt: '负责实现。',
            accessMode: 'edit',
            defaultProviderId: 'provider-1',
          },
          {
            name: 'tetris-qa',
            description: '测试',
            systemPrompt: '负责联调验收。',
            accessMode: 'edit',
            defaultProviderId: 'provider-1',
          },
        ],
      },
    })
    const sent = await h.service.send('帮我建一个俄罗斯方块小队')
    const applied = await h.service.applyAction(sent.plannerMessage.id)
    expect(applied.teamId).toBeTruthy()
    const team = h.db
      .prepare('SELECT id, name, leader_agent_id FROM teams WHERE id = ?')
      .get(applied.teamId) as { id: string; name: string; leader_agent_id: string }
    expect(team.name).toBe('俄罗斯方块联机组')
    expect(team.leader_agent_id).toBeTruthy()
    const agents = h.db
      .prepare('SELECT name, access_mode, default_provider_id FROM agent_profiles ORDER BY name')
      .all() as { name: string; access_mode: string; default_provider_id: string }[]
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tetris-lead',
          access_mode: 'analyze',
          default_provider_id: 'provider-1',
        }),
        expect.objectContaining({ name: 'tetris-dev', access_mode: 'edit' }),
        expect.objectContaining({ name: 'tetris-qa', access_mode: 'edit' }),
      ]),
    )
    const members = h.db
      .prepare('SELECT agent_id FROM team_members WHERE team_id = ?')
      .all(applied.teamId) as { agent_id: string }[]
    expect(members).toHaveLength(3)
  })
})
