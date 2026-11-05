#!/usr/bin/env node
/**
 * 阶段 1 · 当前 Electron 运行环境（ELECTRON_RUN_AS_NODE）SQLite 基本集成验证（裁定 D-017）。
 * 覆盖：建表、参数化写入、WAL、简单快照备份（VACUUM INTO）、PRAGMA integrity_check。
 * 不等同于阶段 5.5 的完整备份恢复验收。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-sqlite-electron.mjs [dataDir]
 * 输出：单行 JSON（ok/checks/versions），失败时退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

const dataDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-electron-sqlite-'))
const ownedDir = process.argv[2] === undefined
const dbFile = path.join(dataDir, 'agentra.db')
const backupFile = path.join(dataDir, 'backup.db')

const checks = {}

try {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')

    checks.journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal'
    checks.busyTimeout = db.prepare('PRAGMA busy_timeout').get().timeout === 5000
    checks.foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1

    db.exec(`
      CREATE TABLE probe (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `)
    const insert = db.prepare('INSERT INTO probe (id, name, value) VALUES (?, ?, ?)')
    insert.run('row-1', "O'Reilly; DROP TABLE probe; --", 42)
    insert.run('row-2', 'plain', 7)
    checks.parameterizedInsert =
      db.prepare('SELECT value FROM probe WHERE id = ?').get('row-1').value === 42 &&
      db.prepare('SELECT COUNT(*) AS c FROM probe').get().c === 2

    db.exec('BEGIN IMMEDIATE')
    insert.run('row-3', 'txn', 1)
    db.exec('COMMIT')
    checks.transactionCommit = db.prepare('SELECT COUNT(*) AS c FROM probe').get().c === 3

    db.exec('BEGIN IMMEDIATE')
    insert.run('row-4', 'rollback', 2)
    db.exec('ROLLBACK')
    checks.transactionRollback = db.prepare('SELECT COUNT(*) AS c FROM probe').get().c === 3

    db.prepare('VACUUM INTO ?').run(backupFile)
    checks.backupCreated = fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0
    checks.integrityCheck = db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'
    checks.walFiles = fs.existsSync(`${dbFile}-wal`) || fs.existsSync(`${dbFile}-shm`)

    // S55-2B-1B：JSON1 能力（recovery_state_json 的 terminalProcessing 合并依赖）。
    db.exec('CREATE TABLE json_probe (id TEXT PRIMARY KEY, payload TEXT)')
    const jsonInsert = db.prepare('INSERT INTO json_probe (id, payload) VALUES (?, ?)')
    jsonInsert.run('j1', JSON.stringify({ queued: true, queuedAt: 't1', evidence: { x: 1 } }))
    db.prepare(
      "UPDATE json_probe SET payload = json_patch(COALESCE(payload, '{}'), ?) WHERE id = ?",
    ).run(JSON.stringify({ terminalProcessing: { state: 'pending', source: 'event_observed' } }), 'j1')
    const merged = JSON.parse(db.prepare('SELECT payload FROM json_probe WHERE id = ?').get('j1').payload)
    checks.jsonPatchPreservesKeys =
      merged.queued === true &&
      merged.evidence?.x === 1 &&
      merged.terminalProcessing?.state === 'pending'
    checks.jsonValidRejectsCorrupt =
      db.prepare("SELECT json_valid('{bad') AS v").get().v === 0 &&
      db.prepare('SELECT json_valid(?) AS v').get('{"ok":1}').v === 1
    checks.jsonExtractNested =
      db.prepare("SELECT json_extract('{\"a\":{\"b\":\"c\"}}', '$.a.b') AS v").get().v === 'c'
    jsonInsert.run('j2', null)
    db.prepare(
      "UPDATE json_probe SET payload = json_patch(COALESCE(payload, '{}'), ?) WHERE id = ?",
    ).run(JSON.stringify({ k: 1 }), 'j2')
    checks.jsonPatchNullColumn = JSON.parse(
      db.prepare('SELECT payload FROM json_probe WHERE id = ?').get('j2').payload,
    ).k === 1
    jsonInsert.run('j3', '{bad')
    let corruptThrew = false
    try {
      db.prepare('UPDATE json_probe SET payload = json_patch(payload, ?) WHERE id = ?').run(
        JSON.stringify({ k: 1 }),
        'j3',
      )
    } catch {
      corruptThrew = true
    }
    checks.jsonPatchRejectsCorrupt = corruptThrew
  } finally {
    db.close()
  }

  const backup = new DatabaseSync(backupFile)
  try {
    checks.backupReadable = backup.prepare('SELECT COUNT(*) AS c FROM probe').get().c === 3
    checks.backupIntegrity = backup.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'
    checks.backupPreservesData =
      backup.prepare('SELECT name FROM probe WHERE id = ?').get('row-1').name ===
      "O'Reilly; DROP TABLE probe; --"
  } finally {
    backup.close()
  }

  const failed = Object.entries(checks).filter(([, ok]) => ok !== true)
  process.stdout.write(
    `${JSON.stringify({
      ok: failed.length === 0,
      checks,
      failed: failed.map(([name]) => name),
      nodeVersion: process.versions.node,
      electron: process.versions.electron ?? null,
      dataDir,
    })}\n`,
  )
  if (failed.length > 0) process.exitCode = 1
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      checks,
      error: error instanceof Error ? error.message : String(error),
      nodeVersion: process.versions.node,
      electron: process.versions.electron ?? null,
    })}\n`,
  )
  process.exitCode = 1
} finally {
  if (ownedDir) fs.rmSync(dataDir, { recursive: true, force: true })
}
