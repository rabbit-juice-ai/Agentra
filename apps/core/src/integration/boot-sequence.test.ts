import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_LIST_METHOD,
  CORE_MAINTENANCE_STATUS_METHOD,
  EVENTS_SUBSCRIBE_METHOD,
  PROTOCOL_VERSION,
  type RpcResponse,
} from '@agentra/protocol'
import { agentraPaths, ensureDirs } from '@agentra/shared'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { probeSocket } from '../daemon-launcher'
import { openDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { ArtifactRepository } from '../db/repositories/artifact-repository'
import { AuditRepository } from '../db/repositories/audit-repository'
import { BackupRepository } from '../db/repositories/backup-repository'
import { RestoreJournalStore, RestoreMarkerSchema } from '../lifecycle/restore-journal'
import { BackupService } from '../services/backup-service'

const CORE_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url))

const dirs: string[] = []
const cores: ChildProcess[] = []

function tempDataDir(): string {
  // 前缀保持短：sun_path 预算 90 字节，测试机 tmpdir 本身已较长。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a-boot-'))
  dirs.push(dir)
  return dir
}

function spawnCore(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', CORE_ENTRY], {
    env: { ...process.env, AGENTRA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 持续消费输出，避免管道缓冲填满阻塞子进程。
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  cores.push(child)
  return child
}

function call(socketPath: string, method: string, params: unknown = {}): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:`)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`rpc ${method} timed out`))
    }, 5_000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
          protocolVersion: PROTOCOL_VERSION,
          method,
          params,
        }),
      ),
    )
    ws.on('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(String(data)) as RpcResponse)
      ws.close()
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

async function maintenanceState(socketPath: string): Promise<string> {
  const response = await call(socketPath, CORE_MAINTENANCE_STATUS_METHOD)
  if (!response.ok) throw new Error(`status failed: ${response.error.code}`)
  return (response.result as { state: string }).state
}

function stopDaemon(dataDir: string): void {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'runtime', 'daemon.pid'), 'utf8')
    const { pid } = JSON.parse(raw) as { pid?: number }
    if (typeof pid === 'number') process.kill(pid, 'SIGTERM')
  } catch {
    // daemon 未启动或已退出。
  }
}

afterAll(async () => {
  for (const core of cores.splice(0)) {
    if (core.exitCode === null && core.signalCode === null) {
      core.kill('SIGTERM')
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const dir of dirs.splice(0)) {
    stopDaemon(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('real Core boot sequence (S55-2B-1B)', () => {
  it('exposes boot socket first, opens business socket only after recovery, and exits cleanly', async () => {
    const dataDir = tempDataDir()
    const bootSocket = path.join(dataDir, 'runtime', 'boot.sock')
    const coreSocket = path.join(dataDir, 'runtime', 'core.sock')
    const core = spawnCore(dataDir)
    let stderr = ''
    core.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    // 1) boot socket 先出现；此时状态必须是 booting/recovering，且业务方法物理不存在。
    try {
      await waitFor(async () => (await probeSocket(bootSocket)) === 'live', 30_000)
    } catch (error) {
      throw new Error(`${String(error)}\ncore stderr:\n${stderr}`)
    }
    const earlyState = await maintenanceState(bootSocket)
    expect(['booting', 'recovering']).toContain(earlyState)
    const earlyBusiness = await call(bootSocket, EVENTS_SUBSCRIBE_METHOD)
    expect(earlyBusiness.ok).toBe(false)
    if (!earlyBusiness.ok) expect(earlyBusiness.error.code).toBe('METHOD_NOT_FOUND')

    // 2) 等待业务 socket 出现；normal 只能在业务 socket 已监听之后出现。
    await waitFor(async () => (await probeSocket(coreSocket)) === 'live', 60_000)
    let sawNormal = false
    for (let i = 0; i < 200 && !sawNormal; i += 1) {
      const state = await maintenanceState(bootSocket)
      if (state === 'normal') {
        sawNormal = true
        break
      }
      // recovering 期间业务 RPC 必须被 gate 拒绝（若 socket 已可连）。
      if (state === 'booting' || state === 'recovering') {
        const denied = await call(coreSocket, AGENT_LIST_METHOD)
        expect(denied.ok).toBe(false)
        if (!denied.ok) expect(denied.error.code).toBe('RECOVERY_LOCKED')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(sawNormal).toBe(true)

    // 3) normal 后业务 RPC 可用。
    const agents = await call(coreSocket, AGENT_LIST_METHOD)
    expect(agents.ok).toBe(true)

    // 4) SIGTERM 正常退出；boot.sock 被清理；boot lock 文件保留（永不 unlink）。
    const exited = new Promise<number | null>((resolve) => core.once('exit', resolve))
    core.kill('SIGTERM')
    const code = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ])
    expect(code).toBe(0)
    expect(await probeSocket(bootSocket)).not.toBe('live')
    expect(fs.existsSync(path.join(dataDir, 'runtime', 'core.lock'))).toBe(true)
  }, 120_000)

  it('refuses a second Core while the first holds the boot lock', async () => {
    const dataDir = tempDataDir()
    const bootSocket = path.join(dataDir, 'runtime', 'boot.sock')
    const first = spawnCore(dataDir)
    await waitFor(async () => (await probeSocket(bootSocket)) === 'live', 30_000)

    const second = spawnCore(dataDir)
    let stderr = ''
    second.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const secondExit = new Promise<number | null>((resolve) => second.once('exit', resolve))
    const code = await Promise.race([
      secondExit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ])
    expect(code).toBe(1)
    expect(stderr).toContain('boot lock')

    // 等第一个 Core 完成启动（SIGTERM 处理器已注册）再关闭，验证正常退出路径。
    await waitFor(async () => (await maintenanceState(bootSocket)) === 'normal', 30_000)
    const firstExit = new Promise<number | null>((resolve) => first.once('exit', resolve))
    first.kill('SIGTERM')
    expect(
      await Promise.race([
        firstExit,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]),
    ).toBe(0)
  }, 120_000)

  it('restores from an active handed_off journal before opening business RPC', async () => {
    const dataDir = tempDataDir()
    const paths = agentraPaths(dataDir)
    ensureDirs(paths)
    const now = new Date().toISOString()

    const live = openDatabase(paths.database)
    let targetBackupId = ''
    let preBackupId = ''
    let journalId = ''
    try {
      migrate(live)
      live.exec(
        `INSERT INTO works (id, name, description, objective, status, priority, root_path,
           repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('restored-work', 'Restored', '', '', 'draft', 'normal', '/tmp/restored', NULL, '{}', '${now}', '${now}', NULL)`,
      )
      const backups = new BackupRepository(live)
      const service = new BackupService(
        live,
        backups,
        new ArtifactRepository(live),
        new AuditRepository(live),
        paths.backups,
        paths.artifacts,
      )
      const targetBackup = service.create({ type: 'manual' })
      targetBackupId = targetBackup.id
      live.exec(
        `INSERT INTO works (id, name, description, objective, status, priority, root_path,
           repository_path, settings_json, created_at, updated_at, completed_at)
         VALUES ('live-work', 'Live', '', '', 'draft', 'normal', '/tmp/live', NULL, '{}', '${now}', '${now}', NULL)`,
      )
      const preBackup = service.create({ type: 'pre_restore' })
      preBackupId = preBackup.id
      const preRow = backups.get(preBackup.id)
      if (!preRow?.dbSha256 || !preRow.completedAt || !preRow.verifiedAt) {
        throw new Error('pre_restore row incomplete')
      }

      const store = new RestoreJournalStore({
        restoreRoot: paths.restore,
        journalA: paths.restoreJournalA,
        journalB: paths.restoreJournalB,
        activeMarker: paths.restoreActiveMarker,
        archiveRoot: paths.restoreArchive,
      })
      let journal = store.createInitial({ backupId: targetBackup.id, now })
      journal = store.writeNext(
        journal,
        (draft) => {
          draft.targetBackupPath = targetBackup.storagePath
        },
        now,
      )
      const marker = RestoreMarkerSchema.parse({
        markerVersion: 1,
        journalId: journal.journalId,
        backupId: journal.backupId,
        createdAt: now,
        canonicalForm: 1,
      })
      const parent = fs.lstatSync(paths.restore)
      journal = store.createActivationIntent(
        journal,
        marker,
        { path: paths.restore, dev: parent.dev, ino: parent.ino },
        now,
      )
      store.createActiveMarker(marker)
      journal = store.verifyAndConfirmActivation(journal, now)
      journal = store.writeNext(
        journal,
        (draft) => {
          draft.phase = 'prepared'
          draft.preRestoreBackupId = preRow.id
          draft.preRestoreBackupRecord = {
            manifestVersion: preRow.manifestVersion,
            dbSha256: preRow.dbSha256 as string,
            files: preRow.artifactFiles,
            storagePath: preRow.storagePath,
            createdAt: preRow.createdAt,
            completedAt: preRow.completedAt as string,
            verifiedAt: preRow.verifiedAt as string,
          }
          draft.steps.preRestoreVerified = true
        },
        now,
      )
      journal = store.writeNext(
        journal,
        (draft) => {
          draft.phase = 'drained'
          draft.steps.drained = true
          draft.steps.ingressPaused = true
          draft.steps.checkpointed = true
        },
        now,
      )
      journal = store.writeNext(
        journal,
        (draft) => {
          draft.phase = 'handed_off'
          draft.steps.handedOff = true
        },
        now,
      )
      journalId = journal.journalId
    } finally {
      live.close()
    }

    const bootSocket = path.join(dataDir, 'runtime', 'boot.sock')
    const core = spawnCore(dataDir)
    let stderr = ''
    core.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    try {
      await waitFor(async () => (await probeSocket(bootSocket)) === 'live', 30_000)
      await waitFor(async () => (await maintenanceState(bootSocket)) === 'normal', 120_000)
    } catch (error) {
      throw new Error(`${String(error)}\ncore stderr:\n${stderr}`)
    }

    // 终态收尾：marker 删除、active Journal 退役、正式 Archive verified。
    expect(fs.existsSync(paths.restoreActiveMarker)).toBe(false)
    expect(fs.existsSync(paths.restoreJournalA)).toBe(false)
    expect(fs.existsSync(paths.restoreJournalB)).toBe(false)
    const archive = JSON.parse(
      fs.readFileSync(path.join(paths.restoreArchive, journalId, 'journal.json'), 'utf8'),
    ) as { terminalSnapshot: { terminalPhase: string } }
    expect(archive.terminalSnapshot.terminalPhase).toBe('completed')

    const restored = openDatabase(paths.database)
    try {
      expect(
        restored.prepare("SELECT name FROM works WHERE id='restored-work'").get(),
      ).toMatchObject({ name: 'Restored' })
      expect(
        restored.prepare("SELECT COUNT(*) AS c FROM works WHERE id='live-work'").get(),
      ).toMatchObject({ c: 0 })
      expect(
        restored.prepare('SELECT status FROM backups WHERE id = ?').get(targetBackupId),
      ).toMatchObject({ status: 'restored' })
      expect(
        restored.prepare('SELECT status FROM backups WHERE id = ?').get(preBackupId),
      ).toMatchObject({ status: 'verified' })
    } finally {
      restored.close()
    }

    const exited = new Promise<number | null>((resolve) => core.once('exit', resolve))
    core.kill('SIGTERM')
    expect(
      await Promise.race([
        exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]),
    ).toBe(0)
  }, 180_000)
})
