import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  RestoreDirectoryInventory,
  RestoreFileAnchor,
  RestoreManifestEntry,
} from './restore-journal'
import { fsyncDirectory } from './restore-journal'

/** S55-2C 文件操作层错误：调用方必须 fail closed 并保留现场。 */
export class RestoreFilesystemError extends Error {
  constructor(
    readonly code:
      | 'PATH_UNSAFE'
      | 'TYPE_MISMATCH'
      | 'IDENTITY_MISMATCH'
      | 'HASH_MISMATCH'
      | 'MANIFEST_MISMATCH'
      | 'TARGET_CONFLICT'
      | 'UNLINK_ATTRIBUTION_UNKNOWN'
      | 'FSYNC_FAILED'
      | 'CROSS_DEVICE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RestoreFilesystemError'
  }
}

/**
 * v17 ㊼：持久现场无法证明删除归属或身份连续性时，事务必须 recovery_locked。
 * 调用方（executor）不得把它当作可回滚的 forward 失败继续执行文件操作。
 */
export class RestoreLockedError extends RestoreFilesystemError {
  constructor(code: RestoreFilesystemError['code'], message: string, detail?: unknown) {
    super(code, message, detail)
    this.name = 'RestoreLockedError'
  }
}

/** v17 §2.4 / 继承 §4.5：系统级、与文件内容无关的暂时性错误允许重试一次。 */
const TRANSIENT_ERRNO: ReadonlySet<string> = new Set(['EIO', 'ENOSPC', 'EBUSY'])

function isTransientRestoreIoError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && TRANSIENT_ERRNO.has(code)
}

/**
 * 测试注入缝：仅用于确定性模拟暂时性 syscall 错误。生产调用不传，默认使用真实 fs。
 * 注入不改变任何安全事实或持久化顺序。
 */
export type RestoreUnlinkOps = {
  unlinkSync?: (target: string) => void
  fsyncDirectory?: (directory: string) => void
}

export type RenameIntent = {
  operationId: string
  source: string
  target: string
  sourceAnchor: RestoreFileAnchor
  targetPolicy: 'must_be_absent' | 'must_exist_and_match'
  expectedTargetAnchor: RestoreFileAnchor | null
  sourceParentAnchor: RestoreFileAnchor
  targetParentAnchor: RestoreFileAnchor
}

export type RenameDirectoryIntent = {
  operationId: string
  source: string
  target: string
  sourceAnchor: RestoreFileAnchor
  sourceInventory: RestoreDirectoryInventory
  targetPolicy: 'must_be_absent'
  sourceParentAnchor: RestoreFileAnchor
  targetParentAnchor: RestoreFileAnchor
}

export type UnlinkIntent = {
  operationId: string
  target: string
  targetAnchor: RestoreFileAnchor
  parentAnchor: RestoreFileAnchor
  journalRevision: number
}

export type UnlinkCompleteEvidence = {
  operationId: string
  target: string
  targetAbsent: true
  nlinkBefore: 1
  nlinkAfter: 0
  parentDev: number
  parentIno: number
  directoryFsyncCompleted: true
}

export function isInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function assertPathInside(target: string, root: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(target)
  if (!isInsideOrEqual(resolved, resolvedRoot)) {
    throw new RestoreFilesystemError('PATH_UNSAFE', `path escapes root: ${resolved}`, {
      root: resolvedRoot,
    })
  }
  return resolved
}

export function lstatAnchor(target: string): RestoreFileAnchor {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path: path.resolve(target),
        realPath: null,
        type: 'absent',
        dev: null,
        ino: null,
        nlink: null,
        bytes: null,
        sha256: null,
      }
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new RestoreFilesystemError('PATH_UNSAFE', `symbolic link is forbidden: ${target}`)
  }
  const type = stat.isFile() ? 'regular-file' : stat.isDirectory() ? 'directory' : null
  if (!type) {
    throw new RestoreFilesystemError('TYPE_MISMATCH', `unsupported file type: ${target}`)
  }
  const resolved = fs.realpathSync(target)
  return {
    path: path.resolve(target),
    realPath: resolved,
    type,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    bytes: stat.isFile() ? stat.size : null,
    sha256: stat.isFile() ? sha256FileByFd(target) : null,
  }
}

/** Hash through the same O_NOFOLLOW fd whose identity is returned by fstat. */
export function sha256FileByFd(file: string): string {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new RestoreFilesystemError('TYPE_MISMATCH', `not a regular file: ${file}`)
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new RestoreFilesystemError('IDENTITY_MISMATCH', `file identity changed: ${file}`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

export function assertAnchor(actual: RestoreFileAnchor, expected: RestoreFileAnchor): void {
  if (
    actual.path !== expected.path ||
    actual.type !== expected.type ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.nlink !== expected.nlink ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'file anchor mismatch', {
      actual,
      expected,
    })
  }
}

/** Directory identity deliberately excludes nlink/mtime: directory entries changed by the
 * authorized operation may change those values, while dev+ino+type must stay stable. */
export function assertDirectoryIdentity(
  actual: RestoreFileAnchor,
  expected: RestoreFileAnchor,
): void {
  if (
    actual.path !== expected.path ||
    actual.type !== 'directory' ||
    expected.type !== 'directory' ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'directory identity mismatch', {
      actual,
      expected,
    })
  }
}

export function assertSameFilesystemObject(
  actual: RestoreFileAnchor,
  expected: RestoreFileAnchor,
): void {
  if (actual.type !== expected.type || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'filesystem object identity mismatch', {
      actual,
      expected,
    })
  }
}

export function inventoryDirectory(root: string): RestoreDirectoryInventory {
  const resolvedRoot = path.resolve(root)
  const rootAnchor = lstatAnchor(resolvedRoot)
  if (rootAnchor.type !== 'directory') {
    throw new RestoreFilesystemError('TYPE_MISMATCH', `inventory root is not a directory: ${root}`)
  }
  const entries: RestoreManifestEntry[] = []
  const walk = (directory: string): void => {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        throw new RestoreFilesystemError('PATH_UNSAFE', `symlink in directory tree: ${absolute}`)
      }
      const relativePath = path.relative(resolvedRoot, absolute).split(path.sep).join('/')
      if (stat.isDirectory()) {
        entries.push({
          relativePath,
          type: 'directory',
          bytes: null,
          sha256: null,
          dev: stat.dev,
          ino: stat.ino,
        })
        walk(absolute)
      } else if (stat.isFile()) {
        entries.push({
          relativePath,
          type: 'file',
          bytes: stat.size,
          sha256: sha256FileByFd(absolute),
          dev: stat.dev,
          ino: stat.ino,
        })
      } else {
        throw new RestoreFilesystemError('TYPE_MISMATCH', `unsupported object: ${absolute}`)
      }
    }
  }
  walk(resolvedRoot)
  return { root: rootAnchor, entries }
}

export function assertInventoryContent(
  actual: RestoreDirectoryInventory,
  expected: RestoreDirectoryInventory,
  options: { compareIdentity?: boolean } = {},
): void {
  if (actual.entries.length !== expected.entries.length) {
    throw new RestoreFilesystemError('MANIFEST_MISMATCH', 'directory entry count mismatch')
  }
  const compareIdentity = options.compareIdentity ?? false
  for (let index = 0; index < actual.entries.length; index += 1) {
    const left = actual.entries[index]
    const right = expected.entries[index]
    if (
      !left ||
      !right ||
      left.relativePath !== right.relativePath ||
      left.type !== right.type ||
      left.bytes !== right.bytes ||
      left.sha256 !== right.sha256 ||
      (compareIdentity && (left.dev !== right.dev || left.ino !== right.ino))
    ) {
      throw new RestoreFilesystemError('MANIFEST_MISMATCH', 'directory manifest mismatch', {
        left,
        right,
      })
    }
  }
}

export function durableCopyFile(
  source: string,
  target: string,
  expectedSource?: RestoreFileAnchor,
): RestoreFileAnchor {
  const sourceBefore = lstatAnchor(source)
  if (sourceBefore.type !== 'regular-file') {
    throw new RestoreFilesystemError('TYPE_MISMATCH', `copy source is not a file: ${source}`)
  }
  if (expectedSource) assertAnchor(sourceBefore, expectedSource)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let targetFd: number | null = null
  try {
    const opened = fs.fstatSync(sourceFd)
    if (opened.dev !== sourceBefore.dev || opened.ino !== sourceBefore.ino || !opened.isFile()) {
      throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'copy source identity changed')
    }
    targetFd = fs.openSync(target, 'wx', 0o600)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) fs.writeSync(targetFd, buffer, 0, bytesRead)
    } while (bytesRead > 0)
    fs.fsyncSync(targetFd)
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd)
    fs.closeSync(sourceFd)
  }
  fsyncDirectory(path.dirname(target))
  const sourceAfter = lstatAnchor(source)
  assertAnchor(sourceAfter, sourceBefore)
  const result = lstatAnchor(target)
  if (
    result.type !== 'regular-file' ||
    result.bytes !== sourceBefore.bytes ||
    result.sha256 !== sourceBefore.sha256
  ) {
    throw new RestoreFilesystemError('HASH_MISMATCH', 'durable copy verification failed')
  }
  return result
}

export function durableCopyTree(
  sourceRoot: string,
  targetRoot: string,
  expectedSource?: RestoreDirectoryInventory,
): RestoreDirectoryInventory {
  const before = inventoryDirectory(sourceRoot)
  if (expectedSource) assertInventoryContent(before, expectedSource, { compareIdentity: true })
  fs.mkdirSync(targetRoot, { recursive: false, mode: 0o700 })
  for (const entry of before.entries) {
    const source = path.join(sourceRoot, ...entry.relativePath.split('/'))
    const target = path.join(targetRoot, ...entry.relativePath.split('/'))
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { mode: 0o700 })
      fsyncDirectory(path.dirname(target))
    } else {
      durableCopyFile(source, target)
    }
  }
  fsyncDirectory(targetRoot)
  fsyncDirectory(path.dirname(targetRoot))
  const sourceAfter = inventoryDirectory(sourceRoot)
  assertInventoryContent(sourceAfter, before, { compareIdentity: true })
  const targetAfter = inventoryDirectory(targetRoot)
  assertInventoryContent(targetAfter, before)
  return targetAfter
}

export function durableRename(intent: RenameIntent): RestoreFileAnchor {
  const source = lstatAnchor(intent.source)
  assertAnchor(source, intent.sourceAnchor)
  if (source.type !== 'regular-file') {
    throw new RestoreFilesystemError('TYPE_MISMATCH', 'rename source must be a regular file')
  }
  const sourceParent = lstatAnchor(path.dirname(intent.source))
  const targetParent = lstatAnchor(path.dirname(intent.target))
  assertDirectoryIdentity(sourceParent, intent.sourceParentAnchor)
  assertDirectoryIdentity(targetParent, intent.targetParentAnchor)

  const targetBefore = lstatAnchor(intent.target)
  if (intent.targetPolicy === 'must_be_absent') {
    if (targetBefore.type !== 'absent') {
      throw new RestoreFilesystemError('TARGET_CONFLICT', 'rename target must be absent')
    }
  } else {
    if (!intent.expectedTargetAnchor) {
      throw new RestoreFilesystemError('TARGET_CONFLICT', 'expected target anchor is missing')
    }
    assertAnchor(targetBefore, intent.expectedTargetAnchor)
    if (targetBefore.type !== 'regular-file') {
      throw new RestoreFilesystemError('TYPE_MISMATCH', 'rename target must be a regular file')
    }
  }

  // Final path identity recheck immediately before rename. Pure Node cannot remove
  // the final path-level TOCTOU window; correctness therefore also depends on T3.
  assertAnchor(lstatAnchor(intent.source), source)
  const finalTarget = lstatAnchor(intent.target)
  if (intent.targetPolicy === 'must_be_absent') {
    if (finalTarget.type !== 'absent')
      throw new RestoreFilesystemError('TARGET_CONFLICT', 'target changed')
  } else {
    assertAnchor(finalTarget, intent.expectedTargetAnchor as RestoreFileAnchor)
  }
  assertAnchor(lstatAnchor(path.dirname(intent.source)), sourceParent)
  assertAnchor(lstatAnchor(path.dirname(intent.target)), targetParent)

  fs.renameSync(intent.source, intent.target)
  const sourceParentPath = path.dirname(intent.source)
  const targetParentPath = path.dirname(intent.target)
  fsyncDirectory(sourceParentPath)
  if (targetParentPath !== sourceParentPath) fsyncDirectory(targetParentPath)

  const installed = lstatAnchor(intent.target)
  if (
    installed.type !== 'regular-file' ||
    installed.dev !== source.dev ||
    installed.ino !== source.ino ||
    installed.bytes !== source.bytes ||
    installed.sha256 !== source.sha256 ||
    lstatAnchor(intent.source).type !== 'absent'
  ) {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'rename postcondition failed')
  }
  assertDirectoryIdentity(lstatAnchor(sourceParentPath), sourceParent)
  assertDirectoryIdentity(lstatAnchor(targetParentPath), targetParent)
  return installed
}

export function verifyRenameReplay(intent: RenameIntent): RestoreFileAnchor {
  const source = lstatAnchor(intent.source)
  const target = lstatAnchor(intent.target)
  if (source.type !== 'absent') {
    throw new RestoreFilesystemError('TARGET_CONFLICT', 'rename replay source still exists')
  }
  if (
    target.type !== intent.sourceAnchor.type ||
    target.dev !== intent.sourceAnchor.dev ||
    target.ino !== intent.sourceAnchor.ino ||
    target.bytes !== intent.sourceAnchor.bytes ||
    target.sha256 !== intent.sourceAnchor.sha256
  ) {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'rename replay target mismatch')
  }
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.source)), intent.sourceParentAnchor)
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.target)), intent.targetParentAnchor)
  fsyncDirectory(path.dirname(intent.source))
  if (path.dirname(intent.target) !== path.dirname(intent.source)) {
    fsyncDirectory(path.dirname(intent.target))
  }
  return lstatAnchor(intent.target)
}

export function durableRenameDirectory(intent: RenameDirectoryIntent): RestoreDirectoryInventory {
  const source = lstatAnchor(intent.source)
  assertDirectoryIdentity(source, intent.sourceAnchor)
  const sourceInventory = inventoryDirectory(intent.source)
  assertInventoryContent(sourceInventory, intent.sourceInventory, { compareIdentity: true })
  if (lstatAnchor(intent.target).type !== 'absent') {
    throw new RestoreFilesystemError('TARGET_CONFLICT', 'directory rename target must be absent')
  }
  const sourceParent = lstatAnchor(path.dirname(intent.source))
  const targetParent = lstatAnchor(path.dirname(intent.target))
  assertDirectoryIdentity(sourceParent, intent.sourceParentAnchor)
  assertDirectoryIdentity(targetParent, intent.targetParentAnchor)
  // Final recheck before the path-level rename; T3 remains a required environment assumption.
  assertInventoryContent(inventoryDirectory(intent.source), sourceInventory, {
    compareIdentity: true,
  })
  if (lstatAnchor(intent.target).type !== 'absent') {
    throw new RestoreFilesystemError('TARGET_CONFLICT', 'directory target changed before rename')
  }
  fs.renameSync(intent.source, intent.target)
  fsyncDirectory(path.dirname(intent.source))
  if (path.dirname(intent.target) !== path.dirname(intent.source)) {
    fsyncDirectory(path.dirname(intent.target))
  }
  if (lstatAnchor(intent.source).type !== 'absent') {
    throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'directory source still exists')
  }
  const target = inventoryDirectory(intent.target)
  assertSameFilesystemObject(target.root, source)
  assertInventoryContent(target, sourceInventory)
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.source)), sourceParent)
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.target)), targetParent)
  return target
}

/**
 * S55-2C 目录 rename 崩溃重放（v17 ⑭/㉝㉞）：rename 已生效但 Journal 未记完成时，
 * 只接受「source 缺失 + target 与 source 身份连续 + 清单全等 + 父目录身份一致」。
 */
export function verifyRenameDirectoryReplay(
  intent: RenameDirectoryIntent,
): RestoreDirectoryInventory {
  if (lstatAnchor(intent.source).type !== 'absent') {
    throw new RestoreFilesystemError(
      'TARGET_CONFLICT',
      'directory rename replay source still exists',
    )
  }
  const target = inventoryDirectory(intent.target)
  assertSameFilesystemObject(target.root, intent.sourceAnchor)
  assertInventoryContent(target, intent.sourceInventory)
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.source)), intent.sourceParentAnchor)
  assertDirectoryIdentity(lstatAnchor(path.dirname(intent.target)), intent.targetParentAnchor)
  fsyncDirectory(path.dirname(intent.source))
  if (path.dirname(intent.target) !== path.dirname(intent.source)) {
    fsyncDirectory(path.dirname(intent.target))
  }
  return target
}

/**
 * S55-2C 15-step unlink protocol. complete evidence is returned only after all
 * postconditions and directory fsync succeed. A crash after unlink but before
 * this return is intentionally ambiguous and must recovery-lock on restart.
 */
export function durableUnlink(
  intent: UnlinkIntent,
  ops: RestoreUnlinkOps = {},
): UnlinkCompleteEvidence {
  const unlink = ops.unlinkSync ?? ((target: string) => fs.unlinkSync(target))
  const fsyncDir = ops.fsyncDirectory ?? fsyncDirectory

  const initial = lstatAnchor(intent.target)
  assertAnchor(initial, intent.targetAnchor)
  if (initial.type !== 'regular-file' || initial.nlink !== 1) {
    throw new RestoreFilesystemError('TYPE_MISMATCH', 'unlink target must be one-link regular file')
  }
  const parentPath = path.dirname(intent.target)
  const parent = lstatAnchor(parentPath)
  assertDirectoryIdentity(parent, intent.parentAnchor)

  const fd = fs.openSync(intent.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== initial.bytes
    ) {
      throw new RestoreFilesystemError('IDENTITY_MISMATCH', 'unlink fd identity mismatch')
    }
    // sha256FileByFd re-opens; use the held fd directly here.
    const hash = hashOpenFile(fd)
    if (hash !== initial.sha256) {
      throw new RestoreFilesystemError('HASH_MISMATCH', 'unlink target content changed')
    }

    // v17 §2.4：syscall 前暂时性错误允许重试一次；ENOENT 与确定性错误不重试。
    // 每次尝试前都重新验证路径身份与父目录，保持 15 步顺序不变。
    let unlinkFailure: unknown = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const current = lstatAnchor(intent.target)
      if (current.type === 'absent') {
        throw new RestoreFilesystemError(
          'UNLINK_ATTRIBUTION_UNKNOWN',
          attempt === 1
            ? 'unlink target disappeared before syscall'
            : 'unlink target disappeared before retry',
        )
      }
      assertAnchor(current, initial)
      assertDirectoryIdentity(lstatAnchor(parentPath), parent)
      try {
        unlink(intent.target)
        unlinkFailure = null
        break
      } catch (error) {
        unlinkFailure = error
        // ENOENT：删除归属不可证明，禁止重试与推断。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        if (!isTransientRestoreIoError(error) || attempt === 2) break
      }
    }
    if (unlinkFailure) {
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `unlink syscall failed: ${String(unlinkFailure)}`,
      )
    }
    if (lstatAnchor(intent.target).type !== 'absent') {
      throw new RestoreFilesystemError('UNLINK_ATTRIBUTION_UNKNOWN', 'unlink target still exists')
    }
    const after = fs.fstatSync(fd)
    if (after.nlink !== 0) {
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `held inode link count is ${after.nlink}, expected 0`,
      )
    }

    // v17 §2.4：父目录 fsync 暂时性错误重试一次；仍败进入失败/锁定路径。
    let fsyncFailure: unknown = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        fsyncDir(parentPath)
        fsyncFailure = null
        break
      } catch (error) {
        fsyncFailure = error
        if (!isTransientRestoreIoError(error) || attempt === 2) break
      }
    }
    if (fsyncFailure) {
      throw new RestoreFilesystemError(
        'FSYNC_FAILED',
        `unlink parent fsync failed: ${String(fsyncFailure)}`,
      )
    }

    // v17 §2.4：最终身份复核失败允许重试一次；仍败进入失败/锁定路径。
    let finalFailure: unknown = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (lstatAnchor(intent.target).type !== 'absent') {
          throw new RestoreFilesystemError(
            'UNLINK_ATTRIBUTION_UNKNOWN',
            'target reappeared after fsync',
          )
        }
        assertDirectoryIdentity(lstatAnchor(parentPath), parent)
        finalFailure = null
        break
      } catch (error) {
        finalFailure = error
        if (attempt === 2) break
      }
    }
    if (finalFailure) {
      if (finalFailure instanceof RestoreFilesystemError) throw finalFailure
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `final unlink recheck failed: ${String(finalFailure)}`,
      )
    }

    return {
      operationId: intent.operationId,
      target: intent.target,
      targetAbsent: true,
      nlinkBefore: 1,
      nlinkAfter: 0,
      parentDev: parent.dev as number,
      parentIno: parent.ino as number,
      directoryFsyncCompleted: true,
    }
  } finally {
    fs.closeSync(fd)
  }
}

export function assertUnlinkReplayNeedsLock(
  intent: UnlinkIntent,
  completeEvidence: UnlinkCompleteEvidence | null,
): void {
  const target = lstatAnchor(intent.target)
  if (!completeEvidence && target.type === 'absent') {
    throw new RestoreFilesystemError(
      'UNLINK_ATTRIBUTION_UNKNOWN',
      'unlink intent exists but target is absent without durable completion evidence',
    )
  }
  if (completeEvidence) {
    if (target.type !== 'absent') {
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        'completed unlink target reappeared',
      )
    }
    assertDirectoryIdentity(lstatAnchor(path.dirname(intent.target)), intent.parentAnchor)
  }
}

export type ControlledRemoveReplayState = 'complete' | 'pending' | 'unknown'

export function controlledRemoveTree(
  root: string,
  inventory: RestoreDirectoryInventory,
  callbacks: {
    ensureIntent: (entry: RestoreManifestEntry, anchor: RestoreFileAnchor) => UnlinkIntent
    recordComplete: (entry: RestoreManifestEntry, evidence: UnlinkCompleteEvidence) => void
    /**
     * S55-2C 崩溃重放（v17 ⑮/㊲–㊵）：按持久 per-file 记录判定现场。
     * 缺省表示首次执行——仍做严格基线比对。
     * - complete：已有 completeEvidence，target 必须缺失；重现→locked
     * - pending：有 intent 或尚未开始，target 必须存在
     * - unknown：清单内文件无持久记录 → locked（清单外新增/记录缺失）
     */
    replay?: (entry: RestoreManifestEntry) => ControlledRemoveReplayState
  },
): void {
  if (!callbacks.replay) {
    const current = inventoryDirectory(root)
    assertInventoryContent(current, inventory, { compareIdentity: true })
  }
  const files = [...inventory.entries]
    .filter((entry) => entry.type === 'file')
    .sort((a, b) => b.relativePath.localeCompare(a.relativePath))
  for (const entry of files) {
    const target = path.join(root, ...entry.relativePath.split('/'))
    const state = callbacks.replay?.(entry) ?? 'pending'
    if (state === 'complete') {
      if (lstatAnchor(target).type !== 'absent') {
        throw new RestoreFilesystemError(
          'TARGET_CONFLICT',
          `completed unlink target reappeared: ${target}`,
        )
      }
      continue
    }
    if (state === 'unknown') {
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `no durable per-file record for ${entry.relativePath}`,
      )
    }
    const anchor = lstatAnchor(target)
    if (anchor.type === 'absent') {
      throw new RestoreFilesystemError(
        'UNLINK_ATTRIBUTION_UNKNOWN',
        `unlink target missing without completion evidence: ${target}`,
      )
    }
    const intent = callbacks.ensureIntent(entry, anchor)
    const evidence = durableUnlink(intent)
    callbacks.recordComplete(entry, evidence)
  }
  const directories = [...inventory.entries]
    .filter((entry) => entry.type === 'directory')
    .sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length)
  for (const entry of directories) {
    const directory = path.join(root, ...entry.relativePath.split('/'))
    const anchor = lstatAnchor(directory)
    if (anchor.type === 'absent') {
      if (callbacks.replay) continue
      throw new RestoreFilesystemError('TARGET_CONFLICT', `directory missing: ${directory}`)
    }
    if (anchor.type !== 'directory') {
      throw new RestoreFilesystemError('TYPE_MISMATCH', `not a directory: ${directory}`)
    }
    if (fs.readdirSync(directory).length !== 0) {
      throw new RestoreFilesystemError('TARGET_CONFLICT', `directory is not empty: ${directory}`)
    }
    fs.rmdirSync(directory)
    fsyncDirectory(path.dirname(directory))
  }
  const rootAnchor = lstatAnchor(root)
  if (rootAnchor.type === 'absent') {
    if (callbacks.replay) return
    throw new RestoreFilesystemError('TARGET_CONFLICT', `root already absent: ${root}`)
  }
  if (fs.readdirSync(root).length !== 0) {
    throw new RestoreFilesystemError('TARGET_CONFLICT', `root is not empty: ${root}`)
  }
  fs.rmdirSync(root)
  fsyncDirectory(path.dirname(root))
}

export function assertSameDevice(...paths: string[]): number {
  const devices = paths.map((entry) => fs.statSync(entry).dev)
  if (new Set(devices).size !== 1) {
    throw new RestoreFilesystemError('CROSS_DEVICE', 'Restore paths are not on one filesystem', {
      paths,
      devices,
    })
  }
  return devices[0] as number
}

export function availableBytes(target: string): number {
  const stat = fs.statfsSync(target)
  return stat.bavail * stat.bsize
}

function hashOpenFile(fd: number): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  let bytesRead = 0
  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset)
    if (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } while (bytesRead > 0)
  return hash.digest('hex')
}
