# 数据库设计

版本：V1.0  
数据库：SQLite（建议 WAL 模式）  
ORM：Drizzle（推荐）

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

## 2. 核心表

### 2.1 Agent 与 Provider

#### agent_profiles
- id PK
- name
- role
- description
- system_prompt
- skills_json
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
- status
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
- status
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
- nodes：节点 key、type、label、config、position
- edges：source、target、condition、edge type
- branches：逻辑分支标识（可由图结构推导，但运行时需有稳定实例 ID）
- settings：并发、失败策略、超时、人工参与默认策略
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
- status: pending | approved | changes_requested | rejected | taken_over | cancelled
- requested_by
- decided_by nullable
- decision_comment nullable
- decision_payload_json nullable
- artifact_version_id nullable
- requested_at
- decided_at nullable

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

## 3. 关键索引

- assignments(work_id, agent_id)
- tasks(work_id, status)
- workflow_runs(work_id, status)
- branch_runs(workflow_run_id, status)
- node_runs(workflow_run_id, status)
- approvals(status, requested_at)
- artifacts(work_id, created_at)
- executions(status, updated_at)
- workflow_events(workflow_run_id, occurred_at)
- execution_logs(execution_id, sequence_no)

## 4. 事务与一致性

- 节点完成、Artifact 版本创建、WorkflowEvent 写入应尽量处于同一事务。
- 下游调度必须在事务提交后发生。
- 审批决策和对应状态变化应原子提交。
- Daemon 事件以 event_id 去重。
- 重启恢复时必须核对进程状态，避免重复执行有副作用的任务。
- 任何无法确认的运行状态标记为 reconciliation_required，等待恢复策略处理。

## 5. 删除策略

默认使用归档而非物理删除：
- Agent 有历史 Assignment 时只能归档。
- Team 有 Work 关联时只能归档。
- WorkflowVersion 被 WorkflowRun 引用时不可删除。
- Artifact 被审批或下游节点引用时不可删除。
- Work 删除需明确处理工作区文件；默认只归档元数据，不自动删除用户文件。
