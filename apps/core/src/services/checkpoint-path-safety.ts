import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type CheckpointPathErrorCode =
  | 'PATH_UNSAFE'
  | 'SYMLINK'
  | 'NOT_REGULAR'
  | 'TOO_LARGE'
  | 'UNREADABLE'

export class CheckpointPathError extends Error {
  constructor(
    readonly code: CheckpointPathErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CheckpointPathError'
  }
}

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.agentra',
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  'coverage',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
])

const EXCLUDED_BASENAME_PATTERNS = [
  /^\.env(?:$|\.)/,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^credentials/i,
  /\.log$/i,
  /\.tmp$/i,
]

/** 相对路径规范化；拒绝绝对路径、NUL、空路径和路径穿越。 */
export function normalizeRelativePath(input: string): string {
  if (input.length === 0) throw new CheckpointPathError('PATH_UNSAFE', 'path must not be empty')
  if (input.includes('\0')) throw new CheckpointPathError('PATH_UNSAFE', 'path contains NUL')
  if (path.isAbsolute(input)) {
    throw new CheckpointPathError('PATH_UNSAFE', `absolute path is not allowed: ${input}`)
  }
  const normalized = path.normalize(input)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new CheckpointPathError('PATH_UNSAFE', `path escapes root: ${input}`)
  }
  if (path.isAbsolute(normalized)) {
    throw new CheckpointPathError('PATH_UNSAFE', `absolute path is not allowed: ${input}`)
  }
  return normalized
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')
  const segments = normalized.split('/')
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true
  const basename = segments[segments.length - 1] ?? ''
  return EXCLUDED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))
}

/**
 * 解析 root 内的目标路径。root 必须存在；目标可以不存在（用于删除证据）。
 * 任何一级符号链接、realpath 逃逸都拒绝。
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const rootReal = fs.realpathSync(root)
  const normalized = normalizeRelativePath(relativePath)
  const target = path.resolve(rootReal, normalized)
  if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
    throw new CheckpointPathError('PATH_UNSAFE', `path escapes root: ${relativePath}`)
  }

  const parts = normalized.split(path.sep)
  let current = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] as string)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink()) {
      throw new CheckpointPathError('SYMLINK', `path contains symlink: ${relativePath}`)
    }
  }

  if (fs.existsSync(target)) {
    const targetReal = fs.realpathSync(target)
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new CheckpointPathError('PATH_UNSAFE', `realpath escapes root: ${relativePath}`)
    }
    return targetReal
  }
  return target
}

export type HashedFile = { size: number; sha256: string }

/** 只读取普通文件；O_NOFOLLOW + fstat；超过 maxBytes 拒绝。 */
export function hashFileNoFollow(filePath: string, maxBytes: number): HashedFile {
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new CheckpointPathError('SYMLINK', `symlink: ${filePath}`)
    throw new CheckpointPathError('UNREADABLE', `cannot open file: ${filePath}`)
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      throw new CheckpointPathError('NOT_REGULAR', `not a regular file: ${filePath}`)
    }
    if (stat.size > maxBytes) {
      throw new CheckpointPathError(
        'TOO_LARGE',
        `file exceeds ${maxBytes} bytes: ${filePath} (${stat.size})`,
      )
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      total += read
      if (total > maxBytes) {
        throw new CheckpointPathError('TOO_LARGE', `file exceeds ${maxBytes} bytes: ${filePath}`)
      }
      hash.update(buffer.subarray(0, read))
    }
    return { size: total, sha256: hash.digest('hex') }
  } finally {
    fs.closeSync(fd)
  }
}

export function isRegularFileNoFollow(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}
