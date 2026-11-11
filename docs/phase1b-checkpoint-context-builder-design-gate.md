# Phase 1B 设计门禁：Checkpoint + Context Builder

- 状态：**CTO 验收通过并关闭（2026-11-09）；Phase 1B-2 等待单独设计与授权**
- 实施报告：`docs/phase1b1-implementation-report.md`
- 基线：Phase 1A 已验收关闭；本机正式库 `user_version=32`
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；工作区保持未提交
- 关系：本文以 Phase 1A 的实际 v31 为迁移基线，**取代** `docs/context-management-architecture-review.md` §7.9 / §11 中已过期的 v31–v36 迁移编号
- 范围：设计批准、Phase 1B-1 实施与验收归档；Phase 1B-2、1C、1D 未启动
- 批准记录：D-1 至 D-6、D-8、D-9 批准；D-7 有条件批准。完整批准条件见 §12。
- 验收记录：2026-11-09 CTO 报告级验收通过；Phase 1B-1 正式关闭。

---

## 0. 门禁结论摘要

Phase 1B 的核心不是“把上下文存成 JSON”，而是建立一条可审计的事实链：

```text
Execution / Work 终态
  → Checkpoint（不可变、追加式）
  → 当前阶段 + 已完成/未完成/阻塞
  → 文件证据 + Artifact 证据 + 测试证据
  → SideEffectRef 完整性
  → 风险等级
  → 恢复资格（由 Core 计算，不由模型声明）
```

本设计经 CTO 批准后的 Phase 1B-1 实施准备范围：

1. 迁移 v32：只新增 `task_checkpoints`（含失败尝试记录），不新增副作用表、不扩展 Session、不新增 Token 表。
2. 新增 Core 内部 `CheckpointService`：在 Execution 终态、Workflow 节点终态、Team run 终态、Work 最终交付时创建 Checkpoint。
3. 新增证据校验：FileEvidence、ArtifactEvidence、TestEvidence；证据不通过时 Checkpoint 必须降级，不得标记 `verified`。
4. 定义 `SideEffectRef` 合约与完整性状态；Phase 1B 无 Ledger，统一标记 `not_tracked`，高风险任务不得自动恢复。
5. 新增纯函数式 `ContextBuilder`：P0/P1/P2/P3 分层，P0 超预算 fail-closed；Phase 1B 不实现 70%/85% Token 阈值。
6. 恢复部分按 CTO 决策拆成 **1B-1 只读恢复计划预览** 与 **1B-2 真正从 Checkpoint 新建 Session 继续执行**；1B-2 必须另行审批，不得提前实现或通过隐藏开关启用。

**1B-1 的关键边界：只读恢复计划不等于自动恢复。** 即使恢复资格为 `eligible`，1B-1 也只能返回计划和判断依据，不得创建 Session、启动 Agent 或调用外部工具。

9 项决策已由 CTO 批准（D-7 有条件批准），正式批准记录与授权范围见 §12。**当前只允许 Phase 1B-1 实施准备；代码实施需本设计文档修订确认后由 CTO 另行授权。**

---

## 1. 当前代码事实核对

### 1.1 已有结构

| 结构 | 现状 | 对 Phase 1B 的意义 |
|---|---|---|
| `works` | 已有 `root_path`、`repository_path`、`acceptance_criteria_*`（v31） | Checkpoint 的 Work 边界和验收标准版本来源 |
| `task_memories` | v31 已建；一个 Work 一份当前快照 | Checkpoint 保存快照版本，不替代 Task Memory |
| `executions` | 有 `session_id`、`node_run_id`、`working_directory`、`recovery_state_json` | Checkpoint 的来源执行；终态补偿已有持久化 pending 机制 |
| `agent_sessions` | 每次 Execution 新建；无 Checkpoint 关联 | Phase 1B 不改 Session 生命周期 |
| `worktrees` | 有 `worktree_path`、`base_commit`、`status` | Worktree 文件证据的基线与边界 |
| `node_runs` | 有 `input_snapshot_json` / `output_snapshot_json` | Workflow 节点证据和测试报告来源 |
| `artifacts` / `artifact_versions` | `artifact_versions` 不可变，`checksum` 为 SHA-256，文件路径有边界校验 | ArtifactEvidence 可直接复用现有校验语义 |
| `team_task_runs` / `team_task_run_steps` | 有 run 终态、`execution_id`、工具步骤 | Team Checkpoint 的来源和工具风险线索 |
| `audit_logs` | 追加式审计 | Checkpoint 创建/失败/恢复阻断的审计出口 |
| `execution_logs` | 有 `structured` 流，包含 tool_use 事件 | 风险分级和工具证据线索；不是可靠的文件变更清单 |

### 1.2 当前缺口

1. 没有 `task_checkpoints` 表。
2. 没有 `task_side_effects` 表或 Ledger。
3. 没有结构化的“文件写入事件”清单；只有 Worktree 的 git 状态/差异可以作为可信文件基线。
4. `test_result` 是 Agent 输出契约（`pass`、`relatedTasks`、`failureReason`），**不是测试运行器证据**；不能仅凭它把测试标记为 `verified`。
5. Workflow 终态、Team 终态、Work 完成是三条不同路径；Checkpoint 必须通过幂等键统一，不能在每个路径各写一套。
6. Execution 终态补偿已有 `terminalProcessing` 持久化 pending 机制，可作为 Checkpoint 创建失败重放的参考，但不能直接把 Checkpoint 写进同一个长事务。

---

## 2. Phase 1B 范围与非目标

### 2.1 CTO 批准的 Phase 1B-1 实施准备范围

| 项 | 内容 |
|---|---|
| 数据库 | v32 `task_checkpoints` + 索引 + 不可变触发器 |
| Checkpoint 创建 | Execution 终态、Workflow 节点终态、Team run 终态、Work 最终交付 |
| 证据 | FileEvidence / ArtifactEvidence / TestEvidence 的结构、校验、聚合状态 |
| SideEffectRef | 合约、状态机、完整性语义；Phase 1B 不建 Ledger 表 |
| ContextBuilder | 纯函数组装 P0/P1/P2/P3；固定保守字符预算；manifest 审计 |
| 恢复资格 | Core 计算 `recoveryEligibility`；只读恢复计划与原因；不执行恢复 |
| 审计 | `checkpoint.created` / `checkpoint.failed` / `checkpoint.recovery_blocked` / `context.built` |
| 测试 | 迁移、幂等、证据、路径、风险、ContextBuilder、无回归 |

本表不包含 1B-2 的 Session 创建、Agent 启动、外部工具调用或自动继续执行。

### 2.2 明确非目标

- 不实现 Provider Resume、`resumeSessionId`、Claude Code `--resume`。
- 不实现 SessionLifecycleManager、Session 复用/压缩/自动切换。
- 不实现 Token 窗口表、70%/85% 阈值、Token 计数。
- 不实现 `task_side_effects` 表或完整 Ledger。
- 不实现自动文件恢复、回滚、覆盖、删除。
- 不实现 Planner Thread 迁移、Project Memory、长期记忆。
- 不新增工作流节点类型，不改变 7 节点冻结基线。
- 不新增手动 Session/Checkpoint UI 入口。
- 不把 Agent 的聊天文本或 `test_result` 声明当作已验证事实。

### 2.3 CTO 批准的 1B-1 / 1B-2 拆分

| 子阶段 | 内容 | 授权状态 |
|---|---|---|
| 1B-1 | Checkpoint 创建 + 证据校验 + ContextBuilder + 只读恢复计划 + 恢复资格/风险报告 | **本次批准进入实施准备** |
| 1B-2 | 从有效 Checkpoint 创建新 Session、恢复上下文并继续执行；处理恢复失败、重复执行和外部副作用风险 | **本次不授权；必须另行审批** |

1B-1 只能计算、展示和审查恢复计划，不执行恢复动作。即使 `recoveryEligibility=eligible`，也不得创建 Session、启动 Agent 或调用外部工具。1B-2 不得提前实现，也不得通过隐藏开关、环境变量或未文档化入口启用。

理由：1B-1 先证明“Checkpoint 记录的是事实，不是 JSON 摘要”，并建立可解释的恢复资格；1B-2 才涉及自动继续执行和副作用安全，风险明显更高。

---

## 3. Checkpoint 数据模型（v32，已批准 D-1）

### 3.1 表结构

```sql
CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  base_dedupe_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  state TEXT NOT NULL CHECK (state IN ('valid', 'failed')),
  kind TEXT NOT NULL CHECK (kind IN (
    'stage_complete',
    'execution_failed',
    'user_cancelled',
    'rework_started',
    'rework_completed',
    'final_delivery',
    'session_switch',
    'compression'
  )),
  stage TEXT NOT NULL DEFAULT '',
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE RESTRICT,
  team_run_id TEXT REFERENCES team_task_runs(id) ON DELETE RESTRICT,
  parent_checkpoint_id TEXT REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
  acceptance_criteria_work_version INTEGER NOT NULL CHECK (acceptance_criteria_work_version >= 1),
  task_memory_version INTEGER CHECK (task_memory_version IS NULL OR task_memory_version >= 1),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  evidence_status TEXT NOT NULL CHECK (
    evidence_status IN ('verified', 'partial', 'invalid', 'missing', 'not_required')
  ),
  side_effect_completeness TEXT NOT NULL CHECK (
    side_effect_completeness IN ('complete', 'partial', 'not_tracked')
  ),
  checkpoint_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  verification_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, seq),
  UNIQUE (work_id, dedupe_key),
  UNIQUE (work_id, base_dedupe_key, attempt_no)
);

CREATE UNIQUE INDEX idx_task_checkpoints_valid_business_key
  ON task_checkpoints(work_id, base_dedupe_key)
  WHERE state = 'valid';

CREATE INDEX idx_task_checkpoints_work_created
  ON task_checkpoints(work_id, created_at);
CREATE INDEX idx_task_checkpoints_work_state
  ON task_checkpoints(work_id, state, created_at);
CREATE INDEX idx_task_checkpoints_execution
  ON task_checkpoints(execution_id);
CREATE INDEX idx_task_checkpoints_team_run
  ON task_checkpoints(team_run_id);
```

### 3.2 字段语义

| 字段 | 语义 |
|---|---|
| `seq` | Work 内单调递增；在 `BEGIN IMMEDIATE` 事务内分配，`UNIQUE(work_id, seq)` 兜底 |
| `base_dedupe_key` | 业务幂等键；同一终态/同一交付的成功记录唯一 |
| `dedupe_key` | 具体尝试的幂等键；首次为 base key，重试为 `base#attempt-N`；重复请求返回已有记录 |
| `attempt_no` | 创建尝试编号；从 1 开始，`UNIQUE(work_id, base_dedupe_key, attempt_no)`；Phase 1B-1 上限 3 |
| `state` | `valid` 才是可恢复 Checkpoint；`failed` 是创建失败的审计尝试，不冒充成功 |
| `kind` | 触发语义；`session_switch`/`compression` 预留给 Phase 1C，Phase 1B 不产生 |
| `execution_id` / `session_id` | 来源执行/会话；引用对象只保留/归档，`ON DELETE RESTRICT` |
| `node_run_id` / `team_run_id` | 来源节点/团队 run；与 `execution_id` 至少有一个或显式为空；`ON DELETE RESTRICT` |
| `parent_checkpoint_id` | 创建时最近一条 `valid` Checkpoint；形成不可变版本链 |
| `acceptance_criteria_work_version` | 创建时 Work 的正式验收标准版本；历史 Checkpoint 不随后续修改变化 |
| `task_memory_version` | 创建时使用的 Task Memory 版本；与 `acceptance_criteria_work_version` 不一致时证据不能 `verified` |
| `risk_level` | Core 计算，模型不得自报 |
| `evidence_status` | 文件/Artifact/测试证据聚合结果 |
| `side_effect_completeness` | Phase 1B 无 Ledger 时为 `not_tracked` |
| `checkpoint_json` | 任务状态快照 + 进度 + 约束 + 下一步 + Session/Execution 引用 |
| `evidence_json` | 原始证据：文件/Artifact/测试/SideEffectRef 的路径、版本、大小、哈希、来源；不包含验证结论 |
| `verification_json` | 对原始证据逐项校验的结果、原因码、校验时间；与 `evidence_json` 明确分离 |
| `recovery_eligibility` | **不落库**；由 Core 在读取时基于 `state`、`verification_json`、风险、副作用完整性、Worktree 现状计算，并返回原因码 |
| `error_json` | 仅 `state='failed'` 使用；失败阶段、错误、风险、是否阻断 |
| `content_hash` | 对规范化 JSON 的 SHA-256；用于防篡改/重复检测 |
| `created_at` | Core 时间，不使用模型时间 |

### 3.3 不可变与追加

- `task_checkpoints` 禁止 `UPDATE` / `DELETE`，使用触发器保护，语义与 `artifact_versions` 一致。
- **失败记录同样不可变**：失败尝试追加一行 `state='failed'`，不更新旧行；失败行不得原地改成 `valid`，也不得为了保持表干净而自动删除。
- **只有 `valid` 且通过证据校验的记录才有恢复资格**；`failed` 永远不可恢复。
- 每次创建尝试使用独立幂等键，重复请求不得生成重复记录；重试必须追加新的 attempt 行。
- 需要“使旧 Checkpoint 失效”时，不修改旧行；追加新的 Checkpoint 或由读取策略按证据/版本判断。
- 恢复查询只读取 `state='valid'` 且证据/风险满足条件的 Checkpoint。
- **删除语义已批准（D-9）**：v32 `task_checkpoints.work_id` 使用 `ON DELETE RESTRICT`；Work 只允许归档、不做物理删除。若未来需要物理删除 Work，必须先定义显式、受审计的 purge 流程，不能靠级联删除绕过不可变保护。
- 任何 `failed → valid` 的转换必须是一条**新记录**，并重新完成全部证据校验；禁止原地改写状态字段。

### 3.4 幂等键

建议格式：

| 触发 | `dedupe_key` |
|---|---|
| Execution 终态成功 | `execution:<executionId>:stage_complete` |
| Execution 失败 | `execution:<executionId>:execution_failed` |
| Execution 取消 | `execution:<executionId>:user_cancelled` |
| Workflow 节点成功 | `node:<nodeRunId>:stage_complete` |
| Team run 成功 | `team_run:<teamRunId>:stage_complete` |
| 返工开始 | `rework:<reworkRequestId>:started` |
| 返工完成 | `rework:<reworkRequestId>:completed` |
| 最终交付 | `work:<workId>:final_delivery:<completedAt>` |
| 失败尝试 | `baseKey#attempt-<attemptNo>`；Phase 1B-1 最多 3 次尝试 |

注意：`UNIQUE(work_id, dedupe_key)` 与失败尝试存在冲突。按 D-4 批准条件：

- 成功/有效 Checkpoint 使用业务幂等键；每个 `base_dedupe_key` 只允许一条 `state='valid'`；
- 每次创建尝试使用独立键 `baseKey#attempt-<n>`，重复请求返回已有尝试，不生成重复记录；
- 失败尝试不得复用成功记录的幂等键，也不得在失败后直接改写为成功；
- 读取“最近一次创建尝试”时按 `attempt_no`/`created_at`/`seq` 排序；
- 超过最大尝试次数后停止自动重试，保留全部失败记录并写审计。

### 3.5 内容哈希

- 使用确定性 JSON 序列化（键排序、UTF-8、无多余空白）。
- 哈希输入包含：`schemaVersion`、`workId`、`seq`、`baseDedupeKey`、`dedupeKey`、`attemptNo`、`state`、`kind`、`stage`、`executionId`、`sessionId`、`nodeRunId`、`teamRunId`、`parentCheckpointId`、`acceptanceCriteriaWorkVersion`、`taskMemoryVersion`、`riskLevel`、`evidenceStatus`、`sideEffectCompleteness`、`checkpointJson`、`evidenceJson`、`verificationJson`、`errorJson`、`createdAt`。
- 不包含 `id` 与 `contentHash` 自身。
- 读取时重算；不一致即视为损坏，不进入恢复。

### 3.6 Checkpoint JSON 建议

```ts
type TaskCheckpointJson = {
  schemaVersion: 1
  workId: string
  seq: number
  kind: string
  stage: string
  status: 'in_progress' | 'blocked' | 'review' | 'done' | 'failed' | 'cancelled'
  objective: string
  acceptanceCriteria: {
    workVersion: number
    workUpdatedAt: string | null
    items: MemoryItem[]
  }
  memoryVersion: number
  constraints: MemoryItem[]
  completed: MemoryItem[]
  inProgress: MemoryItem[]
  decisions: MemoryItem[]
  issues: MemoryItem[]
  blockers: MemoryItem[]
  nextActions: MemoryItem[]
  openQuestions: MemoryItem[]
  files: FileChangeSummary[]
  tests: TestSummary[]
  artifacts: ArtifactRefSummary[]
  sideEffects: {
    completeness: 'complete' | 'partial' | 'not_tracked'
    refs: SideEffectRef[]
  }
  session: {
    agentraSessionId: string | null
    providerSessionId: string | null
    executionId: string | null
  }
  generatedBy: 'core'
  createdAt: string
}
```

约束：

- 不保存完整 Prompt、完整日志、密钥、Token、密码。
- `MemoryItem` 保留 `verification` 和 `source`；`verified` 只用于 Core 可验证来源。
- `checkpoint_json` 中的 Task Memory 快照是历史副本；当前事实仍以 Work + `task_memories` 为准。
- `files` / `tests` / `artifacts` 是摘要；完整证据在 `evidence_json`。

### 3.7 迁移与旧数据兼容

- v32 迁移只新增 `task_checkpoints` 及索引/触发器；不改 `works`、`task_memories`、`executions`、`agent_sessions` 的既有列。
- 不做旧数据回填、不伪造历史 Checkpoint；旧 Work/Task Memory/Execution 数据必须逐行保留。
- 迁移在单个事务内执行；失败必须整体回滚，不得留下半建表/半索引状态。
- 迁移后必须执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`；失败即停止启动，不继续服务。
- 迁移测试必须包含真实 v31 fixture：旧 Work 验收标准、Task Memory、Execution、Artifact 数据在迁移前后逐项一致。
- 迁移失败不得破坏现有数据库；不得用“删除重建”方式修复。

---

## 4. Checkpoint 生命周期与创建点

### 4.1 创建触发

| 触发 | 建议 kind | 创建时点 | 是否 Phase 1B |
|---|---|---|---|
| Workflow AgentTask 成功 | `stage_complete` | NodeRun 状态落库、Artifact 提交完成之后 | 是 |
| Workflow AgentTask 失败 | `execution_failed` | NodeRun 进入 failed / retry 判定之后 | 是 |
| Execution 取消 | `user_cancelled` | Execution 终态落库、Session 结束之后 | 是 |
| Execution 崩溃 | `execution_failed` | 崩溃被观测并落库之后 | 是 |
| Team Leader/Member run 成功 | `stage_complete` | run 终态、消息/子任务更新之后 | 是 |
| Team run 失败/取消 | `execution_failed` / `user_cancelled` | run 终态之后 | 是 |
| 返工开始/完成 | `rework_started` / `rework_completed` | ReworkService 状态落库之后 | 是（若现有返工路径可挂接） |
| Work 最终交付 | `final_delivery` | Work 进入 completed 之后 | 是 |
| Session 切换/压缩 | `session_switch` / `compression` | Phase 1C | 否 |
| 手动创建 | 不提供 | — | 否 |

### 4.2 集成点

1. **Execution 终态**：复用 `recordTerminalObservation` 已持久化的 `terminalProcessing` 状态。Checkpoint 不在终态事务内做文件哈希；终态事务只写 `checkpointProcessing: pending`，事务提交后由 `CheckpointService` 执行。
2. **Workflow**：在 `ExecutionBridge.onExecutionFinished` 完成 NodeRun 状态/Artifact 提交后、释放下游调度之前调用；Checkpoint 读取 NodeRun `output_snapshot_json` 和 Artifact refs。高风险 Checkpoint 创建失败时，NodeRun 必须进入 `reconciliation_required`（或保持不成功），不得让下游节点被调度。
3. **Team**：在 `TeamCollaborationService.onExecutionTerminal` 完成 run 终态、消息写入、子任务状态更新后、`startQueued` 之前调用；Checkpoint 读取 team run、消息、子任务和 Task Memory。高风险失败时阻止下一个 queued run。
4. **Work 完成**：在 Work 状态迁移到 completed 之后调用；若失败，Work 仍保持 completed，但写入恢复阻断标记和审计，不伪造 Checkpoint。最终交付 Checkpoint 未成功时，不允许把 Work 标记为“可安全恢复的已完成交付”。
5. **启动重放**：Core 启动时扫描 `checkpointProcessing=pending` 的终态 Execution，以及 `state='failed'` 且未超过重试上限的尝试，按 `dedupe_key` 幂等重放。

### 4.3 创建顺序与事务边界

```text
终态事务（短）:
  Execution 终态 + Session 结束 + lock 释放 + terminalProcessing.pending
  + checkpointProcessing.pending
提交
  ↓
CheckpointService（事务外做文件/Artifact 哈希）
  ↓
TaskMemoryService.refreshForWork(work, 'checkpoint_create')
  → 快照版本必须与 Work 当前验收标准版本一致；刷新失败则 Checkpoint 创建失败
  ↓
短事务:
  seq 分配 + task_checkpoints 插入 + audit
  ↓
checkpointProcessing.completed / failed
```

禁止：

- 在持有 Workdir lock 或 Execution 终态事务时读取大量文件。
- 在 Checkpoint 创建失败时回滚已经提交的执行终态。
- 在 Checkpoint 创建失败时伪造 `valid` 行。

### 4.4 失败尝试

- 任何创建失败都写 `state='failed'` 行（如果 DB 可写）或至少写审计；`error_json` 包含阶段、错误、风险、是否阻断。
- **`failed` 永远不可恢复**；只有 `valid` 且通过证据校验的记录才有恢复资格。
- **禁止 `failed → valid` 原地转换**：重试必须追加新的 attempt 行，并重新完成全部证据校验；不得只改状态字段。
- 失败记录同样不可变、不得自动删除，保留审计价值。
- 最大创建尝试次数为 **3**；达到上限后停止自动重试，保留全部失败记录并写审计 `CHECKPOINT_RETRY_LIMIT_REACHED`。
- 每次尝试的 `attempt_no` 在 `BEGIN IMMEDIATE` 事务内按 `MAX(attempt_no)+1` 分配，`UNIQUE(work_id, base_dedupe_key, attempt_no)` 兜底；同一 attempt 重放返回已有记录。
- 高风险任务：失败后阻止下一阶段/下一个 queued run；保留上一个有效 Checkpoint。
- 普通任务：允许当前终态处理完成，但标记恢复能力不足；不自动开启新 Session。
- 读取恢复资格时，最近一次尝试为 `failed` 且风险为 high 时直接阻断，直到产生新的有效 Checkpoint 或人工确认。

### 4.5 不创建 Checkpoint 的情况

- 无 Work 的 scratch Execution。
- 纯只读且没有 Work 关联的临时执行。
- 被明确标记为“非任务执行”的系统执行（Planner 单轮问答等），除非其属于某个 Work。

### 4.6 Checkpoint 生命周期状态机

```text
[Execution 终态 / Work 完成 / 返工事件]
        ↓
checkpointProcessing = pending（持久化标记）
        ↓
   ┌────┴────┐
   ↓         ↓
 valid      failed
   ↓         ↓
不可变     可重试（新 attempt）
             ↓
        valid / failed
```

- `valid` 是不可变终态；不提供更新/删除。
- `failed` 是创建失败尝试；可以追加新的 attempt，不修改旧行。
- 重试必须使用新的 attempt key，不得覆盖原失败记录。
- **`failed` 不得原地改成 `valid`**；必须新增 `valid` 行并重新完成证据校验。
- 失败记录不得自动删除，保留审计价值。
- `valid` 一旦写入，后续状态变化通过追加新 Checkpoint 表达，不回写历史。

---

## 5. 证据模型

### 5.1 FileEvidence

#### 结构

```ts
type FileEvidence = {
  rootKind: 'worktree' | 'work_root'
  worktreeId: string | null
  baselineCommit: string | null
  relativePath: string
  status: 'created' | 'modified' | 'deleted'
  requirement: 'required' | 'reference'
  size: number | null
  sha256: string | null
  verifiedAt: string
  verification: 'verified' | 'missing' | 'mismatch' | 'skipped'
  skipReason?: 'too_large' | 'excluded' | 'symlink' | 'unreadable'
}
```

#### 必需文件 vs 引用文件

| 类型 | 判定 | 缺失/不一致的后果 |
|---|---|---|
| `required` | Worktree 中相对 `baseCommit` 的变更文件（排除生成/缓存/秘密文件）；Workflow 节点声明的必需输出；Artifact 的源文件（若适用）；任务显式声明的交付文件 | `missing` / `invalid`；高风险阻断恢复 |
| `reference` | 未变更但被引用的文件、可选 Artifact、日志/文档/缓存、排除目录中的文件 | 最多 `partial`；不单独阻断低风险恢复 |

#### Worktree 采集规则

1. 必须存在 active `worktrees` 记录，且 `worktree.work_id = work.id`。
2. `worktree.worktree_path` 必须 realpath 后仍等于记录路径；`status='active'`。
3. `base_commit` 必须非空；为空时文件证据不能 `verified`（最多 `partial`）。
4. 使用 `git -C <worktreePath> status --porcelain=v1 -z --untracked-files=all` 获取工作区变更。
5. 使用 `git -C <worktreePath> diff --name-status <baseCommit>` 校验相对基线的变更；若 `baseCommit` 不是 HEAD 祖先，证据 `invalid`。
6. 对每个变更路径：
   - 规范化并限制在 worktree realpath 内；
   - `A` / `??` → `created`；`M` → `modified`；`D` → `deleted`；
   - `created`/`modified` 读取文件并计算 SHA-256；`deleted` 验证文件确实不存在；
   - 符号链接、路径逃逸、非普通文件 → `skipped`，required 时升级为 `invalid`。
7. 排除默认目录：`.git`、`.agentra`、`node_modules`、`dist`、`build`、`.next`、`target`、`coverage`、缓存目录；排除默认文件：`*.log`、`*.tmp`、`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`。
8. 上限：单文件 50 MiB、单 Checkpoint 5,000 文件 / 500 MiB；超限记 `skipped`，required 时不能 `verified`。
9. 不扫描整个 Work root；只处理 git 变更集。

#### 非 Worktree / Team 任务

当前没有结构化文件写入事件，因此：

- 有 `worktree`：按上述 git 规则采集。
- 无 `worktree`：只采集显式 `fileRefs`（由 Workflow/Artifact/任务元数据提供）；不扫描整个 Work root。
- 没有显式 `fileRefs`：`fileEvidenceCompleteness='not_tracked'`，整体证据最多 `partial`。
- 高风险任务缺少可信文件证据时，不得自动恢复。

这是 Phase 1B 的明确限制，不能用“扫描目录猜文件”掩盖。

### 5.2 ArtifactEvidence

```ts
type ArtifactEvidence = {
  artifactId: string
  versionId: string
  version: number
  checksum: string
  workId: string
  executionId: string | null
  requirement: 'required' | 'reference'
  verification: 'verified' | 'missing' | 'mismatch' | 'not_required'
}
```

校验：

1. `artifact` 存在，`artifact.work_id = checkpoint.work_id`。
2. `artifact_version` 存在，`version` 精确匹配 Checkpoint 记录，不要求是最新版本。
3. `checksum` 与 DB 记录一致。
4. 文件位于 `artifactsRoot` 内，路径无符号链接逃逸；文件内容 SHA-256 与 `checksum` 一致。
5. 任一不满足：DB/文件缺失 → `missing`；校验和不一致/跨 Work → `mismatch`。
6. 只存引用，不复制 Artifact 内容。
7. 必需 Artifact 缺失/不一致 → 整体 `missing`/`invalid`；可选 Artifact 问题 → `partial`。

### 5.3 TestEvidence

```ts
type TestEvidence = {
  testKey: string
  name: string
  command: string | null
  result: 'passed' | 'failed' | 'skipped'
  trust: 'runner' | 'agent_claimed'
  startedAt: string | null
  endedAt: string | null
  codeVersion: {
    worktreeId: string | null
    gitCommit: string | null
    dirty: boolean
    diffHash: string | null
    fileHashes: Record<string, string>
  } | null
  reportArtifact: { artifactId: string; version: number; checksum: string } | null
  verification: 'verified' | 'stale' | 'missing' | 'unverifiable'
}
```

代码版本绑定：

1. Worktree 任务：`gitCommit = git rev-parse HEAD`；`dirty = git status --porcelain` 非空；`diffHash = SHA-256(git diff --binary HEAD + 排序后的 untracked 文件内容哈希)`。
2. 非 Worktree 且 Work root 是 Git 仓库：同上，`worktreeId=null`。
3. 非 Git 根：`codeVersion=null`，测试证据 `unverifiable`，不能 `verified`。
4. Checkpoint 创建时计算当前 `codeVersion`；测试证据的 `codeVersion` 必须与当前完全一致（commit + dirty + diffHash）才可能 `verified`；否则 `stale`。
5. `result != passed` 不能作为通过证据；`skipped` 不能作为验证通过。
6. `trust='agent_claimed'` 的测试（当前 `test_result` 输出）只能标记为 `inferred`，不能 `verified`；即使 `pass=true` 也不能证明代码版本。
7. `trust='runner'` 需要结构化测试运行器证据：命令、退出码、开始/结束时间、代码版本、可选报告 Artifact。当前系统尚未提供，Phase 1B 只定义接口。
8. 报告 Artifact 必须同时通过 ArtifactEvidence 校验；报告缺失 → `missing`。

当前 `test_result` 的诚实处理：

- 写入 `checkpoint_json.tests` 作为 Agent 声明，`verification='inferred'`；
- 不作为 `evidenceStatus=verified` 的依据；
- 高风险任务不能仅凭 `test_result pass=true` 进入自动恢复。

### 5.4 证据状态聚合

优先级（从强到弱）：

```text
invalid > missing > partial > verified > not_required
```

| 条件 | `evidence_status` |
|---|---|
| 所有 required 文件/Artifact/测试通过；无 required 项 | `verified` / `not_required` |
| 仅 reference 项缺失/跳过 | `partial` |
| 任一 required 项缺失 | `missing` |
| 任一 required 项存在但 hash/checksum/代码版本不一致，或测试 stale | `invalid` |
| 没有 required 证据且没有 reference 问题 | `not_required` |

补充规则：

- `skipped` 的 required 文件视为不能验证：`invalid`；`skipped` 的 reference 文件视为 `partial`。
- `not_tracked` 的文件证据不能产生 `verified`；最多 `partial`。
- 证据聚合结果写入 `verification_json.summary` 和 Checkpoint 的 `evidence_status` 列；不得通过修改状态字段伪装通过。
- 聚合计算是纯函数，输入相同则结果确定，便于测试和重放。

### 5.5 SideEffectRef 合约（Phase 1B 只定义，不实现 Ledger）

```ts
type SideEffectRef = {
  effectKey: string
  kind: 'deploy' | 'publish' | 'message' | 'external_write' | 'irreversible_command' | 'other'
  status: 'not_started' | 'in_progress' | 'succeeded' | 'failed' | 'unknown'
  completeness: 'complete' | 'partial' | 'not_tracked'
  executionId: string | null
  sessionId: string | null
  toolCallKey: string | null
  idempotencyKey: string | null
  evidenceRef: string | null
  observedAt: string | null
  riskLevel: 'low' | 'medium' | 'high'
}
```

状态机：

```text
not_started → in_progress → succeeded
                         ↘ failed
                         ↘ unknown → 核实 → succeeded | failed
```

不变量：

1. `succeeded` 是终态，不得重复执行；必须有 Core 可验证的证据或明确工具回执。
2. `failed` 只有明确失败且风险允许时，才能用新的 attempt/idempotency key 重试。
3. `in_progress` 在崩溃后只能转为 `unknown`，不得猜成成功或未开始。
4. `unknown` 必须先核实外部结果，不得自动重试。
5. 没有 Ledger 记录时是 `not_tracked`，**不是** `not_started`。
6. `effectKey` 是语义操作键；`idempotencyKey` 是重试幂等键；两者不能混用。
7. `toolCallKey` 关联 `execution_logs` 的 structured tool_use id 或 `team_task_run_steps.step_key`。
8. 模型不能自行认定副作用成功；Checkpoint 只记录 Core 可核实的引用。

Phase 1B（D-8 已批准）：

- 不建 `task_side_effects` 表；
- Checkpoint 的 `sideEffectCompleteness` 统一为 `not_tracked`；
- **`not_tracked` 必须始终明确暴露**：不能因为“没有发现副作用”就标记为 `complete`；
- 高风险任务 + `not_tracked` → 不允许自动恢复/继续不可逆操作；
- 普通任务 + `not_tracked` → 允许执行，但 Checkpoint 明确标记恢复能力不完整；
- `task_side_effects` 表和 Ledger 放 Phase 1D，Phase 1B 只实现引用合约与完整性状态。

---

## 6. 风险分级与恢复边界

### 6.1 风险等级由 Core 计算

输入：

- Agent `accessMode`（analyze/edit）与工具权限；
- Execution 结构化工具事件中的工具名/命令（Bash、Write、Edit、网络命令等）；
- Workflow 节点类型/配置、Team run role；
- 是否 Worktree 内操作、是否写入 Work root 外；
- Artifact 类型/来源；
- SideEffectRef（Phase 1D 后）；
- 任务/Work 显式高风险标记（若未来增加）。

模型不能通过 Prompt 自报风险等级。

### 6.2 已批准的高风险清单与判定规则（D-7 有条件批准）

#### 高风险类别

命中以下任一类别，风险**至少为 `high`**：

| 高风险类别 | 示例 |
|---|---|
| 删除或破坏性操作 | `rm -rf`、批量删除、清空目录 |
| Git 历史或工作区破坏 | `git reset --hard`、`git clean -fd`、`git push --force`、强制覆盖 |
| 外部发布 | 部署生产环境、发布版本、推送正式制品 |
| 数据库破坏性变更 | `DROP`、`TRUNCATE`、生产数据库写入、不可逆数据迁移 |
| 外部资金或交易 | 付款、转账、下单、退款 |
| 账号和权限变更 | 修改权限、吊销凭据、删除账号 |
| 对外不可撤销动作 | 发送正式通知、提交不可撤销表单、发布公开内容 |

#### 判定规则

1. 命中明确高风险规则，风险至少为 `high`。
2. 多条规则冲突时，采用最高风险等级（`high > medium > low`）。
3. 无法识别的命令或操作默认 `medium`，并记录原因；**`medium` 不代表可以自动恢复**。
4. 风险信息不完整、工具事件无法确认时，不得降低风险；无法确认时按更高风险处理。
5. 高风险任务缺少 Side Effect Ledger 时，禁止自动恢复；Phase 1B 统一为 `not_tracked`，因此高风险任务默认不自动恢复。
6. `medium` 风险不代表自动安全；仍必须满足 Checkpoint 的证据要求和恢复资格要求。
7. 风险等级由 Core 根据可观察事实计算；模型只能提供声明，不能决定最终等级。

#### 等级定义与保守默认

| 等级 | 判定 | 示例 |
|---|---|---|
| `high` | 命中高风险类别，或不可逆外部影响无法排除 | 上表全部类别；未知但可能产生外部影响的命令 |
| `medium` | 有副作用能力但无法确认影响 | edit Agent + Bash/网络工具；写入 Work root 外；未知命令；工具日志不完整；非 Worktree 写操作 |
| `low` | 只读/本地受限修改 | analyze 只读；仅 Worktree 内文件编辑且无外部命令；无副作用工具 |

补充：

- 无法判断时默认 `medium`，不默认 `low`。
- 明确不可逆模式 → `high`。
- `risk_reasons` 写入 `verification_json` 和审计，便于解释。
- 高风险任务即使 Checkpoint `verified`，恢复也需要人工确认（Phase 1B 无 Ledger）。
- 规则优先级：明确高风险规则 > 明确低风险规则 > 未知默认 `medium`；任何缺失/冲突不得降低等级。

### 6.3 Checkpoint 创建失败策略

| 风险 | 失败后的行为 |
|---|---|
| `high` | 阻止下一阶段/下一个 queued run；保留上一有效 Checkpoint；标记 `recovery_required`；写审计；不得自动新建 Session |
| `medium` | 当前终态处理可完成；禁止自动恢复/自动新 Session；标记恢复能力不足；写审计 |
| `low` | 允许当前任务继续；写失败审计；标记恢复能力降级；不伪装成功 |

持久化：

- `task_checkpoints.state='failed'` 行（DB 可写时）；
- Execution `recovery_state_json.checkpointProcessing`（pending/failed/completed）；
- `CheckpointService.assertCanStart(workId)` 在 `ExecutionService.startInternal` / Team queued run 前检查最近失败尝试；
- 高风险失败未被新有效 Checkpoint 覆盖时，拒绝启动新的自动执行，返回明确 `RECOVERY_REQUIRED`。

### 6.4 恢复资格矩阵

| 证据状态 | 副作用完整性 | 风险 | 1B-1 只读恢复计划 | 1B-2（未授权，另行审批） |
|---|---|---|---|---|
| `verified` / `not_required` | `complete` 或 `not_tracked` 且无高风险 | low | 返回 eligible + 计划/原因 | 可考虑自动新建 Session |
| `verified` | `complete` | medium | 返回 eligible + 计划/原因 | 建议人工确认后继续 |
| `verified` | `not_tracked` / `partial` | medium | 返回 eligible/conditional + 原因 | 人工确认；不自动继续 |
| `verified` | `complete` | high | 返回 conditional + 人工确认原因 | 人工确认后才可恢复 |
| `verified` | `not_tracked` / `partial` | high | 返回 blocked（副作用不完整） | 阻断；要求人工核实副作用 |
| `partial` | 任意 | low | 返回 conditional + 原因 | 不自动继续 |
| `partial` | 任意 | medium/high | 返回 blocked/conditional + 原因 | 阻断或人工确认 |
| `invalid` / `missing` | 任意 | 任意 | 返回 blocked + 具体原因 | 阻断；报告差异；不覆盖/不回滚/不删除 |
| 无有效 Checkpoint | 任意 | 任意 | 返回 `checkpoint_not_found` | 不称为“恢复”；只能按新任务启动，高风险需人工 |

补充：

- 1B-1 的 `eligible` 只是“计划可生成”，**不是执行许可**；不得创建 Session、启动 Agent 或调用外部工具。
- `medium` 风险不代表自动安全；仍必须满足证据要求，且 1B-1 只返回计划。
- 恢复资格必须返回可解释原因码，见 §9.2。
- 恢复资格是读取时计算，不落库；同一 Checkpoint 在工作区变化后可能从 eligible 变为 blocked。

### 6.5 恢复边界

- 恢复只读：不修改工作区文件，不执行 `git reset`、`git checkout`、`git clean`、`rm`、`mv`。
- **证据校验失败不丢现场**：不覆盖、不回滚、不删除现有工作区文件；只报告差异并保留现场。
- 文件缺失/hash 不一致：报告差异，保留现场，等待人工处理。
- Worktree 已被移除或 baseCommit 不一致：证据 `invalid`，阻断。
- 当前工作区有未记录变更：`invalid` 或 `partial`，不得自动覆盖。
- 恢复计划只包含“将写入新 Session 的上下文”，不包含文件修复动作。
- **路径安全失败即拒绝**：realpath、Worktree 归属、符号链接或路径穿越校验失败时，不得继续读取或写入目标；不得“先读再判断”。
- 高风险任务的恢复必须经过人工审批门禁；Phase 1B 不提供 UI 手动 Session 控制，但可以提供业务级“需要人工处理”状态。
- **1B-1 不执行恢复**：即使 `recoveryEligibility=eligible`，也只返回计划和判断依据，不创建 Session、不启动 Agent、不调用外部工具。

---

## 7. ContextBuilder 设计

### 7.1 输入

- Agent 身份、system prompt、工具权限；
- Work 目标、正式验收标准（Work 版本）；
- Task Memory 当前快照（version、verified/inferred/pending）；
- 最近有效 Checkpoint（含证据状态、风险、副作用完整性）；
- 当前 Work 的 Team/Workflow 线程消息（有界）；
- Artifact refs、FileEvidence 摘要、TestEvidence 摘要；
- SideEffectRefs；
- 当前阶段/节点/子任务。

### 7.2 输出

- 结构化 Prompt 段；
- `context_manifest`：来源、版本、哈希、字节数、裁剪原因、P0/P1/P2/P3 分配；
- 不保存完整 Prompt 到数据库（避免密钥/大日志）；审计只记录 manifest 摘要和来源引用。

### 7.3 优先级

| 层级 | 内容 | 裁剪 |
|---|---|---|
| P0 | Agent 身份/权限、Work 目标与验收标准、最新有效 Checkpoint 的已验证事实/下一步/阻塞、SideEffect 状态、恢复安全约束 | 永不裁剪；超预算 fail-closed |
| P1 | Task Memory 当前进度、约束、决策、问题 | 可压缩/截断，保留来源 |
| P2 | 当前 Work/Team 线程最近消息 | 有界，仅对话连续性，不作为事实来源 |
| P3 | Artifact 摘录、文件摘要、日志尾部 | 可丢弃，记录裁剪 |

### 7.4 预算（D-6 已批准）

Phase 1B 不实现 Token 模型与 70%/85% 阈值。批准约束：

- 使用固定保守字符预算（配置项，例如 60,000 chars），按 UTF-8 字节计算；
- P0 单独上限（例如 30,000 chars）；
- **P0 超限必须 fail-closed**：`CONTEXT_BUDGET_EXCEEDED`，不启动 Execution；不得静默截断关键事实；
- P1/P2/P3 按优先级裁剪，manifest 记录；
- Phase 1C 用 `model_context_windows` + 70%/85% 替换固定预算。

### 7.5 事实与聊天分离

- 聊天消息只用于 P2 对话连续性，不进入“已验证事实”。
- 旧全局 Planner 消息不进入任务事实；只读取当前 Work 明确关联的 Planner/Team 消息。
- Task Memory 的 `inferred`/`pending` 不因进入 Prompt 而升级为 `verified`。
- Checkpoint 的 `verified` 只来自 Core 证据校验，不来自模型文本。
- 没有有效 Checkpoint 时，ContextBuilder 明确标记“无恢复点”，不假装恢复。

### 7.6 Team Leader / Member 差异

- Leader：完整任务目标、验收标准、完整 Task Memory、最新 Checkpoint、全队子任务摘要。
- Member：自己的子任务、相关验收标准、任务约束、与子任务相关的 Task Memory 切片；不读取其他成员私有历史。
- 所有角色都不读取其他 Work 的 Checkpoint/Task Memory。

---

## 8. 路径安全与 Worktree 范围

### 8.1 允许的根

| 根 | 用途 | 规则 |
|---|---|---|
| `worktree.worktree_path` | Worktree 文件证据 | active、属于当前 Work、realpath 校验 |
| `work.root_path` | 非 Worktree 任务的显式文件证据 | realpath 校验；不扫描整树 |
| `artifactsRoot` | Artifact 文件 | 独立根；O_NOFOLLOW；路径不得逃逸 |

### 8.2 拒绝条件

- 绝对路径作为 `relativePath`；
- `..`、`.` 之外的路径穿越；
- NUL 字节、空路径；
- 符号链接组件或符号链接文件；
- realpath 不在根内；
- 根是 `/`、用户 home、Agentra 数据根、另一个 Work 的 worktree；
- Worktree 已 removed 或不属于当前 Work；
- 文件不是普通文件（目录、设备、socket、FIFO）；
- 超过大小/数量上限且被标记 required。

### 8.3 读取安全

- 使用 `lstat` 检查每一级路径，拒绝 symlink；
- 读取使用 `O_NOFOLLOW`；
- 读取后校验 `fstat` 是普通文件；
- 计算 SHA-256 时限制读取字节数；
- 不把文件内容写入日志/Checkpoint；只存 hash/size/状态；
- 不读取 `.env`、密钥、凭证文件；required 时标记 `skipped`/`invalid`，要求人工处理。

---

## 9. 证据、验证与恢复资格的可解释性

### 9.1 三层分离

原始证据、验证结果、恢复资格必须明确分离，不能只保存一个 `verified=true`：

| 层 | 存储 | 内容 |
|---|---|---|
| 原始证据 | `evidence_json` | 文件路径/大小/哈希、Artifact id/version/checksum、测试命令/代码版本、SideEffectRef、来源执行 |
| 验证结果 | `verification_json` + `evidence_status` | 每项证据的 `verified/missing/mismatch/skipped/stale/unverifiable`、原因码、校验时间、聚合结果 |
| 恢复资格 | **读取时计算，不落库** | 基于 `state`、验证结果、风险、副作用完整性、当前 Worktree/文件状态；返回 `eligible/conditional/blocked` 与原因码 |

约束：

- `evidence_status=verified` 只表示证据层通过，不等于 `recoveryEligibility=eligible`。
- `recoveryEligibility=eligible` 在 1B-1 也只表示“可生成只读恢复计划”，不代表允许执行恢复。
- 工作区变化后，同一 Checkpoint 的恢复资格可以变化；因此不把 eligibility 固化在 Checkpoint 行内。
- 任何“已验证”结论必须能追溯到具体证据和校验规则。

### 9.2 恢复资格原因码

Core 必须返回具体原因，不得只返回 `false`。建议原因码：

| 原因码 | 含义 |
|---|---|
| `CHECKPOINT_NOT_FOUND` | 没有有效 Checkpoint |
| `CHECKPOINT_STATE_FAILED` | 最近尝试是 `failed`，不可恢复 |
| `CHECKPOINT_WORK_MISMATCH` | Checkpoint 不属于请求的 Work |
| `CHECKPOINT_RETRY_LIMIT_REACHED` | 已达到最大创建尝试次数，停止自动重试 |
| `CHECKPOINT_CONTENT_HASH_MISMATCH` | Checkpoint 内容哈希不一致，视为损坏 |
| `CHECKPOINT_TASK_MEMORY_STALE` | Task Memory 版本与 Checkpoint 记录不一致 |
| `FILE_REQUIRED_MISSING` | 必需文件不存在 |
| `FILE_HASH_MISMATCH` | 必需文件哈希不一致 |
| `FILE_PATH_UNSAFE` | realpath/符号链接/路径穿越校验失败 |
| `FILE_EVIDENCE_NOT_TRACKED` | 非 Worktree 且缺少显式 fileRefs |
| `WORKTREE_MISSING` | Worktree 已移除或不属于当前 Work |
| `WORKTREE_BASE_MISMATCH` | baseCommit 缺失或不是 HEAD 祖先 |
| `ARTIFACT_MISSING` | Artifact 行或文件缺失 |
| `ARTIFACT_CHECKSUM_MISMATCH` | Artifact checksum/内容不一致 |
| `ARTIFACT_CROSS_WORK` | Artifact 不属于当前 Work |
| `TEST_CODE_VERSION_STALE` | 测试代码版本与当前不一致 |
| `TEST_UNVERIFIABLE` | 测试没有 runner 证据或缺少代码版本 |
| `TEST_FAILED_OR_SKIPPED` | 测试失败/跳过，不能作为通过证据 |
| `EVIDENCE_PARTIAL` | 仅参考证据缺失，恢复受限 |
| `SIDE_EFFECTS_NOT_TRACKED` | 无 Ledger，副作用完整性未知 |
| `RISK_TOO_HIGH` | 高风险任务不满足自动恢复条件 |
| `CONTEXT_BUDGET_EXCEEDED` | P0/总上下文超出固定预算，恢复计划 fail-closed |
| `RECOVERY_NOT_AUTHORIZED_IN_1B1` | 1B-1 不允许执行恢复，只能返回计划 |

### 9.3 审计事件

建议审计事件：

| 事件 | 关键字段 |
|---|---|
| `checkpoint.created` | checkpointId、workId、seq、kind、executionId、riskLevel、evidenceStatus、sideEffectCompleteness、contentHash |
| `checkpoint.failed` | workId、attemptKey、kind、riskLevel、stage、errorCode、blocked |
| `checkpoint.recovery_blocked` | checkpointId、reasonCodes、evidenceStatus、riskLevel、sideEffectCompleteness |
| `checkpoint.deduplicated` | dedupeKey、existingCheckpointId |
| `context.built` | executionId、checkpointId、p0/p1/p2/p3 bytes、trimmed counts、source refs |
| `context.budget_exceeded` | executionId、p0Bytes、budget、reason |

要求：

- 审计不含密钥、完整 Prompt、完整文件内容；
- 审计与 Checkpoint 创建在同一短事务或明确顺序写入；
- 失败不能只写日志不写审计；
- UI 只显示业务状态/异常，不暴露 Session/Checkpoint 手动控制；
- `checkpoint.recovery_blocked` 必须记录具体原因码，便于人工判断。

---

## 10. 失败矩阵

| 场景 | 期望行为 |
|---|---|
| Checkpoint DB 写入失败，高风险 | 不产生 valid Checkpoint；写 failed 尝试；阻断下一阶段；保留上一有效 Checkpoint |
| Checkpoint DB 写入失败，低风险 | 写 failed 尝试/审计；当前终态保留；标记恢复能力降级 |
| 文件缺失，required | `evidenceStatus=missing`；高风险阻断 |
| 文件 hash 不一致，required | `invalid`；阻断；报告差异 |
| 文件被排除/超限，required | `invalid`；不读取内容；要求人工 |
| 符号链接/路径逃逸 | 拒绝读取；`invalid`；审计 |
| Worktree baseCommit 为空 | 文件证据最多 `partial`；高风险阻断 |
| Worktree 已移除 | `missing`/`invalid`；阻断 |
| Artifact 行缺失/文件缺失 | `missing`；阻断 required |
| Artifact checksum 不一致 | `invalid`；阻断 |
| Artifact 属于其他 Work | `invalid`；阻断 |
| 测试为 Agent 声明 | `inferred`；不能 `verified` |
| 测试代码版本过期 | `stale`；required 时 `invalid` |
| 测试 skipped/failed | 不能作为通过证据 |
| 无 Ledger | `sideEffectCompleteness=not_tracked`；高风险阻断恢复 |
| 失败记录尝试改 valid | 拒绝；必须新增 attempt 并重新校验证据 |
| 失败记录被当作可恢复 | 拒绝；只有 `state='valid'` 且证据通过才有资格 |
| 1B-1 恢复资格 eligible | 只返回计划和原因；不创建 Session/不启动 Agent/不调用外部工具 |
| 证据校验失败 | 保留现场；不覆盖/不回滚/不删除 |
| realpath/Worktree/符号链接校验失败 | 立即拒绝读取/写入；不继续访问目标 |
| v32 迁移失败 | 整体回滚；旧库保持 v31；不得半迁移启动 |
| 恢复时文件缺失/hash 不一致 | 报告差异；不覆盖/不回滚/不删除 |
| P0 超预算 | fail-closed；不启动 Execution |
| 旧全局 Planner 消息 | 不作为任务事实；只保留，不进入 P0/P1 |

---

## 11. Phase 1B-1 实施验收矩阵

| # | 场景 | 预期 |
|---|---|---|
| 1 | v32 迁移从 v31 升级 | `task_checkpoints` 存在；旧 Work/Task Memory/Execution 数据完整；integrity/fk 通过 |
| 2 | Execution 成功终态 | 创建 `stage_complete` Checkpoint；seq=1；dedupe 幂等 |
| 3 | Execution 失败/取消/崩溃 | 创建对应 kind；不标记完成；风险/证据正确 |
| 4 | 同一终态重复观测/重放 | 只产生一条有效 Checkpoint；dedupe 审计 |
| 5 | 并发创建 | `UNIQUE(work_id, seq)` 下 seq 单调，无重复 |
| 6 | 不可变 | UPDATE/DELETE 被触发器拒绝 |
| 7 | Worktree 文件变更 | created/modified/deleted 状态、size、SHA-256 正确 |
| 8 | 必需文件缺失 | `missing`，高风险阻断 |
| 9 | 文件 hash 不一致 | `invalid`，不覆盖 |
| 10 | 路径穿越/符号链接 | 拒绝；`invalid`；不读取外部文件 |
| 11 | 文件过大/排除目录 | `skipped`；required 不能 verified |
| 12 | Worktree baseCommit 为空/不是祖先 | 最多 `partial` 或 `invalid` |
| 13 | Artifact 版本/checksum 正确 | `verified`；历史版本不要求最新 |
| 14 | Artifact 缺失/checksum 不一致/跨 Work | `missing`/`invalid` |
| 15 | 测试 runner 证据匹配代码版本 | `verified` |
| 16 | 测试代码版本变化 | `stale`；required 时 `invalid` |
| 17 | Agent `test_result` | `inferred`，不能 `verified` |
| 18 | 证据聚合优先级 | invalid > missing > partial > verified > not_required |
| 19 | 无 Ledger | `sideEffectCompleteness=not_tracked`；高风险阻断 |
| 20 | SideEffectRef 引用缺失 Ledger | 标记不完整；不得当作 not_started |
| 21 | Checkpoint 创建失败高风险 | 阻断下一阶段；保留上一 Checkpoint；审计 |
| 22 | Checkpoint 创建失败低风险 | 当前终态保留；标记降级；不自动新 Session |
| 23 | 恢复资格矩阵 | 各风险/证据组合符合 §6.4 |
| 24 | 恢复不修改工作区 | 文件系统快照前后一致；无 reset/checkout/clean/rm |
| 25 | ContextBuilder P0 超预算 | fail-closed；不启动 Execution |
| 26 | ContextBuilder 裁剪 | P1/P2/P3 按优先级；manifest 可追溯 |
| 27 | 不重放全部聊天 | Prompt 只含当前 Work 有界消息；旧全局 Planner 不进入事实 |
| 28 | Leader/Member 切片 | Leader 完整；Member 只读自己子任务相关切片 |
| 29 | 无 Session/Provider Resume 变化 | 不出现 resumeSessionId；Session 仍每次新建 |
| 30 | 全量回归 | 现有 897 用例通过；无 UI 手动 Session 入口 |
| 31 | 失败记录不可变 | `state='failed'` 行 UPDATE/DELETE 被拒绝；不得原地改为 valid |
| 32 | 失败记录不可恢复 + 尝试幂等 | 恢复查询不返回 failed；同一 attempt 重复请求不生成重复行 |
| 33 | 证据/验证/资格分离 | `evidence_json`、`verification_json`、`recoveryEligibility` 分别可查；不能只靠 `verified=true` |
| 34 | 恢复资格原因可解释 | blocked/conditional 返回具体原因码（文件缺失、hash 不一致、Artifact 缺失、测试版本不匹配、风险过高等） |
| 35 | 1B-1 eligible 不执行恢复 | 只返回计划/原因；无 Session 创建、无 Agent 启动、无外部工具调用 |
| 36 | 路径安全失败即拒绝 | realpath/Worktree 归属/符号链接/穿越失败时零读取、零写入 |
| 37 | v32 迁移失败回滚 | 旧 v31 数据完整；无半建表；不启动服务 |
| 38 | 高风险清单与规则优先级 | 命中高风险类别至少 high；冲突取最高；未知 medium；信息不完整不降级 |
| 39 | `not_tracked` 明确暴露 | 即使未发现副作用，也不得标记 `complete`；高风险阻断 |

---

## 12. CTO 正式批准记录（2026-11-09）

### 12.1 批准结论

- D-1 至 D-6、D-8、D-9：**批准**。
- D-7：**有条件批准**；批准条件已写入本文 §6.2。
- Phase 1B-1：**获准进入实施准备**。
- Phase 1B-2：**本次不授权**；必须另行审批。
- 代码实施：**尚未授权**；需本设计文档完成修订并经 CTO 确认后另行启动。

| 决策 | CTO 结论 | 批准条件 |
|---|---|---|
| D-1：v32 只新增 `task_checkpoints` | 批准 | 不新增副作用表、不扩展 Session、不新增 Token 表 |
| D-2：非 Worktree 文件证据 | 批准 | 只接受显式 `fileRefs`；缺少引用时不得扫描目录猜测 |
| D-3：当前 `test_result` 证据等级 | 批准 | Agent 声明不得升级为 `verified` |
| D-4：失败尝试使用 `state='failed'` | 批准 | `failed` 不可恢复；`valid` 才有恢复资格；失败记录也必须不可变 |
| D-5：1B-1 / 1B-2 拆分 | 批准 | 当前只批准 1B-1；1B-2 必须另行审批 |
| D-6：固定字符预算 | 批准 | P0 超预算必须 fail-closed，不得静默截断关键事实 |
| D-7：风险分级 | 有条件批准 | 必须补齐高风险操作清单、规则优先级和阻断行为 |
| D-8：Side Effect Ledger 放 Phase 1D | 批准 | 1B 只定义引用合约和 `not_tracked` 状态 |
| D-9：`ON DELETE RESTRICT` | 批准 | Work 只归档，不物理删除；Checkpoint 不允许级联删除 |

### 12.2 D-4 批准条件：失败记录不可恢复

- `valid`：只有通过证据校验的记录才有恢复资格。
- `failed`：记录创建失败、证据校验失败等情况，**不允许恢复**。
- 每次创建尝试使用独立幂等键；重复请求不能生成重复记录。
- 已经写入的 Checkpoint 不允许原地修改为另一个事实版本。
- 失败记录也保留审计价值，不得为了保持表干净而自动删除。
- **禁止**：某次 Checkpoint 创建失败后，直接把该行改成 `valid`，却没有重新完成证据校验。必须新增记录并重新校验。

对应实现约束：见 §3.3、§3.4、§4.4、§4.6。

### 12.3 D-5 批准条件：Phase 1B 分成两个独立授权阶段

#### Phase 1B-1（本次批准进入实施准备）

- Checkpoint 创建。
- 文件、Artifact、测试证据校验。
- ContextBuilder。
- 只读恢复计划。
- 恢复资格计算与风险报告。

只计算、展示和审查恢复计划，**不执行恢复动作**。即使恢复资格为 `eligible`，1B-1 也只能返回计划和判断依据，不得创建 Session、启动 Agent 或调用外部工具。

#### Phase 1B-2（另行审批，本次不授权）

- 从有效 Checkpoint 创建新 Session。
- 恢复上下文并继续执行。
- 处理恢复失败、重复执行和外部副作用风险。

本次不授权，不得提前实现，也不得通过隐藏开关、环境变量或未文档化入口启用。

对应实现约束：见 §2.3、§6.4、§6.5。

### 12.4 D-7 批准条件：高风险清单与判定规则

已写入 §6.2，批准条件包括：

1. 命中明确高风险规则，风险至少为 `high`。
2. 多条规则冲突时，采用最高风险等级。
3. 无法识别的命令或操作默认 `medium`，并记录原因。
4. 风险信息不完整、工具事件无法确认时，不得降低风险。
5. 高风险任务缺少 Side Effect Ledger 时，禁止自动恢复。
6. `medium` 风险不代表自动安全；仍然必须满足 Checkpoint 的证据和恢复资格要求。
7. 风险等级由 Core 根据可观察事实计算；模型只能提供声明，不能决定最终等级。

高风险类别必须覆盖：删除/破坏性操作、Git 历史/工作区破坏、外部发布、数据库破坏性变更、外部资金/交易、账号和权限变更、对外不可撤销动作。完整清单见 §6.2。

**特别注意**：“未知默认 medium”不等于“未知操作可以自动恢复”；`medium` 仍受证据、副作用完整性和恢复资格矩阵约束。

### 12.5 Phase 1B-1 额外工程约束

1. **证据与结论分离**：原始证据、验证结果、恢复资格分别存储或明确区分，不能只保存一个 `verified=true`。见 §9.1。
2. **恢复资格可解释**：Core 返回不符合资格的具体原因，例如文件缺失、哈希不一致、Artifact 不存在、测试版本不匹配、风险过高。见 §9.2。
3. **证据校验失败不丢现场**：不覆盖、不回滚、不删除现有工作区文件。
4. **路径安全失败即拒绝**：realpath、Worktree 归属、符号链接及路径穿越校验失败时，不得继续读取或写入目标。
5. **Checkpoint 不得伪造完整性**：`sideEffectCompleteness=not_tracked` 必须始终明确暴露，不能因为没有发现副作用就标记为 `complete`。
6. **旧数据兼容**：v31 数据必须保持完整，迁移失败不能破坏现有数据库。见 §3.7。
7. **Git 工作区保护**：保留当前所有未提交变更；禁止 `reset`、`clean`、`checkout`、`stash`、自动 commit。

### 12.6 正式授权范围

#### 允许的工作

- 更新本设计文档，纳入 CTO 决策。
- 根据批准后的设计制定迁移和实现计划。
- 检查现有代码、数据库和服务接口，确认实现位置。

#### 当前不允许

- 修改业务代码。
- 新增 v32 数据库迁移。
- 修改协议和 Session 生命周期。
- 实现自动恢复或创建新 Session。
- 启动 Phase 1C、Phase 1D。
- 提交 Git。

### 12.7 本次文档修订声明

该次设计修订仅修改 `docs/phase1b-checkpoint-context-builder-design-gate.md`，将上述决策写入 §12 并同步相关章节；该次修订未修改代码、数据库、协议或 Git 状态。随后 Phase 1B-1 代码实施获 CTO 正式授权，实施结果见 `docs/phase1b1-implementation-report.md`。

---

## 13. 门禁结论

- 设计已覆盖 CTO 指定的 7 个主题：Checkpoint 数据结构/生命周期、FileEvidence、ArtifactEvidence、TestEvidence、SideEffectRef、风险分级/恢复边界、路径/Worktree 安全。
- 关键结论：**Checkpoint 是“事实 + 证据 + 风险 + 恢复资格”的不可变交接记录，不是上下文 JSON 摘要。**
- CTO 已批准 D-1 至 D-6、D-8、D-9；D-7 有条件批准，条件已写入 §6.2。
- **Phase 1B-1 已实施完成，CTO 报告级验收通过并正式关闭（2026-11-09）**；实施报告见 `docs/phase1b1-implementation-report.md`。
- Phase 1B-2 等待单独设计与授权；未授权、未实现。
- Phase 1C/1D 继续未启动；Git 工作区保持未提交，禁止 reset/clean/checkout/stash/自动 commit。
- 当前保护：正式库保持 `user_version=32`；保留 Phase 1B-1 迁移前备份及外置副本；不创建恢复 Session、不自动恢复、不调用外部工具执行恢复。
