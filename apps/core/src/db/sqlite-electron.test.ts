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

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('electron runtime sqlite verification', () => {
  it('passes schema, parameterized writes, WAL, snapshot backup and integrity_check', () => {
    // D-017 阶段 1 验收⑦：本项是"必须完成"的验证，缺失运行环境时判失败而不是 skip——
    // skip 会让没装 Electron 的环境（含禁用二进制下载的 CI）显示为绿色。
    if (!electronBinary) {
      throw new Error(
        'Electron 二进制未找到（apps/desktop/node_modules/electron）。该项验收不可跳过，请先执行 pnpm install。',
      )
    }
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Electron SQLite 验证脚本缺失：${scriptPath}`)
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ele-'))
    dirs.push(dataDir)

    const result = spawnSync(electronBinary, [scriptPath, dataDir], {
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
