import type { Database } from './database'

/**
 * 版本化迁移：PRAGMA user_version 递增，MIGRATIONS 数组顺序执行。
 * 可重复执行（user_version 门禁 + IF NOT EXISTS）；每个迁移单独事务。
 */
export type Migration = {
  version: number
  name: string
  up: (db: Database) => void
}

const PHASE_1_SCHEMA = `
-- Provider 是运行时实现，AgentProfile 是员工身份，两者不合并（DATABASE §2.1）。
CREATE TABLE IF NOT EXISTS runtime_providers (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('cli', 'acp', 'remote')),
  provider_name TEXT NOT NULL,
  executable_path TEXT,
  version TEXT,
  capabilities_json TEXT NOT NULL,
  health_status TEXT NOT NULL CHECK (
    health_status IN ('healthy', 'unavailable', 'unauthenticated', 'unknown')
  ),
  last_discovered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  default_provider_id TEXT REFERENCES runtime_providers(id) ON DELETE SET NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES runtime_providers(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, provider_id)
);

-- assignment_id 在阶段 2 引入 assignments 表后补 FK；阶段 1 允许为空。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT,
  provider_id TEXT NOT NULL REFERENCES runtime_providers(id),
  external_session_id TEXT,
  context_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT
);

-- node_run_id 在阶段 3/4 引入 node_runs 后补 FK；阶段 1 恒为空。
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  node_run_id TEXT,
  provider_id TEXT NOT NULL REFERENCES runtime_providers(id),
  external_execution_id TEXT,
  process_id INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'crashed')
  ),
  working_directory TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  capabilities_snapshot_json TEXT NOT NULL,
  recovery_state_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system', 'structured')),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  UNIQUE (execution_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_bindings_agent ON agent_runtime_bindings(agent_id);
CREATE INDEX IF NOT EXISTS idx_executions_status_updated_at ON executions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_executions_session ON executions(session_id);
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'phase1_agent_runtime',
    up: (db) => {
      db.exec(PHASE_1_SCHEMA)
    },
  },
]

export function currentUserVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const value = row?.user_version
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`unexpected PRAGMA user_version value: ${String(value)}`)
  }
  return value
}

export type MigrationResult = {
  from: number
  to: number
  applied: string[]
}

/** 执行所有未应用的迁移；返回迁移前后的版本与已应用迁移名。 */
export function migrate(db: Database, migrations: Migration[] = MIGRATIONS): MigrationResult {
  const from = currentUserVersion(db)
  const pending = [...migrations].sort((a, b) => a.version - b.version)
  const applied: string[] = []

  for (const migration of pending) {
    if (migration.version <= from) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      // user_version 不可参数化；version 来自本文件的常量整数，先做严格校验。
      if (!Number.isInteger(migration.version) || migration.version <= 0) {
        throw new Error(`invalid migration version: ${migration.version}`)
      }
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
      applied.push(migration.name)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败不掩盖原始异常。
      }
      throw error
    }
  }

  return { from, to: currentUserVersion(db), applied }
}
