import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { ProjectRepository } from '../db/repositories/project-repository'
import { TaskMemoryRepository } from '../db/repositories/task-memory-repository'
import { TeamRepository } from '../db/repositories/team-repository'
import { WorkRepository } from '../db/repositories/work-repository'
import { ArtifactService } from './artifact-service'
import { collectArtifactEvidence } from './checkpoint-artifact-evidence'
import {
  collectExplicitFileEvidence,
  collectWorktreeFileEvidence,
} from './checkpoint-file-evidence'
import {
  collectAgentTestEvidence,
  collectRunnerTestEvidence,
  computeCodeVersion,
} from './checkpoint-test-evidence'
import { buildContext } from './context-builder'
import { TaskMemorySchema, TaskMemoryService } from './task-memory-service'
import { WorkService } from './work-service'
import type { WorktreeRecord } from './worktree-service'

const NOW = '2026-11-09T00:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return git(dir, ['rev-parse', 'HEAD'])
}

function worktreeRecord(worktreePath: string, baseCommit: string): WorktreeRecord {
  return {
    id: 'wt-1',
    workId: 'work-1',
    assignmentId: null,
    repositoryPath: path.dirname(worktreePath),
    worktreePath,
    branchName: 'feature',
    baseCommit,
    status: 'active',
    createdAt: NOW,
    removedAt: null,
  }
}

describe('Checkpoint file evidence', () => {
  it('records created, modified, deleted and excluded files with SHA-256', () => {
    const root = tempDir('agentra-wt-root-')
    const base = initRepo(root)
    const wt = path.join(tempDir('agentra-wt-'), 'wt')
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', wt], {
      encoding: 'utf8',
    })
    fs.writeFileSync(path.join(wt, 'created.ts'), 'export const x = 1\n')
    fs.writeFileSync(path.join(wt, 'README.md'), '# changed\n')
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n')
    fs.unlinkSync(path.join(wt, 'README.md'))
    fs.writeFileSync(path.join(wt, 'README.md'), '# changed again\n')
    fs.unlinkSync(path.join(wt, 'created.ts'))
    fs.writeFileSync(path.join(wt, 'created.ts'), 'export const x = 2\n')

    const result = collectWorktreeFileEvidence(worktreeRecord(wt, base), NOW)
    expect(result.tracked).toBe(true)
    const created = result.files.find((file) => file.relativePath === 'created.ts')
    expect(created).toMatchObject({
      status: 'created',
      requirement: 'required',
      verification: 'verified',
    })
    expect(created?.sha256).toMatch(/^[a-f0-9]{64}$/)
    const modified = result.files.find((file) => file.relativePath === 'README.md')
    expect(modified).toMatchObject({ status: 'modified', verification: 'verified' })
    const env = result.files.find((file) => file.relativePath === '.env')
    expect(env).toMatchObject({
      status: 'created',
      requirement: 'reference',
      verification: 'skipped',
      skipReason: 'excluded',
    })
  })

  it('verifies expected deletions and rejects symlink escapes', () => {
    const root = tempDir('agentra-wt-root-')
    const base = initRepo(root)
    const wt = path.join(tempDir('agentra-wt-'), 'wt')
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', wt], {
      encoding: 'utf8',
    })
    fs.unlinkSync(path.join(wt, 'README.md'))
    const outside = path.join(tempDir('agentra-outside-'), 'secret.txt')
    fs.writeFileSync(outside, 'secret\n')
    fs.symlinkSync(outside, path.join(wt, 'link.txt'))

    const result = collectWorktreeFileEvidence(worktreeRecord(wt, base), NOW)
    const deleted = result.files.find((file) => file.relativePath === 'README.md')
    expect(deleted).toMatchObject({ status: 'deleted', verification: 'verified' })
    const link = result.files.find((file) => file.relativePath === 'link.txt')
    expect(link).toMatchObject({
      status: 'created',
      verification: 'skipped',
      skipReason: 'symlink',
    })
  })

  it('rejects explicit path traversal and missing roots without reading outside files', () => {
    const root = tempDir('agentra-explicit-')
    const outside = path.join(tempDir('agentra-outside-'), 'secret.txt')
    fs.writeFileSync(outside, 'secret\n')
    const result = collectExplicitFileEvidence({
      root,
      refs: [{ relativePath: '../secret.txt', requirement: 'required' }],
      now: NOW,
    })
    expect(result.files[0]).toMatchObject({ verification: 'skipped', requirement: 'required' })
    expect(result.files[0]?.relativePath).toBe('../secret.txt')
  })
})

describe('Checkpoint artifact evidence', () => {
  function artifactHarness() {
    const dir = tempDir('agentra-artifact-evidence-')
    const db = openDatabase(path.join(dir, 'agentra.db'))
    migrate(db)
    const workRepository = new WorkRepository(db)
    const workService = new WorkService(
      db,
      workRepository,
      new TeamRepository(db),
      new AuditRepository(db),
      () => NOW,
      undefined,
      new ProjectRepository(db),
      new TaskMemoryService({
        db,
        memories: new TaskMemoryRepository(db),
        now: () => NOW,
      }),
    )
    const work = workService.create({ name: 'Artifact Work', rootPath: dir })
    workService.activate(work.id)
    const artifactsRoot = path.join(dir, 'artifacts')
    fs.mkdirSync(artifactsRoot, { recursive: true })
    const repository = new ArtifactRepository(db)
    const service = new ArtifactService(db, repository, artifactsRoot, {
      get: (id) => workRepository.get(id),
    })
    const created = service.createVersion({
      workId: work.id,
      artifactType: 'markdown',
      name: 'report',
      content: '# report\n',
      createdByType: 'agent',
      createdById: 'agt-1',
      metadata: { executionId: 'exe-1' },
    })
    return { db, work, artifactsRoot, repository, created, dir }
  }

  it('verifies Artifact version and checksum, and detects tampering/cross-work refs', () => {
    const h = artifactHarness()
    const ref = {
      artifactId: h.created.artifact.id,
      version: h.created.version.version,
      checksum: h.created.version.checksum,
      requirement: 'required' as const,
      executionId: 'exe-1',
    }
    const verified = collectArtifactEvidence({
      refs: [ref],
      workId: h.work.id,
      executionId: 'exe-1',
      artifacts: h.repository,
      artifactsRoot: h.artifactsRoot,
    })
    expect(verified.artifacts[0]).toMatchObject({
      verification: 'verified',
      requirement: 'required',
    })

    fs.writeFileSync(h.created.version.storagePath, '# tampered\n')
    const tampered = collectArtifactEvidence({
      refs: [ref],
      workId: h.work.id,
      executionId: 'exe-1',
      artifacts: h.repository,
      artifactsRoot: h.artifactsRoot,
    })
    expect(tampered.artifacts[0]?.verification).toBe('mismatch')

    const crossWork = collectArtifactEvidence({
      refs: [ref],
      workId: 'other-work',
      executionId: 'exe-1',
      artifacts: h.repository,
      artifactsRoot: h.artifactsRoot,
    })
    expect(crossWork.artifacts[0]?.verification).toBe('mismatch')

    fs.unlinkSync(h.created.version.storagePath)
    const missingFile = collectArtifactEvidence({
      refs: [ref],
      workId: h.work.id,
      executionId: 'exe-1',
      artifacts: h.repository,
      artifactsRoot: h.artifactsRoot,
    })
    expect(missingFile.artifacts[0]?.verification).toBe('missing')

    const missing = collectArtifactEvidence({
      refs: [{ ...ref, artifactId: 'art-missing' }],
      workId: h.work.id,
      executionId: 'exe-1',
      artifacts: h.repository,
      artifactsRoot: h.artifactsRoot,
    })
    expect(missing.artifacts[0]?.verification).toBe('missing')
  })
})

describe('Checkpoint test evidence', () => {
  it('binds runner evidence to code version and keeps agent test_result inferred', () => {
    const dir = tempDir('agentra-test-evidence-')
    const base = initRepo(dir)
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1\n')
    git(dir, ['add', 'app.ts'])
    git(dir, ['commit', '-q', '-m', 'app'])
    const codeVersion = computeCodeVersion({ root: dir, worktreeId: null, fileHashes: {} })
    expect(codeVersion?.gitCommit).toBeTruthy()
    expect(codeVersion?.diffHash).toMatch(/^[a-f0-9]{64}$/)
    if (!codeVersion) throw new Error('code version not computed')

    const agent = collectAgentTestEvidence({
      nodeRunId: 'nrn-1',
      output: { pass: true },
      codeVersion,
    })
    expect(agent[0]).toMatchObject({
      trust: 'agent_claimed',
      verification: 'inferred',
      requirement: 'reference',
    })

    const runner = collectRunnerTestEvidence(
      {
        testKey: 'unit',
        name: 'unit tests',
        command: 'pnpm test',
        result: 'passed',
        startedAt: NOW,
        endedAt: NOW,
        codeVersion,
      },
      codeVersion,
    )
    expect(runner).toMatchObject({ trust: 'runner', verification: 'verified' })

    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 2\n')
    const changedVersion = computeCodeVersion({ root: dir, worktreeId: null, fileHashes: {} })
    const stale = collectRunnerTestEvidence(
      {
        testKey: 'unit',
        name: 'unit tests',
        command: 'pnpm test',
        result: 'passed',
        startedAt: NOW,
        endedAt: NOW,
        codeVersion,
      },
      changedVersion,
    )
    expect(stale.verification).toBe('stale')
    expect(base).toBeTruthy()
  })
})

describe('ContextBuilder', () => {
  const memory = TaskMemorySchema.parse({
    schemaVersion: 1,
    taskId: 'work-1',
    objective: 'ship',
    acceptanceCriteria: {
      workVersion: 1,
      workUpdatedAt: NOW,
      items: [
        {
          id: 'ac-1',
          statement: 'works',
          verification: 'verified',
          source: { type: 'work', id: 'work-1' },
          updatedAt: NOW,
        },
      ],
    },
    constraints: [],
    completed: [
      {
        id: 'done-1',
        statement: 'implemented',
        verification: 'verified',
        source: { type: 'execution', id: 'exe-1' },
        updatedAt: NOW,
      },
    ],
    inProgress: [],
    decisions: [],
    tests: [],
    files: [],
    issues: [],
    blockers: [],
    nextActions: [],
    openQuestions: [],
    updatedAt: NOW,
  })

  const input = {
    work: {
      id: 'work-1',
      name: 'Work',
      objective: 'ship',
      acceptanceCriteria: ['works'],
      acceptanceCriteriaVersion: 1,
    },
    taskMemory: memory,
    checkpoint: null,
    agent: { name: 'Worker', accessMode: 'analyze' as const, systemPrompt: 'be careful' },
    messages: [{ authorType: 'user', content: 'hello thread', createdAt: NOW }],
    artifacts: [{ name: 'report', version: 1, checksum: 'a'.repeat(64) }],
    files: [{ relativePath: 'src/app.ts', status: 'modified', verification: 'verified' }],
    sideEffects: [],
  }

  it('builds P0/P1/P2/P3 and keeps chat out of P0/P1', () => {
    const result = buildContext(input)
    expect(result.sections.p0).toContain('P0 · Work')
    expect(result.sections.p0).toContain('works')
    expect(result.sections.p1).toContain('P1 · Task memory')
    expect(result.sections.p2).toContain('hello thread')
    expect(result.sections.p0).not.toContain('hello thread')
    expect(result.sections.p1).not.toContain('hello thread')
    expect(result.manifest.sourceRefs).toContain('work:work-1@v1')
  })

  it('fails closed when P0 exceeds budget and trims P3/P2/P1 in order', () => {
    expect(() =>
      buildContext({
        ...input,
        agent: { name: 'Worker', accessMode: 'analyze', systemPrompt: 'x'.repeat(2000) },
        budget: { totalChars: 1000, p0Chars: 100 },
      }),
    ).toThrow(/P0 context exceeds budget/)

    const result = buildContext({
      ...input,
      messages: Array.from({ length: 40 }, () => ({
        authorType: 'user',
        content: 'm'.repeat(200),
        createdAt: NOW,
      })),
      files: Array.from({ length: 100 }, () => ({
        relativePath: `src/${'f'.repeat(80)}.ts`,
        status: 'modified',
        verification: 'verified',
      })),
      budget: { totalChars: 2500, p0Chars: 2000 },
    })
    expect(result.manifest.totalChars).toBeLessThanOrEqual(2500)
    expect(result.manifest.trimmed.p3).toBe(true)
  })
})
