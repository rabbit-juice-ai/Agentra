import { newId } from '@agentra/shared'
import type { Database } from './database'

/**
 * 版本化迁移：PRAGMA user_version 递增，MIGRATIONS 数组顺序执行。
 * 可重复执行（user_version 门禁 + IF NOT EXISTS）；每个迁移单独事务。
 */
export type Migration = {
  version: number
  name: string
  /**
   * true 表示该迁移需要重建表（SQLite 不支持 ADD CONSTRAINT）。
   * 运行时会在事务外关闭 foreign_keys、事务内执行 + foreign_key_check + 写 user_version，
   * 失败回滚并恢复开关——`PRAGMA foreign_keys` 在事务内是 no-op，必须由运行器在事务外切换。
   */
  rebuildsTables?: boolean
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

const PHASE_1_TOOL_POLICY_SCHEMA = `
-- U3 工具权限最小模型：既有行取默认值（空 allow）= 未配置 = 拒绝执行；不做任何回填。
ALTER TABLE agent_profiles ADD COLUMN tool_permissions_json TEXT NOT NULL
  DEFAULT '{"version":1,"allow":[],"deny":[]}';

-- A4-auth 认证引导：安装/登录提示此前只存在于发现结果的瞬时内存，需持久化才能展示。
ALTER TABLE runtime_providers ADD COLUMN auth_method TEXT;
ALTER TABLE runtime_providers ADD COLUMN health_detail TEXT;
`

const PHASE_2_SCHEMA = `
-- 阶段 2 B1：Team / Work / Assignment 数据层（DATABASE §2.2 / §2.3 / §2.9）
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  team_role TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  joined_at TEXT NOT NULL,
  UNIQUE (team_id, agent_id)
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'active', 'paused', 'completed', 'cancelled', 'archived')
  ),
  priority TEXT NOT NULL DEFAULT 'normal',
  root_path TEXT NOT NULL,
  repository_path TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS work_teams (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_id, team_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  work_role TEXT NOT NULL,
  task_scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'completed', 'removed')
  ),
  concurrency_limit INTEGER,
  context_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, agent_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_members_agent ON team_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);
CREATE INDEX IF NOT EXISTS idx_assignments_work ON assignments(work_id);
CREATE INDEX IF NOT EXISTS idx_assignments_agent ON assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
`

/**
 * 重建 agent_sessions，为 assignment_id 加外键（U6）。
 * 必须在 foreign_keys=OFF 的事务里执行：`DROP TABLE` 父表会触发外键计数，
 * 即使新表随后补回同样数据，COMMIT 仍会被判违约（已实测）。
 */
const AGENT_SESSIONS_REBUILD = `
CREATE TABLE agent_sessions_v3 (
  id TEXT PRIMARY KEY,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL REFERENCES runtime_providers(id),
  external_session_id TEXT,
  context_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT
);

INSERT INTO agent_sessions_v3 (
  id, assignment_id, provider_id, external_session_id, context_ref, status,
  created_at, updated_at, last_active_at
)
SELECT id, assignment_id, provider_id, external_session_id, context_ref, status,
       created_at, updated_at, last_active_at
FROM agent_sessions;

DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_v3 RENAME TO agent_sessions;
CREATE INDEX IF NOT EXISTS idx_agent_sessions_assignment ON agent_sessions(assignment_id);
`

export type OrphanedSessionBinding = { sessionId: string; previousAssignmentId: string }

/**
 * U6：外键迁移前把孤儿引用置 NULL 并写审计日志。
 * 返回被清理的记录，便于迁移与测试断言。
 */
export function clearOrphanedSessionBindings(db: Database, now: string): OrphanedSessionBinding[] {
  const orphans = db
    .prepare(
      `SELECT id, assignment_id FROM agent_sessions
       WHERE assignment_id IS NOT NULL
         AND assignment_id NOT IN (SELECT id FROM assignments)`,
    )
    .all() as { id: string; assignment_id: string }[]

  if (orphans.length === 0) return []

  const insertAudit = db.prepare(
    `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at)
     VALUES (?, 'system', NULL, 'agent_session.assignment_orphaned', 'agent_session', ?, ?, ?)`,
  )
  for (const orphan of orphans) {
    insertAudit.run(
      newId('aud'),
      orphan.id,
      JSON.stringify({ previousAssignmentId: orphan.assignment_id }),
      now,
    )
  }

  db.prepare(
    `UPDATE agent_sessions SET assignment_id = NULL
     WHERE assignment_id IS NOT NULL
       AND assignment_id NOT IN (SELECT id FROM assignments)`,
  ).run()

  return orphans.map((orphan) => ({
    sessionId: orphan.id,
    previousAssignmentId: orphan.assignment_id,
  }))
}

function upPhase2(db: Database): void {
  db.exec(PHASE_2_SCHEMA)
  // 外键迁移前先清理孤儿：置 NULL + 审计（U6）；否则重建后的外键无法提交。
  clearOrphanedSessionBindings(db, new Date().toISOString())
  db.exec(AGENT_SESSIONS_REBUILD)
}

const PHASE_2_WORKDIR_SCHEMA = `
-- 阶段 2 B3：Git Worktree 记录 + 工作目录锁（DATABASE §2.8；锁是运行态，随 Core 生命周期）
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  repository_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (worktree_path)
);

-- 锁的键是「实际工作目录的绝对路径」：两个 Work 指向同一目录时才会冲突。
-- holder_pid 是持锁进程（Core）的 pid，用于回收被 kill -9 后留下的陈旧锁。
CREATE TABLE IF NOT EXISTS workdir_locks (
  workdir TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  work_id TEXT,
  holder_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worktrees_work ON worktrees(work_id);
CREATE INDEX IF NOT EXISTS idx_workdir_locks_execution ON workdir_locks(execution_id);
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'phase1_agent_runtime',
    up: (db) => {
      db.exec(PHASE_1_SCHEMA)
    },
  },
  {
    version: 2,
    name: 'phase1_tool_permissions_and_provider_auth',
    up: (db) => {
      db.exec(PHASE_1_TOOL_POLICY_SCHEMA)
    },
  },
  {
    version: 3,
    name: 'phase2_team_work_assignment',
    rebuildsTables: true,
    up: upPhase2,
  },
  {
    version: 4,
    name: 'phase2_worktree_and_workdir_locks',
    up: (db) => {
      db.exec(PHASE_2_WORKDIR_SCHEMA)
    },
  },
  {
    version: 5,
    name: 'phase2_workdir_lock_boot_id',
    up: (db) => {
      // 开机身份：用于跨重启回收锁，避免 pid 被无关进程复用时锁永久不回收。
      // 旧行 boot_id 为 NULL，视为无法判定 → 按陈旧回收（升级发生在 Core 启动时，不会有活锁）。
      db.exec('ALTER TABLE workdir_locks ADD COLUMN boot_id INTEGER')
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

/** user_version 不可参数化；version 来自本文件的常量整数，写入前做严格校验。 */
function applyUserVersion(db: Database, version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`invalid migration version: ${version}`)
  }
  db.exec(`PRAGMA user_version = ${version}`)
}

/**
 * 重建表迁移：PRAGMA foreign_keys 在事务内是 no-op，只能在事务外切换。
 * 事务内执行 up → 全库 foreign_key_check → 写 user_version，失败整体回滚并恢复开关。
 */
function runRebuildMigration(db: Database, migration: Migration): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(
          `migration ${migration.name} left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
        )
      }
      applyUserVersion(db, migration.version)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败不掩盖原始异常。
      }
      throw error
    }
  } finally {
    // 无论成败都必须恢复外键检查，不能把连接留在关闭状态。
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/** 执行所有未应用的迁移；返回迁移前后的版本与已应用迁移名。 */
export function migrate(db: Database, migrations: Migration[] = MIGRATIONS): MigrationResult {
  const from = currentUserVersion(db)
  const pending = [...migrations].sort((a, b) => a.version - b.version)
  const applied: string[] = []

  for (const migration of pending) {
    if (migration.version <= from) continue

    if (migration.rebuildsTables) {
      runRebuildMigration(db, migration)
      applied.push(migration.name)
      continue
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      applyUserVersion(db, migration.version)
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
