import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { WorkRepository } from '../db/repositories/work-repository'
import type { WorktreeRecord, WorktreeService } from '../services/worktree-service'

export type WorkflowRecoveryWorktreeFacts = {
  worktreeId: string
  worktreePath: string
  branchName: string
  baseCommit: string
  gitCommonDir: string
  registeredWorktreePath: string
  worktreeOwnerToken: string
}

export type PrepareWorkflowRecoveryWorktreeInput = {
  workId: string
  worktreeId: string
  workflowRunId: string
  nodeKey: string
  newNodeRunId: string
  chainAttemptNo: number
  recoveryAttemptId: string
  ownerToken: string
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function slugNodeKey(nodeKey: string): string {
  const slug = nodeKey
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? slug : 'node'
}

function hash8(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function realpathOrThrow(input: string, label: string): string {
  try {
    return fs.realpathSync.native(input)
  } catch (error) {
    throw new Error(
      `${label} realpath failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function parseWorktreeList(output: string): {
  path: string
  head: string | null
  branch: string | null
}[] {
  const entries: { path: string; head: string | null; branch: string | null }[] = []
  let current: { path: string; head: string | null; branch: string | null } | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length).trim(), head: null, branch: null }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
    }
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Workflow NodeRun 恢复专用 Worktree：创建、真实路径/Git 身份校验。
 * 只使用参数数组；不拼接 shell 字符串。
 */
export class WorkflowRecoveryWorktreeService {
  constructor(
    private readonly worktrees: WorktreeService,
    private readonly works: Pick<WorkRepository, 'get'>,
    private readonly run: (cwd: string, args: string[]) => string = runGit,
  ) {}

  branchName(input: {
    workflowRunId: string
    nodeKey: string
    newNodeRunId: string
    chainAttemptNo: number
  }): string {
    const runTail = input.workflowRunId.replace(/[^a-zA-Z0-9-]/g, '').slice(-12)
    return `agentra/${runTail}/${slugNodeKey(input.nodeKey)}-${hash8(input.nodeKey)}/${input.newNodeRunId.slice(-12)}-r${input.chainAttemptNo}`
  }

  prepare(input: PrepareWorkflowRecoveryWorktreeInput): WorkflowRecoveryWorktreeFacts {
    const work = this.works.get(input.workId)
    if (!work?.repositoryPath) {
      throw new Error(`work ${input.workId} has no repository_path`)
    }
    const branchName = this.branchName(input)
    this.assertBranchName(work.repositoryPath, branchName)
    const baseCommit = this.run(work.repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])

    let record: WorktreeRecord
    try {
      record = this.worktrees.create({
        workId: input.workId,
        id: input.worktreeId,
        branchName,
      })
    } catch (error) {
      throw new Error(
        `recovery worktree create failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const facts = this.inspectRecord(record, work.repositoryPath, baseCommit)
    return {
      ...facts,
      worktreeOwnerToken: input.ownerToken,
    }
  }

  /** 启动对账：判断 T2a 意图对应的 Worktree 是否已在 Git 中注册。 */
  inspectCreation(
    workId: string,
    facts: Partial<WorkflowRecoveryWorktreeFacts>,
  ): 'registered' | 'absent' | 'unknown' {
    const work = this.works.get(workId)
    if (!work?.repositoryPath || !facts.worktreePath || !facts.branchName) return 'unknown'
    let listed: { path: string; head: string | null; branch: string | null }[]
    try {
      listed = parseWorktreeList(this.run(work.repositoryPath, ['worktree', 'list', '--porcelain']))
    } catch {
      return 'unknown'
    }
    const target = fs.existsSync(facts.worktreePath)
      ? fs.realpathSync.native(facts.worktreePath)
      : path.resolve(facts.worktreePath)
    const match = listed.find((entry) => {
      try {
        return fs.realpathSync.native(entry.path) === target
      } catch {
        return path.resolve(entry.path) === target
      }
    })
    if (!match) {
      if (listed.some((entry) => entry.branch === `refs/heads/${facts.branchName}`))
        return 'unknown'
      return fs.existsSync(facts.worktreePath) ? 'unknown' : 'absent'
    }
    if (match.branch !== `refs/heads/${facts.branchName}`) return 'unknown'
    return 'registered'
  }

  /** T3 / spawn 前重新校验；任何不一致都抛错。 */
  validate(
    workId: string,
    facts: WorkflowRecoveryWorktreeFacts,
    expected: { branchName: string; newNodeRunId: string },
  ): void {
    if (facts.branchName !== expected.branchName) {
      throw new Error('recovery worktree branch changed')
    }
    const work = this.works.get(workId)
    if (!work?.repositoryPath) {
      throw new Error(`work ${workId} has no repository_path`)
    }
    const record = this.worktrees
      .list(workId)
      .find((candidate) => candidate.id === facts.worktreeId)
    if (!record || record.status !== 'active') {
      throw new Error(`recovery worktree ${facts.worktreeId} is not active`)
    }
    const inspected = this.inspectRecord(record, work.repositoryPath, facts.baseCommit)
    for (const key of [
      'worktreePath',
      'branchName',
      'baseCommit',
      'gitCommonDir',
      'registeredWorktreePath',
    ] as const) {
      if (inspected[key] !== facts[key]) {
        throw new Error(`recovery worktree ${key} mismatch`)
      }
    }
    if (expected.newNodeRunId.length === 0) {
      throw new Error('recovery worktree newNodeRunId is empty')
    }
  }

  private assertBranchName(repositoryPath: string, branchName: string): void {
    try {
      this.run(repositoryPath, ['check-ref-format', '--branch', branchName])
    } catch {
      throw new Error(`invalid recovery worktree branch name: ${branchName}`)
    }
  }

  private inspectRecord(
    record: WorktreeRecord,
    repositoryPath: string,
    baseCommit: string,
  ): Omit<WorkflowRecoveryWorktreeFacts, 'worktreeOwnerToken'> {
    const root = realpathOrThrow(this.worktrees.worktreeRoot, 'worktreeRoot')
    const worktreePath = realpathOrThrow(record.worktreePath, 'worktreePath')
    if (!isInsideRoot(root, worktreePath)) {
      throw new Error(`recovery worktree path escapes root: ${worktreePath}`)
    }
    const recordPath = realpathOrThrow(record.worktreePath, 'worktree record path')
    if (recordPath !== worktreePath) {
      throw new Error('recovery worktree record path mismatch')
    }

    this.run(repositoryPath, ['cat-file', '-e', `${baseCommit}^{commit}`])
    this.run(repositoryPath, ['rev-parse', '--verify', `${baseCommit}^{commit}`])

    const expectedBranch = record.branchName
    this.assertBranchName(repositoryPath, expectedBranch)
    const listed = parseWorktreeList(this.run(repositoryPath, ['worktree', 'list', '--porcelain']))
    const registered = listed.find((entry) => {
      try {
        return fs.realpathSync.native(entry.path) === worktreePath
      } catch {
        return path.resolve(entry.path) === worktreePath
      }
    })
    if (!registered) throw new Error('recovery worktree is not registered in git worktree list')
    if (registered.branch !== `refs/heads/${expectedBranch}`) {
      throw new Error('recovery worktree git branch mismatch')
    }
    if (registered.head !== baseCommit) {
      throw new Error('recovery worktree git HEAD mismatch')
    }

    const top = realpathOrThrow(
      this.run(worktreePath, ['rev-parse', '--show-toplevel']),
      'git show-toplevel',
    )
    if (top !== worktreePath) throw new Error('recovery worktree top-level mismatch')
    const symbolic = this.run(worktreePath, ['symbolic-ref', '--short', 'HEAD'])
    if (symbolic !== expectedBranch) throw new Error('recovery worktree symbolic-ref mismatch')
    const head = this.run(worktreePath, ['rev-parse', 'HEAD'])
    if (head !== baseCommit) throw new Error('recovery worktree HEAD revision mismatch')
    const commonRaw = this.run(worktreePath, ['rev-parse', '--git-common-dir'])
    const commonDir = realpathOrThrow(path.resolve(worktreePath, commonRaw), 'git-common-dir')

    return {
      worktreeId: record.id,
      worktreePath,
      branchName: expectedBranch,
      baseCommit,
      gitCommonDir: commonDir,
      registeredWorktreePath: registered.path,
    }
  }
}
