import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { AssignmentRepository } from '../db/repositories/assignment-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { WorktreeService } from '../services/worktree-service'
import { WorkflowRecoveryWorktreeService } from './recovery-worktree'

const NOW = '2026-11-11T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
}

describe('WorkflowRecoveryWorktreeService (real git)', () => {
  it('creates an isolated worktree with the pre-generated id and validates Git identity', () => {
    const root = temp('agentra-wt-root-')
    const repo = temp('agentra-wt-repo-')
    initRepo(repo)
    const db = openDatabase(path.join(temp('agentra-wt-db-'), 'agentra.db'))
    migrate(db)
    db.prepare(
      `INSERT INTO works (id, name, description, objective, status, priority, root_path,
         repository_path, settings_json, created_at, updated_at, completed_at)
       VALUES ('work-1', 'W', '', '', 'active', 'normal', ?, ?, '{}', ?, ?, NULL)`,
    ).run(root, repo, NOW, NOW)
    const workRepository = new WorkRepository(db)
    const worktrees = new WorktreeService(
      db,
      workRepository,
      new AssignmentRepository(db),
      path.join(root, 'trees'),
      () => NOW,
    )
    const service = new WorkflowRecoveryWorktreeService(worktrees, workRepository)
    const facts = service.prepare({
      workId: 'work-1',
      worktreeId: 'wt-fixed',
      workflowRunId: 'run-1',
      nodeKey: 'task_1',
      newNodeRunId: 'nrn-recovery-1',
      chainAttemptNo: 1,
      recoveryAttemptId: 'rec-1',
      ownerToken: 'owner-token',
    })
    expect(facts.worktreeId).toBe('wt-fixed')
    expect(facts.branchName).toMatch(/^agentra\//)
    expect(facts.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(facts.worktreePath)).toBe(true)
    expect(service.inspectCreation('work-1', facts)).toBe('registered')
    expect(() =>
      service.validate('work-1', facts, {
        branchName: facts.branchName,
        newNodeRunId: 'nrn-recovery-1',
      }),
    ).not.toThrow()

    // 同一分支不能再次创建（WorktreeService 的 active 分支检查）
    expect(() =>
      service.prepare({
        workId: 'work-1',
        worktreeId: 'wt-second',
        workflowRunId: 'run-1',
        nodeKey: 'task_1',
        newNodeRunId: 'nrn-recovery-1',
        chainAttemptNo: 1,
        recoveryAttemptId: 'rec-2',
        ownerToken: 'owner-2',
      }),
    ).toThrow()
    db.close()
  })
})
