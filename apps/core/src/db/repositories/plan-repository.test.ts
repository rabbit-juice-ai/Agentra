import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrations'
import { PlanCommentRepository, PlanRepository, PlanThreadRepository } from './plan-repository'

const NOW = '2026-11-06T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('PlanCommentRepository', () => {
  it('keeps insertion order when events share the same millisecond', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-plan-repo-'))
    dirs.push(dir)
    const db = openDatabase(path.join(dir, 'agentra.db'))
    migrate(db)
    db.prepare(
      `INSERT INTO works (
        id, name, description, objective, status, priority, root_path, repository_path,
        settings_json, created_at, updated_at, completed_at
      ) VALUES ('work-1', 'Work', '', '', 'active', 'normal', '/tmp', NULL, '{}', ?, ?, NULL)`,
    ).run(NOW, NOW)
    new PlanRepository(db).create({
      id: 'plan-1',
      workId: 'work-1',
      goal: 'goal',
      status: 'running',
      currentVersion: 1,
      workflowVersionId: null,
      workflowRunId: null,
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
      approvedBy: 'boss',
    })
    new PlanThreadRepository(db).create({
      id: 'thread-1',
      planId: 'plan-1',
      taskKey: 'frontend',
      createdAt: NOW,
    })
    const comments = new PlanCommentRepository(db)
    comments.create({
      id: 'comment-zzz',
      threadId: 'thread-1',
      authorType: 'system',
      authorId: 'system',
      content: '返工请求',
      createdAt: NOW,
      runId: null,
    })
    comments.create({
      id: 'comment-aaa',
      threadId: 'thread-1',
      authorType: 'system',
      authorId: 'system',
      content: '返工开始',
      createdAt: NOW,
      runId: null,
    })

    expect(comments.listByThread('thread-1').map((comment) => comment.content)).toEqual([
      '返工请求',
      '返工开始',
    ])
  })
})
