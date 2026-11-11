import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceFilesService } from './workspace-files-service'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-work-files-'))
  dirs.push(dir)
  return dir
}

describe('WorkspaceFilesService', () => {
  it('lists deliverables recursively while skipping dependencies, hidden files and symlinks', () => {
    const root = tempRoot()
    const outside = tempRoot()
    fs.writeFileSync(path.join(root, 'server.js'), 'console.log(1)')
    fs.writeFileSync(path.join(root, 'README.md'), '# readme')
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    fs.mkdirSync(path.join(root, 'docs'))
    fs.writeFileSync(path.join(root, 'docs', 'PROTOCOL.md'), '# protocol')
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'node_modules', 'dependency.js'), 'x')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))

    const result = new WorkspaceFilesService().list(root)
    expect(result.exists).toBe(true)
    expect(result.files.map((file) => file.path)).toEqual([
      'docs/PROTOCOL.md',
      'README.md',
      'server.js',
    ])
    expect(result.files.find((file) => file.path === 'server.js')?.size).toBe(14)
  })

  it('returns exists=false for a missing or non-directory root', () => {
    const root = tempRoot()
    const missing = path.join(root, 'missing')
    expect(new WorkspaceFilesService().list(missing)).toMatchObject({
      exists: false,
      files: [],
    })
    const file = path.join(root, 'file.txt')
    fs.writeFileSync(file, 'x')
    expect(new WorkspaceFilesService().list(file)).toMatchObject({ exists: false, files: [] })
  })
})
