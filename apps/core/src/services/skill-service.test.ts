import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile } from '@agentra/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { SkillRepository } from '../db/repositories/skill-repository'
import { toolPermissionsForAccessMode } from './agent-service'
import { SkillService } from './skill-service'

const NOW = '2026-11-07T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-skills-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  const skills = new SkillRepository(db)
  const agents = new AgentRepository(db)
  const service = new SkillService(db, skills, agents, () => NOW)
  return { db, skills, agents, service }
}

function agentProfile(id: string, skillIds: string[]): AgentProfile {
  const accessMode = 'analyze' as const
  return {
    id,
    name: id,
    avatar: '🤖',
    description: '',
    systemPrompt: '',
    skillIds,
    accessMode,
    systemKind: null,
    model: null,
    toolPermissions: toolPermissionsForAccessMode(accessMode),
    defaultProviderId: null,
    maxConcurrency: 5,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }
}

describe('SkillService', () => {
  it('creates, normalizes, lists and updates skills', () => {
    const h = harness()
    const created = h.service.create({
      name: '  代码评审  ',
      description: '  检查错误路径  ',
      instructions: '  先看错误路径，再看测试覆盖。  ',
    })
    expect(created).toMatchObject({
      name: '代码评审',
      description: '检查错误路径',
      instructions: '先看错误路径，再看测试覆盖。',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(h.service.list()).toEqual([created])

    const updated = h.service.update({
      id: created.id,
      name: '评审清单',
      instructions: '新的步骤',
    })
    expect(updated).toMatchObject({ name: '评审清单', instructions: '新的步骤' })
    expect(h.service.get(created.id).name).toBe('评审清单')
  })

  it('rejects blank fields and duplicate names', () => {
    const h = harness()
    expect(() => h.service.create({ name: '  ', instructions: 'x' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    expect(() => h.service.create({ name: 'A', instructions: '   ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    h.service.create({ name: 'A', instructions: 'x' })
    expect(() => h.service.create({ name: 'A', instructions: 'y' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
    const other = h.service.create({ name: 'B', instructions: 'x' })
    expect(() => h.service.update({ id: other.id, name: 'A' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    )
  })

  it('removes the skill from every agent reference on delete', () => {
    const h = harness()
    const skill = h.service.create({ name: 'Review', instructions: 'check' })
    h.agents.insert(agentProfile('agt-1', [skill.id, 'skl-other']))
    h.agents.insert(agentProfile('agt-2', [skill.id]))

    expect(h.service.delete(skill.id)).toEqual({ deleted: true })
    expect(h.skills.list()).toEqual([])
    expect(h.agents.get('agt-1')?.skillIds).toEqual(['skl-other'])
    expect(h.agents.get('agt-2')?.skillIds).toEqual([])

    expect(() => h.service.delete(skill.id)).toThrow(
      expect.objectContaining({ code: 'SKILL_NOT_FOUND' }),
    )
  })
})
