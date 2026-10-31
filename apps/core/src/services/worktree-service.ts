import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import type { WorkRepository } from '../db/repositories/work-repository'

export type WorktreeStatus = 'active' | 'removed'

export type WorktreeRecord = {
  id: string
  workId: string
  assignmentId: string | null
  repositoryPath: string
  worktreePath: string
  branchName: string
  baseCommit: string | null
  status: WorktreeStatus
  createdAt: string
  removedAt: string | null
}

type WorktreeRow = {
  id: string
  work_id: string
  assignment_id: string | null
  repository_path: string
  worktree_path: string
  branch_name: string
  base_commit: string | null
  status: string
  created_at: string
  removed_at: string | null
}

function toRecord(row: WorktreeRow): WorktreeRecord {
  if (row.status !== 'active' && row.status !== 'removed') {
    throw new Error(`unexpected worktrees.status: ${row.status}`)
  }
  return {
    id: row.id,
    workId: row.work_id,
    assignmentId: row.assignment_id,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseCommit: row.base_commit,
    status: row.status,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  }
}

export type CreateWorktreeInput = {
  workId: string
  assignmentId?: string | null
  branchName: string
  /** 起始引用，缺省是仓库当前 HEAD。 */
  baseRef?: string
  /** 二次确认（创建不需要，保留字段给未来的覆盖场景）。 */
  confirm?: boolean
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr
  if (stderr) return String(stderr).trim().slice(0, 400)
  return error instanceof Error ? error.message : String(error)
}

/**
 * Git Worktree（DATABASE §2.8）。
 *
 * - 创建：在 `work.repository_path` 上执行 `git worktree add`，落到 Agentra 数据目录下
 *   `<data>/worktrees/<workId>/<branch>`，不往用户仓库里塞东西。
 * - 清理：**必须显式确认**（DEVELOPMENT_PLAN 阶段 2「清理必须确认」）。API 要求 confirm=true，
 *   未确认直接拒绝，不默认执行。
 */
export class WorktreeService {
  constructor(
    private readonly db: Database,
    private readonly works: WorkRepository,
    readonly worktreeRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly runGit: (cwd: string, args: string[]) => string = git,
  ) {}

  create(input: CreateWorktreeInput): WorktreeRecord {
    const work = this.works.get(input.workId)
    if (!work) throw new RpcMethodError('INVALID_PARAMS', `work not found: ${input.workId}`)

    const repositoryPath = work.repositoryPath
    if (!repositoryPath) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${work.id} has no repository_path; set it before creating worktrees`,
      )
    }
    if (!fs.existsSync(repositoryPath)) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `repository path does not exist: ${repositoryPath}`,
      )
    }
    try {
      this.runGit(repositoryPath, ['rev-parse', '--git-dir'])
    } catch (error) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `not a git repository: ${repositoryPath} (${gitErrorText(error)})`,
      )
    }

    const branchName = input.branchName.trim()
    if (branchName.length === 0) {
      throw new RpcMethodError('INVALID_PARAMS', 'branchName must not be blank')
    }
    if (
      this.db
        .prepare('SELECT 1 FROM worktrees WHERE work_id = ? AND branch_name = ? AND status = ?')
        .get(work.id, branchName, 'active')
    ) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `work ${work.id} already has an active worktree for branch ${branchName}`,
      )
    }

    const worktreePath = path.join(this.worktreeRoot, work.id, branchName)
    try {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `cannot prepare worktree directory ${path.dirname(worktreePath)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      const args = ['worktree', 'add', '-b', branchName, worktreePath]
      if (input.baseRef) args.push(input.baseRef)
      this.runGit(repositoryPath, args)
    } catch (error) {
      throw new RpcMethodError('INVALID_PARAMS', `git worktree add failed: ${gitErrorText(error)}`)
    }

    let baseCommit: string | null = null
    try {
      baseCommit = this.runGit(worktreePath, ['rev-parse', 'HEAD'])
    } catch {
      baseCommit = null
    }

    const record: WorktreeRecord = {
      id: newId('wt'),
      workId: work.id,
      assignmentId: input.assignmentId ?? null,
      repositoryPath,
      worktreePath,
      branchName,
      baseCommit,
      status: 'active',
      createdAt: this.now(),
      removedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO worktrees (
          id, work_id, assignment_id, repository_path, worktree_path, branch_name,
          base_commit, status, created_at, removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workId,
        record.assignmentId,
        record.repositoryPath,
        record.worktreePath,
        record.branchName,
        record.baseCommit,
        record.status,
        record.createdAt,
        record.removedAt,
      )
    return record
  }

  list(workId: string): WorktreeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worktrees WHERE work_id = ? AND status = ? ORDER BY created_at ASC')
      .all(workId, 'active') as WorktreeRow[]
    return rows.map(toRecord)
  }

  get(id: string): WorktreeRecord | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
      | WorktreeRow
      | undefined
    return row ? toRecord(row) : null
  }

  /** 清理 worktree：必须显式 confirm=true，否则直接拒绝（不默认执行）。 */
  remove(id: string, confirm: boolean): WorktreeRecord {
    if (confirm !== true) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `removing worktree ${id} requires explicit confirmation (confirm=true)`,
      )
    }
    const record = this.get(id)
    if (!record) throw new RpcMethodError('INVALID_PARAMS', `worktree not found: ${id}`)
    if (record.status !== 'active') {
      throw new RpcMethodError('INVALID_PARAMS', `worktree ${id} is already ${record.status}`)
    }

    try {
      this.runGit(record.repositoryPath, ['worktree', 'remove', '--force', record.worktreePath])
    } catch (error) {
      throw new RpcMethodError(
        'INVALID_PARAMS',
        `git worktree remove failed: ${gitErrorText(error)}`,
      )
    }

    const now = this.now()
    this.db
      .prepare('UPDATE worktrees SET status = ?, removed_at = ? WHERE id = ?')
      .run('removed', now, id)
    return { ...record, status: 'removed', removedAt: now }
  }
}
