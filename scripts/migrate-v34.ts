import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../apps/core/src/db/database'
import { currentUserVersion, migrate } from '../apps/core/src/db/migrations'

/**
 * Phase 1B-2B 正式库迁移入口（v33 → v34）。
 * 必须先完成 D-013 一致性备份，再执行：
 *   pnpm db:migrate:v34 --yes
 */
const file =
  process.env.AGENTRA_DB ??
  path.join(os.homedir(), 'Library/Application Support/Agentra/agentra.db')

if (!process.argv.includes('--yes')) {
  console.error('Refusing to migrate without --yes. Back up the database first (D-013).')
  process.exit(2)
}

const db = openDatabase(file)
try {
  const before = currentUserVersion(db)
  if (before === 34) {
    console.log(`already at v34: ${file}`)
  } else if (before !== 33) {
    console.error(`unexpected user_version ${before}; expected 33`)
    process.exit(3)
  } else {
    const result = migrate(db)
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
    console.log(
      JSON.stringify(
        { file, result, userVersion: currentUserVersion(db), integrity, foreignKeys },
        null,
        2,
      ),
    )
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') process.exit(4)
    if (foreignKeys.length > 0) process.exit(5)
  }
} finally {
  db.close()
}
