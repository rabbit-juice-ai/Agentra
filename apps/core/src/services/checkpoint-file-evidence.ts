import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import {
  CheckpointPathError,
  hashFileNoFollow,
  isExcludedRelativePath,
  normalizeRelativePath,
  resolveWithinRoot,
} from './checkpoint-path-safety'
import type { FileEvidence, SideEffectCompleteness } from './checkpoint-schemas'
import type { WorktreeRecord } from './worktree-service'

export const MAX_FILE_EVIDENCE_BYTES = 50 * 1024 * 1024
export const MAX_FILE_EVIDENCE_FILES = 5000
export const MAX_FILE_EVIDENCE_TOTAL_BYTES = 500 * 1024 * 1024

export type FileEvidenceCollection = {
  files: FileEvidence[]
  tracked: boolean
  completeness: SideEffectCompleteness
  truncated: boolean
}

export type ExplicitFileRef = {
  relativePath: string
  requirement: 'required' | 'reference'
  status?: 'created' | 'modified' | 'deleted'
}

type GitChange = { status: 'created' | 'modified' | 'deleted'; relativePath: string }

function git(root: string, args: string[]): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30_000,
    }) as Buffer
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed in ${root}: ${message}`)
  }
}

function isAncestor(root: string, ancestor: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, 'HEAD'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
    return true
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return false
    return false
  }
}

function splitNul(buffer: Buffer): string[] {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((item) => item.length > 0)
}

function changedFiles(root: string, baseCommit: string): GitChange[] {
  const tokens = splitNul(git(root, ['diff', '--name-status', '-z', '--find-renames', baseCommit]))
  const changes: GitChange[] = []
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index] as string
    index += 1
    const code = statusToken[0]
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[index]
      const newPath = tokens[index + 1]
      index += 2
      if (!oldPath || !newPath) throw new Error('invalid git rename output')
      if (code === 'R') changes.push({ status: 'deleted', relativePath: oldPath })
      changes.push({ status: 'created', relativePath: newPath })
      continue
    }
    const relativePath = tokens[index]
    index += 1
    if (!relativePath) throw new Error('invalid git diff output')
    if (code === 'A') changes.push({ status: 'created', relativePath })
    else if (code === 'D') changes.push({ status: 'deleted', relativePath })
    else changes.push({ status: 'modified', relativePath })
  }
  return changes
}

function untrackedFiles(root: string): string[] {
  return splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
}

function skipReasonFor(error: unknown): FileEvidence['skipReason'] {
  if (error instanceof CheckpointPathError) {
    if (error.code === 'TOO_LARGE') return 'too_large'
    if (error.code === 'SYMLINK') return 'symlink'
    return 'unreadable'
  }
  return 'unreadable'
}

function evidenceForChange(input: {
  root: string
  rootKind: 'worktree' | 'work_root'
  worktreeId: string | null
  baselineCommit: string | null
  relativePath: string
  status: 'created' | 'modified' | 'deleted'
  requirement: 'required' | 'reference'
  now: string
}): FileEvidence {
  const base = {
    rootKind: input.rootKind,
    worktreeId: input.worktreeId,
    baselineCommit: input.baselineCommit,
    relativePath: input.relativePath,
    status: input.status,
    requirement: input.requirement,
    verifiedAt: input.now,
  } as const

  if (isExcludedRelativePath(input.relativePath)) {
    return {
      ...base,
      size: null,
      sha256: null,
      verification: 'skipped',
      skipReason: 'excluded',
    }
  }

  if (input.status === 'deleted') {
    try {
      const target = resolveWithinRoot(input.root, input.relativePath)
      if (fs.existsSync(target)) {
        return {
          ...base,
          size: null,
          sha256: null,
          verification: 'mismatch',
          skipReason: null,
        }
      }
      return { ...base, size: null, sha256: null, verification: 'verified', skipReason: null }
    } catch (error) {
      return {
        ...base,
        size: null,
        sha256: null,
        verification: 'skipped',
        skipReason: skipReasonFor(error),
      }
    }
  }

  try {
    const target = resolveWithinRoot(input.root, input.relativePath)
    if (!fs.existsSync(target)) {
      return { ...base, size: null, sha256: null, verification: 'missing', skipReason: null }
    }
    const hashed = hashFileNoFollow(target, MAX_FILE_EVIDENCE_BYTES)
    return {
      ...base,
      size: hashed.size,
      sha256: hashed.sha256,
      verification: 'verified',
      skipReason: null,
    }
  } catch (error) {
    return {
      ...base,
      size: null,
      sha256: null,
      verification: 'skipped',
      skipReason: skipReasonFor(error),
    }
  }
}

function completenessFor(
  files: FileEvidence[],
  tracked: boolean,
  truncated: boolean,
): SideEffectCompleteness {
  if (!tracked) return 'not_tracked'
  if (truncated) return 'partial'
  if (files.some((file) => file.requirement === 'required' && file.verification !== 'verified')) {
    return 'partial'
  }
  return 'complete'
}

/** Worktree 证据：相对 worktrees.base_commit 的 git 变更集。 */
export function collectWorktreeFileEvidence(
  worktree: WorktreeRecord,
  now: string,
): FileEvidenceCollection {
  if (worktree.status !== 'active') {
    return { files: [], tracked: false, completeness: 'not_tracked', truncated: false }
  }
  if (!worktree.baseCommit) {
    return { files: [], tracked: false, completeness: 'not_tracked', truncated: false }
  }
  const root = fs.realpathSync(worktree.worktreePath)
  if (!isAncestor(root, worktree.baseCommit)) {
    throw new Error(
      `worktree ${worktree.id} base commit ${worktree.baseCommit} is not an ancestor of HEAD`,
    )
  }

  const changes = new Map<string, GitChange>()
  for (const change of changedFiles(root, worktree.baseCommit)) {
    changes.set(change.relativePath, change)
  }
  for (const relativePath of untrackedFiles(root)) {
    if (!changes.has(relativePath)) changes.set(relativePath, { status: 'created', relativePath })
  }

  const files: FileEvidence[] = []
  let truncated = false
  let totalBytes = 0
  for (const change of changes.values()) {
    if (files.length >= MAX_FILE_EVIDENCE_FILES || totalBytes >= MAX_FILE_EVIDENCE_TOTAL_BYTES) {
      truncated = true
      break
    }
    let relativePath: string
    try {
      relativePath = normalizeRelativePath(change.relativePath)
    } catch (error) {
      files.push({
        rootKind: 'worktree',
        worktreeId: worktree.id,
        baselineCommit: worktree.baseCommit,
        relativePath: change.relativePath,
        status: change.status,
        requirement: 'required',
        size: null,
        sha256: null,
        verifiedAt: now,
        verification: 'skipped',
        skipReason: skipReasonFor(error),
      })
      continue
    }
    const excluded = isExcludedRelativePath(relativePath)
    const requirement = excluded ? 'reference' : 'required'
    const evidence = evidenceForChange({
      root,
      rootKind: 'worktree',
      worktreeId: worktree.id,
      baselineCommit: worktree.baseCommit,
      relativePath,
      status: change.status,
      requirement,
      now,
    })
    if (evidence.size !== null) totalBytes += evidence.size
    files.push(evidence)
  }

  return {
    files,
    tracked: true,
    completeness: completenessFor(files, true, truncated),
    truncated,
  }
}

/** 非 Worktree：只接受显式 fileRefs，不扫描目录。 */
export function collectExplicitFileEvidence(input: {
  root: string
  refs: ExplicitFileRef[]
  now: string
}): FileEvidenceCollection {
  if (input.refs.length === 0) {
    return { files: [], tracked: false, completeness: 'not_tracked', truncated: false }
  }
  const root = fs.realpathSync(input.root)
  const files: FileEvidence[] = []
  let totalBytes = 0
  let truncated = false
  for (const ref of input.refs) {
    if (files.length >= MAX_FILE_EVIDENCE_FILES || totalBytes >= MAX_FILE_EVIDENCE_TOTAL_BYTES) {
      truncated = true
      break
    }
    const evidence = evidenceForChange({
      root,
      rootKind: 'work_root',
      worktreeId: null,
      baselineCommit: null,
      relativePath: ref.relativePath,
      status: ref.status ?? 'modified',
      requirement: ref.requirement,
      now: input.now,
    })
    if (evidence.size !== null) totalBytes += evidence.size
    files.push(evidence)
  }
  return {
    files,
    tracked: true,
    completeness: completenessFor(files, true, truncated),
    truncated,
  }
}
