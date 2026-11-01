import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { WorkflowEventRepository } from '../db/repositories/workflow-event-repository'
import { WorkflowEventRecorder } from './event-recorder'

const NOW = '2026-11-01T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(): {
  events: WorkflowEventRepository
  recorder: WorkflowEventRecorder
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-events-'))
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
  const events = new WorkflowEventRepository(db)
  return { events, recorder: new WorkflowEventRecorder(events, () => NOW), close: () => db.close() }
}

describe('WorkflowEventRecorder', () => {
  it('deduplicates control events by deterministic event_id', () => {
    const h = setup()
    try {
      h.recorder.publish({ type: 'workflow.completed', runId: 'run-1' })
      h.recorder.publish({ type: 'workflow.completed', runId: 'run-1' })
      const rows = h.events.listByRun('run-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        eventId: 'workflow:run-1:workflow.completed',
        eventType: 'workflow.completed',
      })
    } finally {
      h.close()
    }
  })

  it('preserves insertion order when occurred_at is identical', () => {
    const h = setup()
    try {
      h.recorder.publish({ type: 'workflow.started', runId: 'run-1' })
      h.recorder.publish({ type: 'workflow.completed', runId: 'run-1' })
      expect(h.events.listByRun('run-1').map((event) => event.eventType)).toEqual([
        'workflow.started',
        'workflow.completed',
      ])
    } finally {
      h.close()
    }
  })

  it('deduplicates rework events by request + type + round', () => {
    const h = setup()
    try {
      const event = {
        type: 'rework.started' as const,
        runId: 'run-1',
        reworkRequestId: 'rwk-1',
        targetNodeKey: 'ui',
        round: 1,
      }
      h.recorder.publishRework(event)
      h.recorder.publishRework(event)
      const rows = h.events.listByRun('run-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.eventId).toBe('rework:rwk-1:rework.started:1')
      expect(rows[0]?.payload).toMatchObject({ targetNodeKey: 'ui', round: 1 })
    } finally {
      h.close()
    }
  })
})
