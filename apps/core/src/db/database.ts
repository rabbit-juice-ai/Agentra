import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Database = DatabaseSync

/**
 * 打开 Core 业务数据库（D-016：node:sqlite，无 ORM）。
 * WAL + busy_timeout + foreign_keys；写操作由 transaction() 包裹。
 */
export function openDatabase(file: string): Database {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/**
 * 事务封装：BEGIN IMMEDIATE → fn → COMMIT；异常回滚并原样抛出（不吞异常）。
 * 不支持嵌套（调用方不得在事务内再次调用）。
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败不能掩盖原始异常。
    }
    throw error
  }
}
