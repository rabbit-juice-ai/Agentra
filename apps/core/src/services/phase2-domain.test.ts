import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { ProviderRepository } from '../db/repositories/provider-repository'
import { SessionRepository } from '../db/repositories/session-repository'
import { SkillRepository } from '../db/repositories/skill-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { AgentService } from './agent-service'
import { AssignmentService } from './assignment-service'
import { TeamService } from './team-service'
import { WorkService } from './work-service'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-p2-'))
  dirs.push(dir)
  const db: Database = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)

  db.prepare(
    `INSERT INTO runtime_providers (id, provider_type, provider_name, capabilities_json, health_status, created_at, updated_at)
     VALUES ('claude-code', 'cli', 'Claude Code', ?, 'healthy', ?, ?)`,
  ).run(
    JSON.stringify({
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'native',
      checkpoint: 'unsupported',
      permissionRequests: 'native',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    }),
    NOW,
    NOW,
  )

  const agentRepository = new AgentRepository(db)
  const providerRepository = new ProviderRepository(db)
  const skillRepository = new SkillRepository(db)
  const agents = new AgentService(
    db,
    agentRepository,
    providerRepository,
    skillRepository,
    () => NOW,
  )
  const agent = agents.create({ name: 'Worker', defaultProviderId: 'claude-code' })
  const otherAgent = agents.create({ name: 'Reviewer', defaultProviderId: 'claude-code' })

  const teamRepository = new TeamRepository(db)
  const workRepository = new WorkRepository(db)
  const auditRepository = new AuditRepository(db)
  const assignmentRepository = new AssignmentRepository(db)
  const sessionRepository = new SessionRepository(db)

  return {
    db,
    agent,
    otherAgent,
    agentRepository,
    skillRepository,
    agents,
    teams: new TeamService(db, teamRepository, agentRepository, () => NOW),
    works: new WorkService(db, workRepository, teamRepository, auditRepository, () => NOW),
    assignments: new AssignmentService(
      db,
      assignmentRepository,
      workRepository,
      agentRepository,
      teamRepository,
      sessionRepository,
      () => NOW,
    ),
    audit: auditRepository,
    sessions: sessionRepository,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('AgentService', () => {
  it('defaults to analyze access and re-derives tools when access mode changes', () => {
    const h = harness()
    expect(h.agent.accessMode).toBe('analyze')
    expect(h.agent.skillIds).toEqual([])

    const created = h.agents.create({
      name: 'Frontend Agent',
      defaultProviderId: 'claude-code',
      accessMode: 'edit',
      model: 'sonnet',
    })
    expect(created.accessMode).toBe('edit')
    expect(created.toolPermissions.allow).toContain('Write')
    expect(created.model).toBe('sonnet')

    const updated = h.agents.update({
      id: created.id,
      accessMode: 'analyze',
      model: 'haiku',
    })
    expect(updated.accessMode).toBe('analyze')
    expect(updated.toolPermissions.deny).toContain('Write')
    expect(updated.model).toBe('haiku')
    expect(h.agents.get(created.id).accessMode).toBe('analyze')
    expect(h.agents.get(created.id).model).toBe('haiku')
  })

  it('binds only existing skills from the global library', () => {
    const h = harness()
    h.skillRepository.insert({
      id: 'skl-1',
      name: 'React',
      description: '',
      instructions: 'Use hooks.',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const created = h.agents.create({
      name: 'Skilled Agent',
      defaultProviderId: 'claude-code',
      skillIds: ['skl-1', 'skl-1'],
    })
    expect(created.skillIds).toEqual(['skl-1'])
    expect(() =>
      h.agents.create({
        name: 'Ghost Agent',
        defaultProviderId: 'claude-code',
        skillIds: ['skl-missing'],
      }),
    ).toThrow(expect.objectContaining({ code: 'SKILL_NOT_FOUND' }))
  })
})

describe('TeamService', () => {
  it('creates, lists and archives teams', () => {
    const h = harness()
    const team = h.teams.create({
      name: '  Alpha  ',
      description: 'core team',
      instructions: '  先写测试  ',
    })
    expect(team).toMatchObject({
      name: 'Alpha',
      status: 'active',
      archivedAt: null,
      instructions: '先写测试',
    })
    expect(h.teams.list().map((item) => item.id)).toContain(team.id)

    const archived = h.teams.archive(team.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBe(NOW)
    expect(h.teams.list().map((item) => item.id)).not.toContain(team.id)
    expect(h.teams.list(true).map((item) => item.id)).toContain(team.id)
  })

  it('updates name, description and instructions; archived teams are read-only', () => {
    const h = harness()
    const team = h.teams.create({ name: 'Alpha' })
    const updated = h.teams.update(team.id, {
      name: 'Beta',
      description: 'new desc',
      instructions: '前端先跑测试',
    })
    expect(updated).toMatchObject({
      name: 'Beta',
      description: 'new desc',
      instructions: '前端先跑测试',
    })
    expect(h.teams.get(team.id).instructions).toBe('前端先跑测试')
    expect(() => h.teams.update(team.id, { name: '   ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    h.teams.archive(team.id)
    expect(() => h.teams.update(team.id, { instructions: 'x' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('rejects blank names and unknown teams', () => {
    const h = harness()
    expect(() => h.teams.create({ name: '   ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    expect(() => h.teams.get('team-missing')).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('manages members and rejects duplicates / unknown agents / archived teams', () => {
    const h = harness()
    const team = h.teams.create({ name: 'Alpha' })

    const member = h.teams.addMember(team.id, h.agent.id)
    expect(member).toMatchObject({ teamId: team.id, agentId: h.agent.id })

    expect(() => h.teams.addMember(team.id, h.agent.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    expect(() => h.teams.addMember(team.id, 'agt-missing')).toThrow(
      expect.objectContaining({ code: 'AGENT_NOT_FOUND' }),
    )

    h.teams.archive(team.id)
    expect(() => h.teams.addMember(team.id, h.otherAgent.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    expect(() => h.teams.removeMember(team.id, h.otherAgent.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })
})

describe('WorkService 状态机', () => {
  it('walks the legal path draft → active → paused → active → completed → archived', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    expect(work.status).toBe('draft')

    expect(h.works.activate(work.id).status).toBe('active')
    expect(h.works.pause(work.id).status).toBe('paused')
    expect(h.works.resume(work.id).status).toBe('active')

    const completed = h.works.complete(work.id)
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBe(NOW)

    expect(h.works.archive(work.id).status).toBe('archived')
  })

  it('rejects illegal transitions', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })

    // draft 不能直接 pause / resume / complete
    for (const action of ['pause', 'resume', 'complete'] as const) {
      expect(() => h.works[action](work.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      )
    }

    h.works.activate(work.id)
    h.works.complete(work.id)
    // completed 是终态前置：不能回到 active / paused
    for (const action of ['activate', 'pause', 'resume'] as const) {
      expect(() => h.works[action](work.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      )
    }

    h.works.archive(work.id)
    // archived 不可再迁移
    for (const action of ['activate', 'pause', 'complete', 'terminate'] as const) {
      expect(() => h.works[action](work.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      )
    }
  })

  it('terminate is irreversible and writes an audit log', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    h.works.activate(work.id)

    const terminated = h.works.terminate(work.id)
    expect(terminated.status).toBe('cancelled')
    expect(terminated.completedAt).toBe(NOW)

    const audit = h.audit.listByTarget('work', work.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'work.terminated', actorType: 'user' })
    expect(audit[0]?.details).toEqual({ from: 'active', to: 'cancelled' })

    // cancelled 只能归档，不能恢复
    expect(() => h.works.activate(work.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    expect(() => h.works.resume(work.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('links teams only to non-archived works and active teams', () => {
    const h = harness()
    const team = h.teams.create({ name: 'Alpha' })
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })

    h.works.linkTeam(work.id, team.id)
    expect(h.works.listTeamIds(work.id)).toEqual([team.id])
    expect(() => h.works.linkTeam(work.id, 'team-missing')).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    h.teams.archive(team.id)
    expect(() => h.works.linkTeam(work.id, team.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('keeps a team-collaboration work on its single owner team', () => {
    const h = harness()
    const alpha = h.teams.create({ name: 'Alpha' })
    const beta = h.teams.create({ name: 'Beta' })
    const work = h.works.create({
      name: 'Team W',
      rootPath: '/tmp/team-w',
      collaborationMode: 'team',
      ownerTeamId: alpha.id,
    })
    h.works.linkTeam(work.id, alpha.id)
    expect(() => h.works.linkTeam(work.id, beta.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })
})

describe('AssignmentService 状态机', () => {
  it('creates assignments and walks active → paused → active → completed', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    const assignment = h.assignments.create({
      workId: work.id,
      agentId: h.agent.id,
      workRole: 'engineer',
    })
    expect(assignment).toMatchObject({ status: 'active', workId: work.id, agentId: h.agent.id })

    expect(h.assignments.pause(assignment.id).status).toBe('paused')
    expect(h.assignments.resume(assignment.id).status).toBe('active')
    expect(h.assignments.complete(assignment.id).status).toBe('completed')
    expect(h.assignments.listByWork(work.id)).toHaveLength(1)
  })

  it('rejects creation on terminal works, inactive agents and duplicates', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    h.assignments.create({ workId: work.id, agentId: h.agent.id, workRole: 'engineer' })

    // 同一 Work 同一 Agent 只能有一个岗位
    expect(() =>
      h.assignments.create({ workId: work.id, agentId: h.agent.id, workRole: 'engineer' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))

    // Agent 停用后不能再建岗位
    h.agentRepository.update({ ...h.otherAgent, status: 'disabled', updatedAt: NOW })
    expect(() =>
      h.assignments.create({ workId: work.id, agentId: h.otherAgent.id, workRole: 'reviewer' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))

    // Work 终止后不接受新岗位
    h.works.terminate(work.id)
    expect(() =>
      h.assignments.create({ workId: work.id, agentId: h.otherAgent.id, workRole: 'reviewer' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  })

  it('rejects illegal transitions from terminal states', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    const completed = h.assignments.create({
      workId: work.id,
      agentId: h.agent.id,
      workRole: 'engineer',
    })
    h.assignments.complete(completed.id)
    for (const action of ['pause', 'resume', 'complete', 'remove'] as const) {
      expect(() => h.assignments[action](completed.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      )
    }

    const removed = h.assignments.create({
      workId: work.id,
      agentId: h.otherAgent.id,
      workRole: 'reviewer',
    })
    h.assignments.remove(removed.id)
    for (const action of ['pause', 'resume', 'complete', 'remove'] as const) {
      expect(() => h.assignments[action](removed.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      )
    }
  })

  it('binds an agent session to an active assignment only', () => {
    const h = harness()
    const work = h.works.create({ name: 'W1', rootPath: '/tmp/w1' })
    const assignment = h.assignments.create({
      workId: work.id,
      agentId: h.agent.id,
      workRole: 'engineer',
    })
    h.sessions.create({
      id: 'ses-1',
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: null,
      contextRef: h.agent.id,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })

    h.assignments.bindSession('ses-1', assignment.id)
    expect(h.sessions.get('ses-1')?.assignmentId).toBe(assignment.id)

    // 已绑定到别的 Assignment：拒绝，必须显式解绑
    const other = h.assignments.create({
      workId: work.id,
      agentId: h.otherAgent.id,
      workRole: 'reviewer',
    })
    expect(() => h.assignments.bindSession('ses-1', other.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    // 已结束的 Session 不能绑定
    h.sessions.create({
      id: 'ses-2',
      assignmentId: null,
      providerId: 'claude-code',
      externalSessionId: null,
      contextRef: h.agent.id,
      status: 'ended',
      createdAt: NOW,
      updatedAt: NOW,
      lastActiveAt: NOW,
    })
    expect(() => h.assignments.bindSession('ses-2', assignment.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )

    // 非 active 的 Assignment 不能绑定
    h.assignments.complete(other.id)
    expect(() => h.assignments.bindSession('ses-2', other.id)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })
})
