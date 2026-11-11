import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sha256Hex } from './checkpoint-hash'
import { hashFileNoFollow, resolveWithinRoot } from './checkpoint-path-safety'
import type { CodeVersion, FileEvidence, TestEvidence } from './checkpoint-schemas'

const MAX_CODE_VERSION_FILE_BYTES = 50 * 1024 * 1024

function git(root: string, args: string[]): Buffer | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30_000,
    }) as Buffer
  } catch {
    return null
  }
}

function gitText(root: string, args: string[]): string | null {
  const result = git(root, args)
  return result === null ? null : result.toString('utf8').trim()
}

function splitNul(buffer: Buffer): string[] {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((item) => item.length > 0)
}

/** 当前工作树代码版本：HEAD + dirty + diff hash + 未跟踪文件哈希。 */
export function computeCodeVersion(input: {
  root: string
  worktreeId: string | null
  fileHashes: Record<string, string>
}): CodeVersion | null {
  const root = path.resolve(input.root)
  if (!fs.existsSync(root)) return null
  const inside = gitText(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') return null
  const commit = gitText(root, ['rev-parse', 'HEAD'])
  if (!commit || !/^[a-f0-9]{7,64}$/.test(commit)) return null

  const status = git(root, ['status', '--porcelain=v1', '-z'])
  const dirty = status !== null && splitNul(status).length > 0
  const diff = git(root, ['diff', '--binary', 'HEAD']) ?? Buffer.alloc(0)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const untrackedLines: string[] = []
  for (const relativePath of untracked ? splitNul(untracked) : []) {
    try {
      const target = resolveWithinRoot(root, relativePath)
      const hashed = hashFileNoFollow(target, MAX_CODE_VERSION_FILE_BYTES)
      untrackedLines.push(`${relativePath}:${hashed.sha256}`)
    } catch {
      untrackedLines.push(`${relativePath}:unreadable`)
    }
  }
  untrackedLines.sort()
  const diffHash = sha256Hex(
    Buffer.concat([
      diff,
      Buffer.from('\n--agentra-untracked--\n'),
      Buffer.from(untrackedLines.join('\n')),
    ]),
  )

  return {
    worktreeId: input.worktreeId,
    gitCommit: commit,
    dirty,
    diffHash,
    fileHashes: input.fileHashes,
  }
}

export function fileHashesFromEvidence(files: FileEvidence[]): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const file of files) {
    if (file.sha256) hashes[file.relativePath] = file.sha256
  }
  return hashes
}

export function sameCodeVersion(a: CodeVersion | null, b: CodeVersion | null): boolean {
  if (!a || !b) return false
  return (
    a.worktreeId === b.worktreeId &&
    a.gitCommit === b.gitCommit &&
    a.dirty === b.dirty &&
    a.diffHash === b.diffHash
  )
}

/**
 * 当前 Agent 的 test_result 只是输出契约，不是 runner 证据。
 * 即使 pass=true，也只能标记 inferred，不能把 Checkpoint 提升为 verified。
 */
export function collectAgentTestEvidence(input: {
  nodeRunId: string
  output: Record<string, unknown> | null
  codeVersion: CodeVersion | null
}): TestEvidence[] {
  if (!input.output || typeof input.output.pass !== 'boolean') return []
  const result = input.output.pass ? 'passed' : 'failed'
  return [
    {
      testKey: `node-output:${input.nodeRunId}`,
      name: 'test_result',
      command: null,
      result,
      trust: 'agent_claimed',
      requirement: 'reference',
      startedAt: null,
      endedAt: null,
      codeVersion: input.codeVersion,
      reportArtifact: null,
      verification: 'inferred',
    },
  ]
}

export type RunnerTestEvidenceInput = {
  testKey: string
  name: string
  command: string
  result: 'passed' | 'failed' | 'skipped'
  requirement?: 'required' | 'reference'
  startedAt: string
  endedAt: string
  codeVersion: CodeVersion
  reportArtifact?: TestEvidence['reportArtifact']
}

/** 为未来真实测试运行器保留的入口；Phase 1B-1 不产生 runner 证据。 */
export function collectRunnerTestEvidence(
  input: RunnerTestEvidenceInput,
  currentCodeVersion: CodeVersion | null,
): TestEvidence {
  const verification =
    input.result !== 'passed'
      ? 'unverifiable'
      : sameCodeVersion(input.codeVersion, currentCodeVersion)
        ? 'verified'
        : 'stale'
  return {
    testKey: input.testKey,
    name: input.name,
    command: input.command,
    result: input.result,
    trust: 'runner',
    requirement: input.requirement ?? 'required',
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    codeVersion: input.codeVersion,
    reportArtifact: input.reportArtifact ?? null,
    verification,
  }
}
