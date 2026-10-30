# 数据库设计

版本：V1.3（基于 v1.0.0 Development Baseline 的 D-016～D-023 修订）  
数据库：SQLite（WAL 模式）  
数据访问：Node.js 内置 `node:sqlite` + Core 统一 Repository/Data Access Layer（无 ORM；决策 D-016）

## 1. 设计原则

- 主键使用 UUID/ULID 字符串，统一格式。
- 时间统一存 UTC ISO-8601 或整数毫秒，项目内保持一种格式。
- 所有核心表包含 created_at、updated_at；可归档实体包含 archived_at。
- JSON 字段必须有 Zod Schema 验证和版本字段。
- 重要状态迁移写入 workflow_events/audit_logs。
- WorkflowVersion 发布后不可变。
- Artifact 版本不可覆盖。
- Work、Assignment、Session 和工作目录分离。
- 数据库状态是 Core 的权威状态，不以 UI 缓存为准。
- **数据库访问统一经 Core 的 Repository/Data Access Layer；Daemon 不直接访问业务数据库。**
- **使用参数化 SQL（禁止字符串拼接）；写操作使用事务；启用 WAL 与 busy_timeout。**
- **迁移自管：`PRAGMA user_version` 递增的版本化迁移（MIGRATIONS 数组），可重复执行、可测试；不引入 ORM。**
- **运行时版本与验证分层（Agentra 实测，2026-10-30；裁定 D-017）**：
  - 开发/测试最低 Node ≥ 22.13（实测 22.23.2）。Node 22 下 node:sqlite 标记为 experimental 并打印 ExperimentalWarning；**不因此强制升级到 Node 24**。
  - 生产 Core 经 `ELECTRON_RUN_AS_NODE` 运行于**锁定版本**的 Electron，不单独假设 Node 版本。版本对应关系：**Electron 45.1.0 ↔ 内置 Node 24.22.1**（实测）。
  - 本次实测在 Electron 45.1.0 内置 Node 24.22.1 下未观察到 ExperimentalWarning；**不推定**其他 Node 24 / Electron 版本或打包态行为。
  - 验证分层：**阶段 1** 做当前 Electron 运行环境的 SQLite 基本集成验证（建表/参数化写入/WAL/简单快照备份）；**阶段 5.5** 做备份恢复完整 8 项验收（本阶段的 VACUUM INTO 快照验证不能代替）；**阶段 6** 做完整打包态复验。

## 2. 核心表

### 2.1 Agent 与 Provider

#### agent_profiles
- id PK
- name
- role
- description
- system_prompt
- skills_json
- tool_permissions_json：`{"version":1,"allow":[],"deny":[]}`；空 allow = 未配置 = 拒绝执行（U3，迁移 v2）
- default_provider_id nullable
- max_concurrency integer default 1
- status: active | disabled | archived
- created_at
- updated_at
- archived_at nullable

#### runtime_providers
- id PK
- provider_type: cli | acp | remote
- provider_name
- executable_path nullable
- version nullable
- capabilities_json
- health_status
- auth_method nullable：认证方式描述（oauth_token / api_key / none），不含凭据本身（迁移 v2）
- health_detail nullable：面向用户的安装/登录提示，不含凭据（迁移 v2）
- last_discovered_at
- created_at
- updated_at

#### agent_runtime_bindings
- id PK
- agent_id FK
- provider_id FK
- config_json
- is_default boolean
- created_at
- updated_at

Provider 是运行时实现，AgentProfile 是员工身份。不得把两者合并。

### 2.2 Team

#### teams
- id PK
- name
- description
- settings_json
- status
- created_at
- updated_at
- archived_at nullable

#### team_members
- id PK
- team_id FK
- agent_id FK
- team_role
- permissions_json
- joined_at
- unique(team_id, agent_id)

### 2.3 Work 与 Assignment

#### works
- id PK
- name
- description
- objective
- status: draft | active | paused | completed | cancelled | archived
- priority
- root_path
- repository_path nullable
- settings_json
- created_at
- updated_at
- completed_at nullable

#### work_teams
- work_id FK
- team_id FK
- created_at
- PK(work_id, team_id)

#### assignments
- id PK
- work_id FK
- agent_id FK
- team_id nullable FK
- work_role
- task_scope
- status: active | paused | completed | removed
- concurrency_limit nullable
- context_ref nullable
- created_at
- updated_at
- unique(work_id, agent_id)（如未来允许同 Agent 同 Work 多个独立岗位，改为非唯一并增加 assignment_key）

#### tasks
- id PK
- work_id FK
- assignment_id nullable FK
- title
- description
- status
- priority
- due_at nullable
- created_at
- updated_at

### 2.4 Session 与 Execution

#### agent_sessions
- id PK
- assignment_id FK
- provider_id FK
- external_session_id nullable
- context_ref nullable
- status: active | ended
- created_at
- updated_at
- last_active_at nullable

#### executions
- id PK
- session_id FK
- node_run_id nullable FK
- provider_id FK
- external_execution_id nullable
- process_id nullable
- status: pending | running | succeeded | failed | cancelled | crashed
  - **状态范围说明**：不含 `reconciliation_required`——该状态属于 `workflow_runs`（§2.6，阶段 4 引入），Execution 层不引入。
- working_directory
- started_at nullable
- ended_at nullable
- exit_code nullable
- capabilities_snapshot_json
- recovery_state_json nullable
- created_at
- updated_at

### 2.5 Workflow Template 与定义

#### workflow_templates
- id PK
- name
- description
- category
- created_at
- updated_at
- archived_at nullable

#### workflow_versions
- id PK
- template_id FK
- version
- schema_version
- definition_json
- checksum
- status: draft | published | deprecated
- created_at
- published_at nullable
- unique(template_id, version)

发布版本不可修改。模板编辑应产生新 draft/version。

Workflow definition 建议包含：
- nodes：节点 key、type、label、config、position（MVP type 白名单：start、agent_task、parallel_split、join、human_approval、condition、end；发布时含其他值拒绝 UNKNOWN_NODE_TYPE）
- edges：source、target、condition、edge type
- branches：逻辑分支标识（可由图结构推导，但运行时需有稳定实例 ID）
- settings：并发、失败策略、超时、reworkPolicy（默认轮次上限 2）、人工参与默认策略
- schemaVersion

### 2.6 Workflow Runtime

#### workflow_runs
- id PK
- work_id FK
- workflow_version_id FK
- status: pending | running | paused | waiting_human | completed | failed | cancelled | reconciliation_required
- started_at nullable
- ended_at nullable
- runtime_state_json
- created_at
- updated_at

#### branch_runs
- id PK
- workflow_run_id FK
- branch_key
- status: active | paused | completed | failed | cancelled | blocked
- pause_reason nullable
- paused_at nullable
- resumed_at nullable
- created_at
- updated_at
- unique(workflow_run_id, branch_key)

#### node_runs
- id PK
- workflow_run_id FK
- workflow_node_key
- branch_run_id nullable FK
- status
- attempt integer default 1
- input_snapshot_json
- output_snapshot_json nullable
- error_json nullable
- started_at nullable
- ended_at nullable
- created_at
- updated_at

节点定义属于 WorkflowVersion；NodeRun 是执行实例，不能把运行状态写回模板节点。

### 2.7 人工参与

#### approvals
- id PK
- workflow_run_id FK
- node_run_id FK
- approval_type: before_execute | checkpoint | after_execute | artifact_review | manual_route
  - **MVP 子集**：before_execute、after_execute（经 Human Approval 原语实现；checkpoint/manual_route/artifact_review 为后续版本能力，MVP 仍保留枚举定义并标注）
- status: pending | approved | changes_requested | rejected | taken_over | cancelled
  - **MVP 子集**：pending、approved、changes_requested、rejected、cancelled（taken_over 为后续版本）。其中 cancelled 仅用于系统取消路径（如 Work 终止时取消 pending 审批，见 WORKFLOW §4 Work 级终止），不是用户审批决策的一种。
- requested_by
- decided_by nullable
- decision_comment nullable
  - **MVP 约束**：decision 决策为 request_changes 时必填修改意见
- decision_payload_json nullable
- artifact_version_id nullable
- round integer default 1（审批轮次；request_changes 返工后重新进入本审批节点时递增）
- rework_request_id nullable FK（request_changes 决策关联的返工任务；MVP 必填当 status=changes_requested）
- requested_at
- decided_at nullable
- **幂等约束**：unique(node_run_id, round)——同一审批节点每轮至多一条记录；已进入终态（approved/changes_requested/rejected/cancelled）的记录不可被后续请求修改（历史不可覆盖）。

#### human_inputs
- id PK
- node_run_id FK
- input_schema_json
- input_payload_json
- submitted_by
- submitted_at

#### checkpoints
- id PK
- execution_id FK
- checkpoint_type
- checkpoint_ref nullable
- checkpoint_data_json
- created_at

（checkpoints 为后续版本能力，MVP 不实现、仅保留表定义占位。）

### 2.7.1 ReworkRequest（返工请求，决策 D-011/D-015）

#### rework_requests
- id PK
- workflow_run_id FK
- branch_run_id nullable FK
- target_node_run_id FK（被返工任务的原始 NodeRun）
- trigger_type: request_changes | test_failure
- trigger_approval_id nullable FK（request_changes 触发时关联的 Approval 记录）
- test_report_json nullable（测试失败触发时的结构化测试结果：pass/fail、失败原因、关联任务、影响范围、相关 Artifact）
- round integer（第几轮返工，从 1 起；按 target_node_run 所在任务计数）
- max_rounds integer default 2（不含首次执行）
- status: requested | in_rework | completed | cancelled | exhausted（超限）
- rework_node_run_id nullable FK（本轮返工执行产生的新 NodeRun attempt）
- created_by（system | approval | user）
- created_at
- updated_at
- **幂等约束**：unique(target_node_run_id, round)——同一任务同一轮至多一条 ReworkRequest；重复触发（重启恢复、重复审批提交）不得新建记录。
- **关联说明**：ReworkRequest 完成后产生的新 Artifact 写入 artifact_versions 并经 rework_node_run_id 关联本轮执行；历史轮次的记录与 Artifact 版本一律保留不覆盖。

### 2.8 Artifact 与 Worktree

#### artifacts
- id PK
- work_id FK
- node_run_id nullable FK
- assignment_id nullable FK
- artifact_type
- name
- description
- storage_path
- mime_type nullable
- created_by_type
- created_by_id nullable
- created_at

#### artifact_versions
- id PK
- artifact_id FK
- version
- storage_path
- checksum
- metadata_json
- created_at
- unique(artifact_id, version)

版本不可覆盖：返工、重新提交均产生新版本；审批与 ReworkRequest 通过 artifact_version_id 引用具体版本。

#### artifact_reviews
- id PK
- artifact_version_id FK
- reviewer_type
- reviewer_id nullable
- status
- comment
- created_at

#### worktrees
- id PK
- work_id FK
- assignment_id nullable FK
- repository_path
- worktree_path
- branch_name
- base_commit nullable
- status
- created_at
- removed_at nullable

### 2.9 Event、日志和审计

#### workflow_events
- id PK
- event_id unique
- workflow_run_id FK
- branch_run_id nullable FK
- node_run_id nullable FK
- event_type
- payload_json
- occurred_at
- correlation_id nullable
- causation_id nullable

#### execution_logs
- id PK
- execution_id FK
- sequence_no
- stream: stdout | stderr | system | structured
- content
- timestamp
- unique(execution_id, sequence_no)

#### audit_logs
- id PK
- actor_type
- actor_id nullable
- action
- target_type
- target_id
- details_json
- created_at

### 2.10 备份与恢复（决策 D-013）

#### backups
- id PK
- type: manual | pre_restore（恢复前自动备份当前数据）
- manifest_version
- db_sha256（数据库备份文件校验值）
- artifact_files_json（托管 Artifact 文件清单：路径、大小、sha256）
- file_count
- status: creating | completed | failed | verified | restored
- storage_path（备份包所在目录）
- error_json nullable（失败原因；失败不得呈现为成功）
- created_at
- completed_at nullable
- verified_at nullable

备份包目录结构（含 manifest.json）：
```
<backup-dir>/<backup-id>/
├── manifest.json        # { manifestVersion, createdAt, type, database: {file, sha256, bytes}, artifacts: [{path, sha256, bytes}], counts }
├── database.db          # SQLite 一致性备份（WAL 兼容：VACUUM INTO 或 backup API 产物；VACUUM INTO 已实测并发一致，最终方式阶段 5.5 定案）
└── artifacts/           # Agentra 托管的 Artifact 文件（按原相对路径存放）
```

不含：外部 Git 仓库/项目源码、CLI 程序、API Key/Token 等凭据、缓存与临时文件。

恢复流程的持久化要求：
- 恢复前自动创建 pre_restore 备份（失败则中止恢复）。
- 恢复成功后写入 verified_at 并对新库执行完整性检查（PRAGMA integrity_check）。
- 恢复后启动时执行工作流状态对账（见 WORKFLOW §9）：待审批与返工状态恢复，不重复执行外部副作用任务。
- 恢复后检查外部项目路径（works.root_path / repository_path）是否存在，缺失的以结构化方式记录并提示用户。

## 3. 关键索引

- assignments(work_id, agent_id)
- tasks(work_id, status)
- workflow_runs(work_id, status)
- branch_runs(workflow_run_id, status)
- node_runs(workflow_run_id, status)
- approvals(status, requested_at)
- approvals(node_run_id, round)（幂等唯一）
- rework_requests(target_node_run_id, round)（幂等唯一）
- rework_requests(workflow_run_id, status)
- artifacts(work_id, created_at)
- executions(status, updated_at)
- workflow_events(workflow_run_id, occurred_at)
- execution_logs(execution_id, sequence_no)

## 4. 事务与一致性

- 节点完成、Artifact 版本创建、WorkflowEvent 写入应尽量处于同一事务。
- 下游调度必须在事务提交后发生。
- 审批决策和对应状态变化应原子提交；request_changes 决策与 ReworkRequest 创建同事务。
- Daemon 事件以 event_id 去重。
- ReworkRequest 轮次统计与状态迁移同事务（幂等键防重）。
- 重启恢复时必须核对进程状态，避免重复执行有副作用的任务。
- 任何无法确认的运行状态标记为 reconciliation_required，等待恢复策略处理。

## 5. 删除策略

默认使用归档而非物理删除：
- Agent 有历史 Assignment 时只能归档。
- Team 有 Work 关联时只能归档。
- WorkflowVersion 被 WorkflowRun 引用时不可删除。
- Artifact 被审批或下游节点引用时不可删除。
- Work 删除需明确处理工作区文件；默认只归档元数据，不自动删除用户文件。
