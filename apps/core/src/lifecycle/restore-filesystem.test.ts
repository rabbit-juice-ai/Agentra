import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertInventoryContent,
  assertPathInside,
  assertUnlinkReplayNeedsLock,
  controlledRemoveTree,
  durableCopyFile,
  durableCopyTree,
  durableRename,
  durableUnlink,
  inventoryDirectory,
  isInsideOrEqual,
  lstatAnchor,
  type RenameIntent,
  RestoreFilesystemError,
  type UnlinkIntent,
  verifyRenameReplay,
} from './restore-filesystem'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-restore-fs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('path boundary', () => {
  it('accepts the root itself and descendants', () => {
    const root = path.join(path.sep, 'data', 'root')
    expect(isInsideOrEqual(root, root)).toBe(true)
    expect(isInsideOrEqual(path.join(root, 'a', 'b'), root)).toBe(true)
  })

  it('rejects the exact parent directory and other escapes', () => {
    const root = path.join(path.sep, 'data', 'root')
    expect(isInsideOrEqual(path.join(path.sep, 'data'), root)).toBe(false)
    expect(isInsideOrEqual(path.join(root, '..', 'other'), root)).toBe(false)
    expect(isInsideOrEqual(path.join(path.sep, 'elsewhere'), root)).toBe(false)
  })

  it('assertPathInside rejects the exact parent directory', () => {
    const root = path.join(path.sep, 'data', 'root')
    expect(() => assertPathInside(path.join(path.sep, 'data'), root)).toThrow(
      RestoreFilesystemError,
    )
  })
})

describe('durable copy', () => {
  it('copies a file and verifies source/target content', () => {
    const dir = tempDir()
    const source = path.join(dir, 'source.db')
    const target = path.join(dir, 'capture', 'target.db')
    fs.writeFileSync(source, 'live-data', { mode: 0o600 })
    const expected = lstatAnchor(source)
    const result = durableCopyFile(source, target, expected)
    expect(result.sha256).toBe(expected.sha256)
    expect(fs.readFileSync(target, 'utf8')).toBe('live-data')
  })

  it('copies and verifies a directory manifest without consuming the source', () => {
    const dir = tempDir()
    const source = path.join(dir, 'artifacts')
    const target = path.join(dir, 'rollback')
    fs.mkdirSync(path.join(source, 'work', 'art', 'v1'), { recursive: true })
    fs.writeFileSync(path.join(source, 'work', 'art', 'v1', 'a.txt'), 'alpha')
    const before = inventoryDirectory(source)
    const result = durableCopyTree(source, target, before)
    assertInventoryContent(result, before)
    expect(fs.existsSync(path.join(source, 'work', 'art', 'v1', 'a.txt'))).toBe(true)
  })

  it('rejects a symlink in an artifact tree', () => {
    const dir = tempDir()
    const source = path.join(dir, 'artifacts')
    fs.mkdirSync(source)
    fs.symlinkSync('/tmp', path.join(source, 'escape'))
    expect(() => inventoryDirectory(source)).toThrow(/symlink/)
  })
})

describe('durable rename target policy and replay', () => {
  function intent(dir: string, policy: RenameIntent['targetPolicy']): RenameIntent {
    const source = path.join(dir, 'staged.db')
    const target = path.join(dir, 'live.db')
    return {
      operationId: 'f-db-1',
      source,
      target,
      sourceAnchor: lstatAnchor(source),
      targetPolicy: policy,
      expectedTargetAnchor: policy === 'must_exist_and_match' ? lstatAnchor(target) : null,
      sourceParentAnchor: lstatAnchor(dir),
      targetParentAnchor: lstatAnchor(dir),
    }
  }

  it('replaces only the explicitly authorized old target and preserves inode continuity', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'staged.db'), 'new')
    fs.writeFileSync(path.join(dir, 'live.db'), 'old')
    const op = intent(dir, 'must_exist_and_match')
    const result = durableRename(op)
    expect(result.ino).toBe(op.sourceAnchor.ino)
    expect(result.sha256).toBe(op.sourceAnchor.sha256)
    expect(lstatAnchor(op.source).type).toBe('absent')
  })

  it('refuses to overwrite a target that changed after intent', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'staged.db'), 'new')
    fs.writeFileSync(path.join(dir, 'live.db'), 'old')
    const op = intent(dir, 'must_exist_and_match')
    fs.writeFileSync(path.join(dir, 'live.db'), 'changed')
    expect(() => durableRename(op)).toThrow(RestoreFilesystemError)
    expect(fs.readFileSync(op.source, 'utf8')).toBe('new')
  })

  it('requires an absent target for must_be_absent', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'staged.db'), 'new')
    const op = intent(dir, 'must_be_absent')
    fs.writeFileSync(op.target, 'unexpected')
    expect(() => durableRename(op)).toThrow(/must be absent/)
  })

  it('replays a completed rename only when source is absent, target matches and parents match', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'staged.db'), 'new')
    fs.writeFileSync(path.join(dir, 'live.db'), 'old')
    const op = intent(dir, 'must_exist_and_match')
    durableRename(op)
    expect(verifyRenameReplay(op).sha256).toBe(op.sourceAnchor.sha256)
    const bad = { ...op, sourceParentAnchor: { ...op.sourceParentAnchor, ino: 99_999_999 } }
    expect(() => verifyRenameReplay(bad)).toThrow(/identity mismatch/)
  })
})

describe('15-step durable unlink', () => {
  function intent(file: string): UnlinkIntent {
    return {
      operationId: 'side-wal-1',
      target: file,
      targetAnchor: lstatAnchor(file),
      parentAnchor: lstatAnchor(path.dirname(file)),
      journalRevision: 3,
    }
  }

  it('returns completion evidence only after the target is absent and parent fsync succeeds', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const evidence = durableUnlink(intent(file))
    expect(evidence).toMatchObject({
      targetAbsent: true,
      nlinkBefore: 1,
      nlinkAfter: 0,
      directoryFsyncCompleted: true,
    })
    expect(lstatAnchor(file).type).toBe('absent')
  })

  it('refuses to unlink an object whose identity changed after intent', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, 'one')
    const op = intent(file)
    fs.rmSync(file)
    fs.writeFileSync(file, 'two')
    expect(() => durableUnlink(op)).toThrow(/anchor mismatch/)
    expect(fs.readFileSync(file, 'utf8')).toBe('two')
  })

  it('does not allow absent-without-evidence replay to be treated as success', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = intent(file)
    fs.rmSync(file)
    expect(() => assertUnlinkReplayNeedsLock(op, null)).toThrow(/without durable completion/)
  })
})

describe('durableUnlink retry-once (v17 §2.4)', () => {
  function unlinkIntent(file: string): UnlinkIntent {
    return {
      operationId: 'side-wal-1',
      target: file,
      targetAnchor: lstatAnchor(file),
      parentAnchor: lstatAnchor(path.dirname(file)),
      journalRevision: 3,
    }
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code })
  }

  it('retries the unlink syscall once after a transient EIO and completes with real evidence', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    let calls = 0
    const evidence = durableUnlink(op, {
      unlinkSync: (target) => {
        calls += 1
        if (calls === 1) throw errno('EIO')
        fs.unlinkSync(target)
      },
    })
    expect(calls).toBe(2)
    expect(evidence).toMatchObject({
      targetAbsent: true,
      nlinkBefore: 1,
      nlinkAfter: 0,
      directoryFsyncCompleted: true,
    })
    expect(evidence.parentDev).toBe(lstatAnchor(dir).dev)
    expect(evidence.parentIno).toBe(lstatAnchor(dir).ino)
    expect(lstatAnchor(file).type).toBe('absent')
  })

  it('fails closed after two transient failures and never fabricates evidence', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    let calls = 0
    expect(() =>
      durableUnlink(op, {
        unlinkSync: () => {
          calls += 1
          throw errno('EIO')
        },
      }),
    ).toThrow(/unlink syscall failed/)
    expect(calls).toBe(2)
    // 目标仍在、内容未变：没有任何完成事实被写入或返回。
    expect(lstatAnchor(file).type).toBe('regular-file')
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('does not retry a deterministic unlink error', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    let calls = 0
    expect(() =>
      durableUnlink(op, {
        unlinkSync: () => {
          calls += 1
          throw errno('EACCES')
        },
      }),
    ).toThrow(/unlink syscall failed/)
    expect(calls).toBe(1)
    expect(lstatAnchor(file).type).toBe('regular-file')
  })

  it('fails a real EACCES without retry and keeps the target', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    fs.chmodSync(dir, 0o500)
    try {
      expect(() => durableUnlink(op)).toThrow(/unlink syscall failed/)
    } finally {
      fs.chmodSync(dir, 0o700)
    }
    expect(lstatAnchor(file).type).toBe('regular-file')
  })

  it('retries a transient parent fsync failure once and then succeeds', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    let calls = 0
    const evidence = durableUnlink(op, {
      fsyncDirectory: (directory) => {
        calls += 1
        if (calls === 1) throw errno('EIO')
        const fd = fs.openSync(directory, fs.constants.O_RDONLY)
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      },
    })
    expect(calls).toBe(2)
    expect(evidence.directoryFsyncCompleted).toBe(true)
    expect(lstatAnchor(file).type).toBe('absent')
  })

  it('fails closed when the transient fsync error persists and returns no evidence', () => {
    const dir = tempDir()
    const file = path.join(dir, 'agentra.db-wal')
    fs.writeFileSync(file, '')
    const op = unlinkIntent(file)
    let calls = 0
    expect(() =>
      durableUnlink(op, {
        fsyncDirectory: () => {
          calls += 1
          throw errno('EIO')
        },
      }),
    ).toThrow(/parent fsync failed/)
    expect(calls).toBe(2)
    // unlink 已发生但证据未返回：重放时 intent+缺失+无 evidence 必须 locked（由 executor 处理）。
    expect(lstatAnchor(file).type).toBe('absent')
  })
})

describe('controlledRemoveTree baseline and replay (v17 ⑮㊲㊺)', () => {
  type ReplayState = 'complete' | 'pending' | 'unknown'

  function tree(): { root: string; inventory: ReturnType<typeof inventoryDirectory> } {
    const dir = tempDir()
    const root = path.join(dir, 'live')
    fs.mkdirSync(path.join(root, 'w'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
    fs.writeFileSync(path.join(root, 'w', 'b.txt'), 'beta')
    return { root, inventory: inventoryDirectory(root) }
  }

  function callbacks(states: Map<string, ReplayState>) {
    return {
      ensureIntent: (
        entry: { relativePath: string },
        anchor: ReturnType<typeof lstatAnchor>,
      ): UnlinkIntent => ({
        operationId: `unlink:${entry.relativePath}`,
        target: anchor.path,
        targetAnchor: anchor,
        parentAnchor: lstatAnchor(path.dirname(anchor.path)),
        journalRevision: 1,
      }),
      recordComplete: (entry: { relativePath: string }) => {
        states.set(entry.relativePath, 'complete')
      },
      replay: (entry: { relativePath: string }): ReplayState =>
        states.get(entry.relativePath) ?? 'pending',
    }
  }

  it('㊺ rejects an unauthorized extra entry before deleting anything', () => {
    const { root, inventory } = tree()
    fs.writeFileSync(path.join(root, 'intruder.txt'), 'x')
    expect(() =>
      controlledRemoveTree(root, inventory, {
        ensureIntent: () => {
          throw new Error('must not run')
        },
        recordComplete: () => {},
      }),
    ).toThrow(/entry count mismatch/)
    expect(fs.existsSync(path.join(root, 'intruder.txt'))).toBe(true)
  })

  it('㊲ resumes after a crash once per-file completion evidence exists', () => {
    const { root, inventory } = tree()
    fs.rmSync(path.join(root, 'a.txt'))
    const states = new Map<string, ReplayState>([['a.txt', 'complete']])
    controlledRemoveTree(root, inventory, callbacks(states))
    expect(fs.existsSync(root)).toBe(false)
  })

  it('㊲ locks when a target is absent without completion evidence', () => {
    const { root, inventory } = tree()
    fs.rmSync(path.join(root, 'a.txt'))
    expect(() => controlledRemoveTree(root, inventory, callbacks(new Map()))).toThrow(
      /without completion evidence/,
    )
  })

  it('㊲ locks when an entry has no durable per-file record', () => {
    const { root, inventory } = tree()
    const states = new Map<string, ReplayState>([['w/b.txt', 'unknown']])
    expect(() => controlledRemoveTree(root, inventory, callbacks(states))).toThrow(
      /no durable per-file record/,
    )
  })

  it('㊲ locks when a completed unlink target reappears', () => {
    const { root, inventory } = tree()
    const states = new Map<string, ReplayState>([['a.txt', 'complete']])
    expect(() => controlledRemoveTree(root, inventory, callbacks(states))).toThrow(/reappeared/)
  })
})
