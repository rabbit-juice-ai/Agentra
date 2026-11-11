import fs from 'node:fs'
import path from 'node:path'
import type { WorkFileEntry } from '@agentra/protocol'

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
])
const MAX_FILES = 200
const MAX_DEPTH = 3

/**
 * 团队任务没有正式 Artifact，交付物就是工作目录里的文件。
 * 只读列举、限制深度和数量，跳过隐藏文件、依赖目录与符号链接，避免越界和卡顿。
 */
export class WorkspaceFilesService {
  list(rootPath: string): {
    rootPath: string
    exists: boolean
    truncated: boolean
    files: WorkFileEntry[]
  } {
    const resolved = path.resolve(rootPath)
    let root = resolved
    try {
      root = fs.realpathSync(resolved)
    } catch {
      return { rootPath: resolved, exists: false, truncated: false, files: [] }
    }
    let rootStat: fs.Stats
    try {
      rootStat = fs.statSync(root)
    } catch {
      return { rootPath: root, exists: false, truncated: false, files: [] }
    }
    if (!rootStat.isDirectory()) {
      return { rootPath: root, exists: false, truncated: false, files: [] }
    }

    const files: WorkFileEntry[] = []
    let truncated = false

    const walk = (directory: string, depth: number): void => {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          truncated = true
          break
        }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue
          if (depth < MAX_DEPTH) walk(fullPath, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const stat = fs.lstatSync(fullPath)
          if (!stat.isFile()) continue
          files.push({
            path: path.relative(root, fullPath),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          })
        } catch {
          // 单个文件不可读不影响其余交付物列表。
        }
      }
    }

    walk(root, 1)
    files.sort((left, right) => left.path.localeCompare(right.path))
    return { rootPath: root, exists: true, truncated, files }
  }
}
