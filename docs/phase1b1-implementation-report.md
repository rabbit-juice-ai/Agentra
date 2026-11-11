# Phase 1B-1 实施报告：Checkpoint + Evidence + ContextBuilder

- 日期：2026-11-09
- 状态：**CTO 报告级验收通过并正式关闭（2026-11-09）**
- 验收边界：本次验收基于提交的实施报告，不等同于 CTO 独立逐行审查源代码、运行测试或重新检查正式数据库
- 边界：Phase 1B-2 未实施；未创建 Session、未自动恢复、未调用外部工具执行恢复
- 基线：Phase 1A 已关闭；迁移前 DB `user_version=31`；当前 DB `user_version=32`
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；未 commit、未 reset、未 clean、未 checkout、未 stash

---

## 0. CTO 验收结论

- Phase 1B-1：**验收通过 · 已关闭**。
- Phase 1A：已关闭。
- Phase 1B-2：等待单独授权；未启动。
- Phase 1C / 1D：未启动。
- 当前保护：正式库保持 `user_version=32`；保留迁移前备份及外置副本；保留 main 与全部未提交改动；不 commit/reset/clean/checkout/stash；不回滚 v32；不创建恢复 Session、不自动恢复、不调用外部工具执行恢复。

验收确认的当前阶段限制（不作为缺陷）：

1. 非 Worktree 文件证据依赖显式 `fileRefs`。
2. Agent 自报测试结果只能是 `inferred`，不能冒充已验证测试。
3. `side_effect_completeness` 固定 `not_tracked`，高风险恢复受限。
4. ContextBuilder 尚未接入现有 Execution Prompt 组装路径。
5. 暂无 Checkpoint / 恢复 UI 和 RPC。
6. ReworkService 暂无独立 `rework_started` / `rework_completed` Checkpoint 语义。

---

## 1. 实施范围

已实现：

1. v32 `task_checkpoints` 迁移、索引、不可变触发器。
2. `CheckpointRepository` / `CheckpointService`。
3. FileEvidence / ArtifactEvidence / TestEvidence 采集与校验。
4. SideEffectRef 合约与 `not_tracked` 完整性状态。
5. Core 风险分级、恢复资格计算、只读恢复计划。
6. ContextBuilder P0/P1/P2/P3 与固定预算 fail-closed。
7. Checkpoint 创建接入 Execution 终态、Workflow 节点终态、Team run 终态、Work 最终交付。
8. 审计、失败尝试、启动重试与高风险启动阻断。
9. 迁移、证据、风险、恢复、ContextBuilder、集成与全量回归测试。

未实现（明确禁止）：

- 从 Checkpoint 创建新 Session。
- 自动恢复或继续执行。
- 调用外部工具执行恢复。
- 通过隐藏开关/环境变量启用恢复。
- Phase 1C / 1D 任何内容。

---

## 2. 三个工程细节的处理

### 2.1 不可变触发器与外键删除策略

- 统一采用 `ON DELETE RESTRICT`：`work_id`、`execution_id`、`session_id`、`node_run_id`、`team_run_id`、`parent_checkpoint_id`。
- 不使用 `ON DELETE SET NULL` / `CASCADE`，避免外键动作改写或删除不可变 Checkpoint。
- Work 只归档、不物理删除；迁移测试验证删除 Work 会被外键拒绝。
- `task_checkpoints` 的 `UPDATE` / `DELETE` 由触发器拒绝；`failed` 记录同样不可变。
- 测试：`apps/core/src/db/checkpoint-migration.test.ts`、`checkpoint-service.test.ts`。

### 2.2 content_hash 覆盖完整不可变字段

`hashCheckpointContent` 的输入包含：

```text
schemaVersion, workId, seq, baseDedupeKey, dedupeKey, attemptNo, state,
kind, stage, executionId, sessionId, nodeRunId, teamRunId,
parentCheckpointId, acceptanceCriteriaWorkVersion, taskMemoryVersion,
riskLevel, evidenceStatus, sideEffectCompleteness,
checkpointJson, evidenceJson, verificationJson, errorJson, createdAt
```

- 使用确定性 JSON（键排序、UTF-8）。
- 只排除 `id` 与 `contentHash` 自身。
- `valid` 和 `failed` 记录都计算并验证。
- 读取恢复计划时重新计算；不一致即视为损坏，不进入恢复。
- 测试：`checkpoint-service.test.ts`、`checkpoint-migration.test.ts`。

### 2.3 失败尝试重试策略

- 最大尝试次数：**3**（`MAX_CHECKPOINT_ATTEMPTS`）。
- `base_dedupe_key` 表示业务幂等键；`attempt_no` 表示尝试编号；`dedupe_key` 为具体尝试键（首次 `baseKey`，后续 `baseKey#attempt-N`）。
- 并发分配在 `BEGIN IMMEDIATE` 事务内按 `MAX(attempt_no)+1`，并由 `UNIQUE(work_id, base_dedupe_key, attempt_no)` 兜底。
- 同一 attempt 重放返回已有记录，不生成重复行。
- 失败记录保留、不可修改、不自动删除；超过上限停止自动重试并写 `checkpoint.failed` 审计，`errorCode=CHECKPOINT_RETRY_LIMIT_REACHED`。
- 启动时 `CheckpointService.retryPending()` 扫描最新失败尝试并重试；高风险失败在产生新 valid Checkpoint 前阻断新执行。
- 测试：`checkpoint-service.test.ts`（失败、重试、上限、`assertCanStart`）。

---

## 3. v32 正式迁移结果

迁移前：

- 数据库：`~/Library/Application Support/agentra/agentra.db`
- `user_version=31`
- Works=2，Executions=37，无 active Execution
- `task_checkpoints` 不存在

迁移前备份：

- Backup ID：`bak-fcdbd159-91f1-48da-bf60-460c62e8e564`
- 包路径：`~/Library/Application Support/agentra/backups/bak-fcdbd159-91f1-48da-bf60-460c62e8e564`
- 外置副本：`/Volumes/MacExt SSD/AgentraBackups/phase1b1-pre-v32-20261109-120650`
- `database.db` SHA-256：`4f98b4128039693448b14b021f36f9cd87d2dee45c0a043408139ba5e6710f8d`
- 大小：276,946,944 bytes
- Manifest SHA 与实际一致；外置副本逐字节一致
- 备份内 `integrity_check=ok`、`user_version=31`、Works=2、Executions=37

迁移执行：

- 使用新版本 Core 的 `migrate()`
- `fromVersion=31` → `toVersion=32`
- 应用迁移：`task_checkpoints`
- 迁移后 `PRAGMA integrity_check=ok`
- `PRAGMA foreign_key_check`：0 违规
- 2 个旧 Work 完整保留；`task_memories` 0 行；`task_checkpoints` 0 行
- 表列包含 `state`、`base_dedupe_key`、`attempt_no`、`verification_json`、`content_hash` 等
- 不可变触发器存在：`trg_task_checkpoints_immutable_update`、`trg_task_checkpoints_immutable_delete`

运行验证：

- 新 Core PID 59282，`core.health` 返回 `status=ok`、`protocolVersion=1`
- `work.list` 返回 2 个旧 Work
- 启动日志 `database ready fromVersion=32 toVersion=32 applied=[]`
- 无 error 日志

---

## 4. 实现文件

新增：

- `apps/core/src/db/repositories/checkpoint-repository.ts`
- `apps/core/src/services/checkpoint-schemas.ts`
- `apps/core/src/services/checkpoint-hash.ts`
- `apps/core/src/services/checkpoint-path-safety.ts`
- `apps/core/src/services/checkpoint-file-evidence.ts`
- `apps/core/src/services/checkpoint-artifact-evidence.ts`
- `apps/core/src/services/checkpoint-test-evidence.ts`
- `apps/core/src/services/checkpoint-risk.ts`
- `apps/core/src/services/checkpoint-recovery.ts`
- `apps/core/src/services/checkpoint-service.ts`
- `apps/core/src/services/context-builder.ts`
- `apps/core/src/db/checkpoint-migration.test.ts`
- `apps/core/src/services/checkpoint-service.test.ts`
- `apps/core/src/services/checkpoint-evidence.test.ts`
- `apps/core/src/services/checkpoint-risk.test.ts`

修改：

- `apps/core/src/db/migrations.ts`（v32）
- `apps/core/src/db/repositories/execution-log-repository.ts`（structured 查询）
- `apps/core/src/services/task-memory-service.ts`（version 读取、schema 导出）
- `apps/core/src/services/work-service.ts`（提交后 transition 回调）
- `apps/core/src/services/execution-service.ts`（启动阻断、终态 Checkpoint）
- `apps/core/src/services/team-collaboration-service.ts`（Team run Checkpoint、阻断 queued run）
- `apps/core/src/workflow/execution-bridge.ts`（节点 Checkpoint、阻断下游）
- `apps/core/src/index.ts`（装配、启动重试、最终交付）
- 对应迁移测试与集成测试
- `docs/phase1b-checkpoint-context-builder-design-gate.md`（补充实际 v32 字段、attempt 策略、原因码）

---

## 5. 测试与门禁

实际执行：

- `pnpm test`：**106 文件 / 931 用例全部通过**
- `pnpm typecheck`：通过
- `pnpm lint`：退出码 0，7 个既有 optional-chain warning，无 error
- `pnpm build`：通过，发布构建检查通过

新增覆盖：

- v31 → v32 真实 fixture、旧 Work/TaskMemory 保留、触发器、外键 RESTRICT。
- Checkpoint 创建、valid/failed 不可变、重复终态去重、seq/attempt 并发约束。
- 失败尝试、最大 3 次重试、高风险启动阻断、恢复后 valid 解阻。
- 文件证据：created/modified/deleted、SHA-256、排除文件、符号链接、路径穿越。
- Artifact 证据：版本/checksum、文件缺失、篡改、跨 Work。
- 测试证据：runner 代码版本绑定、Agent `test_result` 为 `inferred`、代码变化后 stale。
- 风险分级：高风险命令、冲突取最高、未知 medium、工具事件不完整不降级。
- 恢复资格：eligible、blocked、文件 hash 变化、Worktree 移除、跨 Work Checkpoint、原因码。
- ContextBuilder：P0/P1/P2/P3、P0 fail-closed、P3/P2/P1 裁剪、manifest。
- 集成：ExecutionService 启动阻断、Team queued run 阻断、Workflow run 转 `reconciliation_required`、Work 最终交付 Checkpoint。

---

## 6. 已知限制与差异

1. **非 Worktree 文件证据**：只接受显式 `fileRefs`；Team 任务无 Worktree 时文件证据为 `not_tracked`，整体证据最多 `partial`，恢复资格为 conditional/blocked。这是 D-2 批准的限制。
2. **测试证据**：当前 `test_result` 是 Agent 声明，标记 `agent_claimed` / `inferred`，不能把 Checkpoint 提升为 `verified`；真实 runner 证据接口已定义但未接入。
3. **Side Effect Ledger**：Phase 1B-1 不建表，Checkpoint 统一 `side_effect_completeness=not_tracked`；高风险任务恢复被阻断。Phase 1D 实现。
4. **Rework 专项 Checkpoint**：当前未单独挂接 ReworkService 的 `rework_started` / `rework_completed`；返工 attempt 的 Execution 终态仍会生成 Checkpoint。若 CTO 要求返工级语义，应作为后续独立任务。
5. **ContextBuilder 使用范围**：已实现并用于只读恢复计划；未改变现有 Execution Prompt 组装路径，避免在 1B-1 改变执行行为。1B-2 再接入新 Session 恢复。
6. **UI/RPC**：未新增 Checkpoint/恢复 UI 或 RPC；符合 1B-1 只读恢复计划、无手动 Session 控制的要求。
7. **1B-2**：未实现、未启用；没有创建 Session、没有自动继续执行。

---

## 7. Git 与数据保护

- HEAD：`9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`
- 未 commit、未 reset、未 clean、未 checkout、未 stash
- 迁移前备份与外置副本保留
- 未在开发测试中覆盖正式数据库；正式迁移前已再次备份
- Phase 1A 旧备份仍保留

## 8. 结论

Phase 1B-1 已完成授权范围内的代码实施与正式 v32 迁移，并已获 CTO 报告级验收通过、正式关闭。**Phase 1B-2 等待单独设计与授权；不启动 Phase 1C/1D。**
