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

const PHASE_3_WORKFLOW_SCHEMA = `
-- 阶段 3 B1：工作流模板与不可变版本（DATABASE §2.5）
CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  schema_version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_template_status
  ON workflow_versions(template_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_checksum
  ON workflow_versions(template_id, checksum);

-- 发布不可变：definition_json / checksum / schema_version 任一变化即拒绝。
-- published 与 deprecated 同等保护——deprecated 不等于删除，历史引用仍指向那一份定义。
-- 只保护这三列，status（published → deprecated）与 published_at 的演进不受影响。
CREATE TRIGGER IF NOT EXISTS trg_workflow_versions_immutable
BEFORE UPDATE ON workflow_versions
FOR EACH ROW
WHEN OLD.status IN ('published', 'deprecated')
  AND (
    NEW.definition_json IS NOT OLD.definition_json
    OR NEW.checksum IS NOT OLD.checksum
    OR NEW.schema_version IS NOT OLD.schema_version
  )
BEGIN
  SELECT RAISE(ABORT, 'published or deprecated workflow version is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_workflow_versions_no_delete
BEFORE DELETE ON workflow_versions
FOR EACH ROW
WHEN OLD.status IN ('published', 'deprecated')
BEGIN
  SELECT RAISE(ABORT, 'published or deprecated workflow version cannot be deleted');
END;
`

const PHASE_3_QUEUE_INDEX = `
-- 阶段 3 B1：D-3 队列判定修复的索引支撑（不新增列）。
-- 查询改为 json_extract(recovery_state_json, '$.queued') = 1；部分索引只覆盖 pending 集合。
-- 首列 status 与部分索引谓词重复，但显式带上它，查询规划器才会优先选中该索引
-- （只有 (created_at, id) 时规划器会改用 idx_executions_status_updated_at 并额外排序）。
CREATE INDEX IF NOT EXISTS idx_executions_pending_created
  ON executions(status, created_at, id)
  WHERE status = 'pending';
`

const PHASE_2_WORKDIR_BOOT_UUID = `
-- 阶段 2 回归修复：开机身份从「uptime 推算的 INTEGER」改为 macOS Boot Session UUID。
-- 历史行的 boot_uuid 为 NULL = 未知身份；新代码只按 holder_pid 死亡这一确定事实回收。
--
-- !! 回滚警告：新代码不再写 boot_id。若在执行运行期间回滚到旧代码，旧逻辑会把
-- !! boot_uuid / boot_id 为 NULL 的行判为陈旧并回收【活锁】—— 与本次缺陷同一形态。
-- !! 回滚流程必须先停掉所有执行，再回滚代码。
ALTER TABLE workdir_locks ADD COLUMN boot_uuid TEXT;
`

const PHASE_4_WORKFLOW_RUNTIME = `
-- 阶段 4 S4-1：Workflow Runtime 三张表（DATABASE §2.6）。
-- 状态枚举只含 MVP 子集（WORKFLOW §3：不含 waiting_input / waiting_checkpoint）。
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'paused', 'waiting_human', 'completed', 'failed',
               'cancelled', 'reconciliation_required')
  ),
  started_at TEXT,
  ended_at TEXT,
  runtime_state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  -- 运行期 branch_key 允许返工后缀：<定义键>#rwk-<round>-<requestId 后 8 位>。
  -- 定义层 KeySchema 只允许 [a-z0-9_-]；UI/RPC 不得用 KeySchema 校验 branch_runs.branch_key。
  branch_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'blocked', 'completed', 'failed', 'cancelled')
  ),
  pause_reason TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, branch_key)
);

CREATE TABLE IF NOT EXISTS node_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_node_key TEXT NOT NULL,
  branch_run_id TEXT REFERENCES branch_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'blocked' CHECK (
    status IN ('blocked', 'ready', 'running', 'waiting_approval', 'paused', 'succeeded',
               'changes_requested', 'rejected', 'failed', 'cancelled', 'skipped',
               'reconciliation_required')
  ),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  input_snapshot_json TEXT NOT NULL DEFAULT '{}',
  output_snapshot_json TEXT,
  error_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_work_status ON workflow_runs(work_id, status);
CREATE INDEX IF NOT EXISTS idx_branch_runs_run_status ON branch_runs(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_node_runs_run_status ON node_runs(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_node_runs_run_key_attempt
  ON node_runs(workflow_run_id, workflow_node_key, attempt);
`

const PHASE_4_EXECUTION_NODE_FK = `
-- 阶段 4 S4-4：executions.node_run_id 补外键 + 每个 NodeRun 至多一条执行（attempt 模型：
-- 每次 attempt 一条 NodeRun，因此 1:1）。SQLite 不支持 ADD CONSTRAINT，只能重建表。
-- 数据保全：按原列逐行复制，随后由 foreign_key_check 与迁移测试双重校验。
CREATE TABLE executions_v10 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
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

INSERT INTO executions_v10 (
  id, session_id, node_run_id, provider_id, external_execution_id, process_id, status,
  working_directory, started_at, ended_at, exit_code, capabilities_snapshot_json,
  recovery_state_json, created_at, updated_at
)
SELECT id, session_id, node_run_id, provider_id, external_execution_id, process_id, status,
       working_directory, started_at, ended_at, exit_code, capabilities_snapshot_json,
       recovery_state_json, created_at, updated_at
FROM executions;

DROP TABLE executions;
ALTER TABLE executions_v10 RENAME TO executions;

CREATE INDEX IF NOT EXISTS idx_executions_status_updated_at ON executions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_executions_session ON executions(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_node_run
  ON executions(node_run_id) WHERE node_run_id IS NOT NULL;
-- 重建会丢掉 v7 的部分索引，必须原样恢复（队列查询依赖它）
CREATE INDEX IF NOT EXISTS idx_executions_pending_created
  ON executions(status, created_at, id) WHERE status = 'pending';
`

const PHASE_4_APPROVALS = `
-- 阶段 4 S4-5：最小审批决策内核（DATABASE §2.7 的 MVP 子集）。
-- decided_by / decided_at / decision_comment 从第一天就建列，阶段 5 不再补迁移。
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  target_node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
  approval_type TEXT NOT NULL CHECK (approval_type IN ('before_execute', 'after_execute')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'changes_requested', 'rejected', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decision_comment TEXT,
  decision_payload_json TEXT,
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  rework_request_id TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (node_run_id, round)
);

CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals(status, requested_at);
`

const PHASE_4_REWORK_REQUESTS = `
-- 阶段 4 S4-6：ReworkRequest（DATABASE §2.7.1）+ approvals.rework_request_id 补 FK。
-- SQLite 不支持 ADD CONSTRAINT，approvals 必须重建；rework_requests 先建，重建后的
-- approvals 才能引用它。数据按原列逐行复制，由运行器的 foreign_key_check 校验。
CREATE TABLE IF NOT EXISTS rework_requests (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  branch_run_id TEXT REFERENCES branch_runs(id) ON DELETE SET NULL,
  target_node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('request_changes', 'test_failure')),
  trigger_approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  test_report_json TEXT,
  round INTEGER NOT NULL CHECK (round >= 1),
  max_rounds INTEGER NOT NULL DEFAULT 2 CHECK (max_rounds >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('requested', 'in_rework', 'completed', 'cancelled', 'exhausted')
  ),
  rework_node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('system', 'approval', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_node_run_id, round)
);

CREATE INDEX IF NOT EXISTS idx_rework_requests_run_status
  ON rework_requests(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_rework_requests_target
  ON rework_requests(target_node_run_id, round);

CREATE TABLE approvals_v12 (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
  target_node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
  approval_type TEXT NOT NULL CHECK (approval_type IN ('before_execute', 'after_execute')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'changes_requested', 'rejected', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decision_comment TEXT,
  decision_payload_json TEXT,
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  rework_request_id TEXT REFERENCES rework_requests(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (node_run_id, round)
);

INSERT INTO approvals_v12 (
  id, workflow_run_id, node_run_id, target_node_run_id, approval_type, status,
  requested_by, decided_by, decision_comment, decision_payload_json, round,
  rework_request_id, requested_at, decided_at
)
SELECT id, workflow_run_id, node_run_id, target_node_run_id, approval_type, status,
       requested_by, decided_by, decision_comment, decision_payload_json, round,
       rework_request_id, requested_at, decided_at
FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_v12 RENAME TO approvals;

CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals(status, requested_at);
`

const PHASE_4_WORKFLOW_EVENTS = `
-- 阶段 4 S4-7：工作流事件持久化。event_id 唯一是去重键；重复投递只保留第一条。
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  branch_run_id TEXT REFERENCES branch_runs(id) ON DELETE SET NULL,
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_time
  ON workflow_events(workflow_run_id, occurred_at, id);
`

const PHASE_5_ARTIFACTS = `
-- 阶段 5 S5-2：Artifact 与版本（DATABASE §2.8）。
-- 版本不可覆盖：artifact_versions 拒绝 UPDATE / DELETE；返工、重新提交均产生新版本。
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('markdown', 'text', 'code', 'image', 'other')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- DATABASE §2.8 冻结基线字段；当前语义是预留占位（恒为空串）：
  -- 真实文件路径在 artifact_versions.storage_path（每版本一份）。
  -- 主表路径语义若要启用，须走决策提案，不得顺手改。
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_work_created ON artifacts(work_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_node_run ON artifacts(node_run_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  storage_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, version);

-- 版本不可覆盖：任何 UPDATE / DELETE 都拒绝（历史轮次保留不覆盖，D-011 规则 7）。
CREATE TRIGGER IF NOT EXISTS trg_artifact_versions_immutable
BEFORE UPDATE ON artifact_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'artifact version is immutable; create a new version instead');
END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_versions_no_delete
BEFORE DELETE ON artifact_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'artifact version cannot be deleted');
END;
`

const PHASE_5_5_BACKUPS = `-- 阶段 5.5 S55-1：备份历史（DATABASE §2.10 / D-013）。
-- status 的 failed 是真实失败态：任何环节失败都不得呈现为 completed。
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('manual', 'pre_restore')),
  manifest_version INTEGER NOT NULL DEFAULT 1 CHECK (manifest_version >= 1),
  db_sha256 TEXT,
  artifact_files_json TEXT NOT NULL DEFAULT '[]',
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('creating', 'completed', 'failed', 'verified', 'restored')
  ),
  storage_path TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backups_status_created ON backups(status, created_at);
`

/**
 * P1：Agent 结构化能力标签。description 仍是自然语言职责，供 Planner 理解；
 * capabilities_json 是确定性匹配依据，不得被职责描述隐式扩大。
 */
const PLANNER_AGENT_CAPABILITIES = `
ALTER TABLE agent_profiles ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
`

/** 可选模型别名/ID；NULL 使用 Provider 默认模型。 */
const AGENT_MODEL = `
ALTER TABLE agent_profiles ADD COLUMN model TEXT;
`

/** P3：计划持久化、审批、任务讨论线程。 */
const PLAN_APPROVAL = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed', 'cancelled')
  ),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  workflow_version_id TEXT,
  workflow_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_work_status ON plans(work_id, status);

CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  plan_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  assignments_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed', 'cancelled')
  ),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  UNIQUE (plan_id, version)
);

CREATE TABLE IF NOT EXISTS plan_threads (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, task_key)
);

CREATE TABLE IF NOT EXISTS plan_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES plan_threads(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_plan_comments_thread ON plan_comments(thread_id, created_at);
`

/** 计划版本来源（AI 规划 / 能力匹配快速草稿）。 */
const PLAN_VERSION_SOURCE = `
ALTER TABLE plan_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'fallback';
ALTER TABLE plan_versions ADD COLUMN fallback_reason TEXT;
`

/** 返工换人：按 (run, node) 覆盖 assignment，显式改派，不做自动改绑。 */
const NODE_ASSIGNMENT_OVERRIDES = `CREATE TABLE IF NOT EXISTS node_assignment_overrides (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_node_key TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
  assigned_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, workflow_node_key)
);

CREATE INDEX IF NOT EXISTS idx_node_assignment_overrides_run
  ON node_assignment_overrides(workflow_run_id);
`

/** 项目 = 任务的合集；任务（works）通过 project_id 归属项目。 */
const PROJECTS = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived'))
    DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE works ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_works_project ON works(project_id);

INSERT OR IGNORE INTO projects (id, name, description, status, created_at, updated_at)
  VALUES (
    'prj-default',
    '默认项目',
    '',
    'active',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

UPDATE works SET project_id = 'prj-default' WHERE project_id IS NULL;
`

/**
 * 计划不再强制绑定任务：独立规划先落库，之后可转为任务或项目。
 * plans.work_id 改为可空；依赖表的外键在 rebuild 事务内保持有效。
 */
const PLANS_NULLABLE_WORK = `
CREATE TABLE plans_new (
  id TEXT PRIMARY KEY,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed', 'cancelled')
  ),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  workflow_version_id TEXT,
  workflow_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT
);

INSERT INTO plans_new (
  id, work_id, goal, status, current_version, workflow_version_id, workflow_run_id,
  created_at, updated_at, approved_at, approved_by
)
SELECT
  id, work_id, goal, status, current_version, workflow_version_id, workflow_run_id,
  created_at, updated_at, approved_at, approved_by
FROM plans;

DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;

CREATE INDEX IF NOT EXISTS idx_plans_work_status ON plans(work_id, status);
`

/**
 * Agent 权限模型：删除自由角色与能力标签，改为唯一的 accessMode（只读分析 / 编辑）；
 * 工具权限由 accessMode 派生。技能改为全局库，Agent 只存 skillIds 引用。
 * 角色列不再参与任何业务，直接删除；Planner 用 system_kind 识别。
 */
const AGENT_ACCESS_SKILLS = `
ALTER TABLE agent_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT '🤖';
ALTER TABLE agent_profiles ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'analyze'
  CHECK (access_mode IN ('analyze', 'edit'));
ALTER TABLE agent_profiles ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_profiles ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR system_kind IN ('planner'));

-- 旧数据回填：允许过写工具的 Agent 归为 edit，其余安全地归为 analyze。
UPDATE agent_profiles SET access_mode = 'edit'
  WHERE tool_permissions_json LIKE '%"Write"%'
     OR tool_permissions_json LIKE '%"Edit"%'
     OR tool_permissions_json LIKE '%"MultiEdit"%'
     OR tool_permissions_json LIKE '%"NotebookEdit"%';

-- Planner 由系统托管；识别不依赖可被用户修改的角色名。
UPDATE agent_profiles SET system_kind = 'planner' WHERE role = 'planner';

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE agent_profiles DROP COLUMN role;
ALTER TABLE agent_profiles DROP COLUMN skills_json;
ALTER TABLE agent_profiles DROP COLUMN capabilities_json;
`

/**
 * 系统 Agent 新增 agent_designer（AI 生成 Agent 草案）。
 * SQLite 不能修改 CHECK，只能重建表；保留所有行、外键与索引。
 */
const AGENT_SYSTEM_AGENTS = `
CREATE TABLE agent_profiles_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  default_provider_id TEXT REFERENCES runtime_providers(id) ON DELETE SET NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  tool_permissions_json TEXT NOT NULL DEFAULT '{"version":1,"allow":[],"deny":[]}',
  model TEXT,
  avatar TEXT NOT NULL DEFAULT '🤖',
  access_mode TEXT NOT NULL DEFAULT 'analyze' CHECK (access_mode IN ('analyze', 'edit')),
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('planner', 'agent_designer'))
);

INSERT INTO agent_profiles_new (
  id, name, description, system_prompt, default_provider_id, max_concurrency, status,
  created_at, updated_at, archived_at, tool_permissions_json, model, avatar, access_mode,
  skill_ids_json, system_kind
)
SELECT
  id, name, description, system_prompt, default_provider_id, max_concurrency, status,
  created_at, updated_at, archived_at, tool_permissions_json, model, avatar, access_mode,
  skill_ids_json, system_kind
FROM agent_profiles;

DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_new RENAME TO agent_profiles;

CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);
`

/**
 * 团队角色没有执行语义：任务执行只认 Assignment(workRole) 与 Agent accessMode。
 * 删除自由文本 team_role，团队只保留成员关系。
 */
const TEAM_MEMBERS_DROP_ROLE = `
ALTER TABLE team_members DROP COLUMN team_role;
`

/**
 * 团队指引：成员执行「关联到该团队的任务」时，作为共享上下文注入系统提示词。
 * 它不是权限，也不改变 Assignment / 工作流选人。
 */
const TEAM_INSTRUCTIONS = `
ALTER TABLE teams ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
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
  {
    version: 6,
    name: 'phase3_workflow_templates_and_versions',
    up: (db) => {
      db.exec(PHASE_3_WORKFLOW_SCHEMA)
    },
  },
  {
    version: 7,
    name: 'phase3_execution_queue_index',
    up: (db) => {
      db.exec(PHASE_3_QUEUE_INDEX)
    },
  },
  {
    version: 8,
    name: 'phase2_workdir_lock_boot_uuid',
    up: (db) => {
      db.exec(PHASE_2_WORKDIR_BOOT_UUID)
    },
  },
  {
    version: 9,
    name: 'phase4_workflow_runtime',
    up: (db) => {
      db.exec(PHASE_4_WORKFLOW_RUNTIME)
    },
  },
  {
    version: 10,
    name: 'phase4_execution_node_run_fk',
    // 重建表：foreign_keys 必须在事务外关闭，运行器负责开关与 foreign_key_check。
    rebuildsTables: true,
    up: (db) => {
      db.exec(PHASE_4_EXECUTION_NODE_FK)
    },
  },
  {
    version: 11,
    name: 'phase4_approvals',
    up: (db) => {
      db.exec(PHASE_4_APPROVALS)
    },
  },
  {
    version: 12,
    name: 'phase4_rework_requests',
    rebuildsTables: true,
    up: (db) => {
      db.exec(PHASE_4_REWORK_REQUESTS)
    },
  },
  {
    version: 13,
    name: 'phase4_workflow_events',
    up: (db) => {
      db.exec(PHASE_4_WORKFLOW_EVENTS)
    },
  },
  {
    version: 14,
    name: 'phase5_artifacts',
    up: (db) => {
      db.exec(PHASE_5_ARTIFACTS)
    },
  },
  {
    version: 15,
    name: 'phase5_5_backups',
    up: (db) => {
      db.exec(PHASE_5_5_BACKUPS)
    },
  },
  {
    version: 16,
    name: 'planner_agent_capabilities',
    up: (db) => {
      db.exec(PLANNER_AGENT_CAPABILITIES)
    },
  },
  {
    version: 17,
    name: 'agent_model',
    up: (db) => {
      db.exec(AGENT_MODEL)
    },
  },
  {
    version: 18,
    name: 'plan_approval',
    up: (db) => {
      db.exec(PLAN_APPROVAL)
    },
  },
  {
    version: 19,
    name: 'plan_version_source',
    up: (db) => {
      db.exec(PLAN_VERSION_SOURCE)
    },
  },
  {
    version: 20,
    name: 'node_assignment_overrides',
    up: (db) => {
      db.exec(NODE_ASSIGNMENT_OVERRIDES)
    },
  },
  {
    version: 21,
    name: 'projects',
    up: (db) => {
      db.exec(PROJECTS)
    },
  },
  {
    version: 22,
    name: 'plans_nullable_work',
    rebuildsTables: true,
    up: (db) => {
      db.exec(PLANS_NULLABLE_WORK)
    },
  },
  {
    version: 23,
    name: 'agent_access_skills',
    up: (db) => {
      db.exec(AGENT_ACCESS_SKILLS)
    },
  },
  {
    version: 24,
    name: 'agent_system_agents',
    rebuildsTables: true,
    up: (db) => {
      db.exec(AGENT_SYSTEM_AGENTS)
    },
  },
  {
    version: 25,
    name: 'team_members_drop_role',
    up: (db) => {
      db.exec(TEAM_MEMBERS_DROP_ROLE)
    },
  },
  {
    version: 26,
    name: 'team_instructions',
    up: (db) => {
      db.exec(TEAM_INSTRUCTIONS)
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
