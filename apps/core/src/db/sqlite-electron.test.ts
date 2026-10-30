import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * 验收 7（裁定 D-017）：当前 Electron 运行环境（ELECTRON_RUN_AS_NODE）下
 * SQLite 基本集成验证。脚本本身位于 scripts/verify-sqlite-electron.mjs。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../../..')
const electronDir = path.join(repoRoot, 'apps', 'desktop', 'node_modules', 'electron')
const scriptPath = path.join(repoRoot, 'scripts', 'verify-sqlite-electron.mjs')

function resolveElectronBinary(): string | null {
  try {
    const relative = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
    const binary = path.join(electronDir, 'dist', relative)
    return fs.existsSync(binary) ? binary : null
  } catch {
    return null
  }
}

const electronBinary = resolveElectronBinary()
const available = electronBinary !== null && fs.existsSync(scriptPath)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!available)('electron runtime sqlite verification', () => {
  it('passes schema, parameterized writes, WAL, snapshot backup and integrity_check', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ele-'))
    dirs.push(dataDir)

    const result = spawnSync(electronBinary as string, [scriptPath, dataDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(result.error).toBeUndefined()
    const output = (result.stdout ?? '').trim().split('\n').pop() ?? ''
    let parsed: {
      ok: boolean
      checks: Record<string, boolean>
      nodeVersion: string
      electron: string | null
      error?: string
    }
    try {
      parsed = JSON.parse(output)
    } catch {
      throw new Error(
        `electron sqlite script produced no JSON. status=${result.status} stderr=${result.stderr}`,
      )
    }

    expect(parsed.error).toBeUndefined()
    expect(parsed.ok).toBe(true)
    expect(parsed.checks).toMatchObject({
      journalMode: true,
      busyTimeout: true,
      foreignKeys: true,
      parameterizedInsert: true,
      transactionCommit: true,
      transactionRollback: true,
      backupCreated: true,
      integrityCheck: true,
      backupReadable: true,
      backupIntegrity: true,
      backupPreservesData: true,
    })
    expect(parsed.electron).toBeTruthy()
    expect(parsed.nodeVersion).toMatch(/^\d+\./)
    expect(result.status).toBe(0)
  }, 150_000)
})
