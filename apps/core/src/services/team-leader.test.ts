import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { MIGRATIONS, migrate } from '../db/migrations'
import { AgentRepository } from '../db/repositories/agent-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { TeamService } from './team-service'

const NOW = '2026-11-07T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-team-leader-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'agentra.db'))
  migrate(db)
  for (const [id, name, accessMode, status] of [
    ['agt-leader', 'Leader', 'analyze', 'active'],
    ['agt-editor', 'Editor', 'edit', 'active'],
    ['agt-inactive', 'Inactive', 'analyze', 'disabled'],
  ] as const) {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, name, avatar, description, system_prompt, skill_ids_json, access_mode, system_kind,
        model, tool_permissions_json, default_provider_id, max_concurrency, status,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, '🤖', '', '', '[]', ?, NULL, NULL,
        '{"version":1,"allow":["Read"],"deny":[]}', NULL, 5, ?, ?, ?, NULL)`,
    ).run(id, name, accessMode, status, NOW, NOW)
  }
  const teamRepository = new TeamRepository(db)
  const agentRepository = new AgentRepository(db)
  const service = new TeamService(db, teamRepository, agentRepository, () => NOW)
  return { db, teamRepository, service }
}

describe('TeamService leadership', () => {
  it('sets an analyze leader and automatically adds the leader as a member', () => {
    const h = harness()
    const team = h.service.create({ name: 'Delivery', description: 'delivers' })
    expect(team.leaderAgentId).toBeNull()

    const updated = h.service.update(team.id, { leaderAgentId: 'agt-leader' })
    expect(updated.leaderAgentId).toBe('agt-leader')
    expect(h.teamRepository.getMember(team.id, 'agt-leader')).toMatchObject({
      teamId: team.id,
      agentId: 'agt-leader',
    })
    expect(h.service.listMembers(team.id).map((member) => member.agentId)).toContain('agt-leader')
  })

  it('rejects edit/inactive/unknown leaders and protects the leader from removal', () => {
    const h = harness()
    const team = h.service.create({ name: 'Delivery' })
    h.service.update(team.id, { leaderAgentId: 'agt-leader' })
    h.service.addMember(team.id, 'agt-editor')

    expect(() => h.service.update(team.id, { leaderAgentId: 'agt-editor' })).toThrow(
      /analyze access mode/,
    )
    expect(() => h.service.update(team.id, { leaderAgentId: 'agt-inactive' })).toThrow(/disabled/)
    expect(() => h.service.update(team.id, { leaderAgentId: 'agt-missing' })).toThrow(
      /agent not found/,
    )
    expect(() => h.service.removeMember(team.id, 'agt-leader')).toThrow(/team leader/)
    expect(() => h.service.removeMember(team.id, 'agt-editor')).not.toThrow()
  })

  it('clears leadership without removing the member and keeps history on archived teams', () => {
    const h = harness()
    const team = h.service.create({ name: 'Delivery' })
    h.service.update(team.id, { leaderAgentId: 'agt-leader' })
    const cleared = h.service.update(team.id, { leaderAgentId: null })
    expect(cleared.leaderAgentId).toBeNull()
    expect(h.teamRepository.getMember(team.id, 'agt-leader')).not.toBeNull()

    h.service.update(team.id, { leaderAgentId: 'agt-leader' })
    h.service.archive(team.id)
    const archived = h.teamRepository.get(team.id)
    expect(archived?.leaderAgentId).toBe('agt-leader')
  })

  it('does not backfill leaders for old teams when v27 runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-team-leader-migration-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 26),
      )
      db.prepare(
        `INSERT INTO teams (id, name, description, instructions, settings_json, status, created_at, updated_at, archived_at)
         VALUES ('team-old', 'Old', '', '', '{}', 'active', ?, ?, NULL)`,
      ).run(NOW, NOW)
      migrate(db)
      const row = db.prepare('SELECT leader_agent_id FROM teams WHERE id = ?').get('team-old') as {
        leader_agent_id: string | null
      }
      expect(row.leader_agent_id).toBeNull()
    } finally {
      db.close()
    }
  })
})
