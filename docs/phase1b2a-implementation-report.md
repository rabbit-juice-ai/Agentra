# Phase 1B-2A 实施报告：显式 Session 恢复

- 日期：2026-11-09
- 状态：**缺陷修复完成，等待 CTO 复审**
- 边界：Phase 1B-2B 未实施；未触碰 Workflow NodeRun 恢复；未启动 Phase 1C/1D
- 基线：Phase 1A、1B-1 已关闭；迁移前 DB `user_version=32`；当前 DB `user_version=33`
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；未 commit、未 reset、未 clean、未 checkout、未 stash

---

## 0. 本次决策落实

- **D-6a 采用推荐 A**：新增专用 `completed → active` 重开转换，仅由 `work.recovery.start` 调用；记录原完成状态、原因、Checkpoint、操作者确认、Recovery Attempt；清除 `completedAt`，写 `work.reopened` 审计。
- **D-4a 采用新增业务错误码**：`RECOVERY_*` 错误码加入协议 `RpcErrorCode`；`work.recovery.plan` 为只读，`work.recovery.start` 为写。
- 其余 D-1..D-10 按 CTO 决策实施。

---

## 1. 实施范围

1. v33 `task_recovery_attempts` 迁移、索引、唯一约束、外键 RESTRICT。
2. `RecoveryAttemptRepository` / `RecoveryService`。
3. `work.recovery.plan` / `work.recovery.start` RPC。
4. Team / Work 最终交付 / 通用 Work 三种恢复路径。
5. 新 Session / 新 Execution 创建与 Recovery Attempt 原子关联。
6. ContextBuilder 恢复 Prompt（P0-P3、角色契约、预算 fail-closed）。
7. completed Work 显式重开机制。
8. 失败停止、崩溃对账、审计、幂等与次数限制。
9. 迁移、服务、RPC、执行事务和全量回归测试。

未实施：Phase 1B-2B Workflow NodeRun 恢复、Phase 1C SessionLifecycle、Phase 1D SideEffect Ledger、Provider Resume、恢复 UI。

---

## 2. v33 数据模型

`task_recovery_attempts`：

- `id`、`work_id`、`checkpoint_id`、`kind`（team/work/generic）
- `base_dedupe_key`、`dedupe_key`、`idempotency_key`、`attempt_no`
- `status`：starting/running/succeeded/failed/cancelled/blocked
- `risk_level`、`eligibility_status`
- `original_work_status`、`reopen_reason`
- `operator_confirmation_json`、`plan_hash`、`context_manifest_json`
- `execution_id`、`session_id`、`team_run_id`、`node_run_id`（1B-2A 恒 NULL）
- `error_json`、时间戳

约束：

- `UNIQUE(work_id, checkpoint_id, attempt_no)`
- `UNIQUE(work_id, idempotency_key)`
- `UNIQUE(work_id, dedupe_key)`
- 部分唯一索引：同一 Work 最多一个 `starting`/`running` attempt
- 外键全部 `ON DELETE RESTRICT`
- 不修改 `agent_sessions` / `executions` 表结构

---

## 3. Recovery 生命周期与安全

- `work.recovery.plan` 只读：重新调用 `CheckpointService.getRecoveryPlan`，返回 eligibility、risk、limits、context budget、reopen、sections；不创建 attempt/Session。
- `work.recovery.start` 在 Core 内重新验证：
  - Work/Checkpoint 归属、`state='valid'`、content hash、证据、风险；
  - Work 状态；active Execution/Team run；active recovery；
  - 3 次上限；idempotencyKey；
  - `confirm=true`；高风险 `acknowledgeRisk=true`；高风险 + `not_tracked` 仍 blocked，不能绕过。
- T1：插入 `starting` attempt；Team 在同一事务内创建新 queued run；写审计。**Work 重开不在 T1 提交。**
- T2：ContextBuilder 构建恢复 Prompt；失败则 attempt failed/blocked，不创建 Session。
- T3：`ExecutionService.startRecovery` 创建新 Session/Execution，并在同一事务内把 attempt 置 `running`、关联 execution/session/teamRun，并通过 `reopenWork` 回调完成 completed Work 的 `completed → active` 重开。
- T4：Execution 终态更新 attempt；CheckpointService 生成新 Checkpoint。
- 崩溃：
  - `starting` 且无 execution → failed `START_INTERRUPTED`，不自动重试；
  - `running` execution 终态 → 收敛；缺失 → failed；运行中 → 留给 reconciliation；
  - 不自动创建第二份执行。
- 失败不自动重试；每次新 attempt 必须显式请求。

---

## 4. RPC

新增：

- `work.recovery.plan`（read）
- `work.recovery.start`（write）

`start` 参数包含 `workId`、`checkpointId`、`confirm`、可选 `acknowledgeRisk`、`idempotencyKey`、可选 `reopenReason`。客户端 plan 不是授权凭证；start 全部重新计算。

新增业务错误码（协议 `RpcErrorCode`）：

- `RECOVERY_CONFIRMATION_REQUIRED`
- `RECOVERY_RISK_ACK_REQUIRED`
- `RECOVERY_PLAN_BLOCKED`
- `RECOVERY_CHECKPOINT_NOT_FOUND`
- `RECOVERY_WORK_MISMATCH`
- `RECOVERY_WORK_STATUS_INVALID`
- `RECOVERY_REOPEN_REASON_REQUIRED`
- `RECOVERY_ACTIVE_EXISTS`
- `RECOVERY_RETRY_LIMIT_REACHED`
- `RECOVERY_CONTEXT_BUDGET_EXCEEDED`
- `RECOVERY_START_FAILED`
- `RECOVERY_IDEMPOTENCY_CONFLICT`

---

## 5. 三种恢复路径

### Team

- 从 Checkpoint 的 `team_run_id` 恢复原角色/Agent/子任务；无 team run 时使用 Work 团队 Leader。
- 新 `team_task_run` queued，随后新 Execution；TeamCollab 继续处理终态/子任务。
- Member 恢复会校验子任务不是 done，并在启动前置 running；不重复已完成子任务。
- Leader/Member 恢复 Prompt 追加角色契约与 JSON 输出格式。

### Work 最终交付 / 重开

- 只接受 `final_delivery`；`original_work_status=completed`、`reopenReason` 必填。
- 推荐 A 实施：`completed → active` 专用转换，清除 `completedAt`，写 `work.reopened`。
- 旧 final Checkpoint 不变；恢复后产生新 Checkpoint。

### 通用 Work

- active/paused Work；必须有 active Assignment；不自动创建 Assignment。
- 新 Session/Execution；不用于 Workflow NodeRun。

---

## 6. ContextBuilder 恢复 Prompt

- P0：身份/权限、Work 目标与验收标准、恢复来源 Checkpoint、完成/进行中/阻塞/下一步、副作用状态、恢复安全约束。
- P1：当前 Task Memory。
- P2：当前 Work/Team 线程有界消息（仅连续性）。
- P3：Artifact/File 摘要。
- Team Leader/Member 追加角色契约与 JSON 输出格式。
- 固定预算：总 60,000 chars、P0 30,000；P0/总超限 fail-closed，不创建 Session。
- 不保存完整 Prompt；保存 manifest/来源/字节/角色到 attempt。

---

## 7. 正式迁移与运行验证

迁移前：

- DB `user_version=32`，Works=2，Executions=37，无 active Execution
- 备份 ID：`bak-0f913812-b148-4180-8dd5-f5a5a1922840`
- SHA-256：`19d715aa5c610184d933a4bc8bc8b54a908ae1bc6857e613f93579a8b9a765fa`
- 大小：276,996,096 bytes
- 外置副本：`/Volumes/MacExt SSD/AgentraBackups/phase1b2a-pre-v33-20261109-224451`
- 备份 integrity ok；副本逐字节一致

迁移后：

- `user_version=33`
- 应用迁移 `task_recovery_attempts`
- `integrity_check=ok`，外键 0 违规
- Works=2 完整保留
- `task_recovery_attempts=0`、`task_checkpoints=0`、无 active Execution
- 新 Core PID 35787，`core.health=ok`
- `work.list` 返回 2 个旧 Work
- `work.recovery.plan` RPC 可用；旧 Work 无 Checkpoint 时返回 `RECOVERY_CHECKPOINT_NOT_FOUND`
- 启动日志 `fromVersion=33 toVersion=33 applied=[]`，无 error

---

## 8. 测试与门禁

实际执行：

- `pnpm test`：**107 文件 / 953 用例全部通过**
- `pnpm typecheck`：通过
- `pnpm lint`：退出码 0，11 个既有 optional-chain warning，无 error
- `pnpm build`：通过，发布构建检查通过

新增覆盖：

- v32 → v33 迁移、recovery 表约束、active/idempotency/attempt 唯一、外键 RESTRICT。
- plan 只读/blocked/历史 Checkpoint/重开标识/context budget。
- start confirm/risk ack/idempotency replay/active 拒绝/3 次上限。
- 高风险 + not_tracked 无法绕过。
- starting 崩溃 fail-closed；running 终态收敛。
- Team Leader 恢复、新 team run、新 Session。
- completed final_delivery 重开：原状态/原因/attempt/Work 状态。
- ExecutionService 新 Session 创建与 attempt 原子关联；关联失败回滚 Session。
- 普通新执行不被改造成恢复。
- 全量回归。

---

## 9. 五类正式验收风险核对

### 9.1 Recovery Attempt 与 Session / Execution 一致性

- T1 只创建 `starting` attempt（以及 Team queued run）；Work 重开不再在 T1 提交。
- T3 由 `ExecutionService.startRecovery` 在**同一个 Session/Execution 事务**内：
  - 创建新 `agent_sessions` / `executions`；
  - 将 attempt 从 `starting` 置为 `running` 并写入 execution/session/teamRun；
  - 通过 `reopenWork` 回调执行 completed Work 的 `completed → active` 重开。
- 任一步失败 → 事务回滚：Session/Execution/attempt running/Work 重开都不落库；RecoveryService 捕获后把 attempt 标为 `failed`。
- 测试：
  - `rolls back the new Session when recovery attempt linking fails` 验证关联失败时 executions/sessions 均为 0；
  - `does not leave completed Work active when recovery Session creation fails` 验证启动失败后 Work 仍为 completed。
- 进程崩溃：
  - `starting` 且无 execution → startup 对账标记 failed `START_INTERRUPTED`，不自动重试；
  - `running` 且 execution 终态 → 收敛；execution 缺失 → failed；execution 运行中 → 留给 ExecutionService reconciliation。
- 不存在“attempt failed 后仍启动 Agent”的路径：Agent spawn 只在 transaction 成功、attempt 已 running 后发生；spawn 失败会记录 Execution failed，并收敛 attempt failed。

### 9.2 幂等与并发

- DB 级约束：
  - `UNIQUE(work_id, idempotency_key)`；
  - `UNIQUE(work_id, checkpoint_id, attempt_no)`；
  - 部分唯一索引 `WHERE status IN ('starting','running')`，同一 Work 最多一个 active attempt。
- `attempt_no` 在 `BEGIN IMMEDIATE` 事务内按 `MAX(attempt_no)+1` 分配。
- 同一 idempotencyKey 重放返回原 attempt，不重复创建 Session/Execution。
- 不同 key 并发恢复同一 Work：active 唯一索引/应用双重检查阻断。
- `starting` 一旦插入即计入 3 次上限；预检 blocked 不插入，不消耗次数。
- 测试：`enforces the three-attempt recovery limit`、`returns a read-only plan...` 的 idempotent replay、迁移测试中的 active/idempotency/attempt 唯一约束。

### 9.3 completed Work 重开

- 重开与 Session/Execution 创建现在属于同一 T3 事务：创建失败则 Work 保持 completed，不会永久 active。
- `work.reopened` 审计与重开在同一事务内写入；事务回滚时审计也不存在，不重复。
- 如果 Execution 已创建成功但进程 spawn 失败：Work 保持 active，但存在明确的 failed Execution/Attempt 记录，不是无记录“永久停留”；用户可以显式重新恢复或重新完成 Work。
- 测试：`reopens completed Work only with final_delivery and a reason`、`does not leave completed Work active when recovery Session creation fails`。

### 9.4 Team 恢复

- Member 恢复前检查子任务存在且不是 `done`；缺失/done 直接拒绝。
- Member 启动前置子任务为 `running`，避免完成项再次执行。
- Leader Prompt 包含 Checkpoint 的已完成/进行中/阻塞/下一步、恢复限制、成员列表和 JSON 输出契约。
- Member Prompt 包含自己的子任务、相关验收标准、允许的 Task Memory 切片；不读其他成员私有历史。
- Team run 在 T1 创建；启动失败时标记 failed，attempt 同时 failed，不留下孤立 Recovery Attempt。
- 测试：`creates a team recovery run for a team checkpoint`、RecoveryService 的 member 子任务校验与角色 Prompt 路径。

### 9.5 恢复安全

- `high + side_effect_completeness=not_tracked` 在 Core 服务端返回 `RECOVERY_PLAN_BLOCKED`；`acknowledgeRisk=true` 不能绕过。
- `plan` 不是授权凭证；`start` 每次都重新执行 Work/Checkpoint/内容哈希/证据/风险/次数/active/幂等校验。
- 历史 Checkpoint 必须重新计算资格并明确 `isLatest=false`。
- 恢复只构建 ContextBuilder Prompt；不执行 `git reset/checkout/clean`，不覆盖/回滚/删除文件。
- 普通新 Execution 仍走原有 Prompt 组装；只有 `work.recovery.start` 路径使用恢复 Prompt。
- 测试：high-risk blocked、RPC plan/start、上下文预算、普通执行回归、全量测试。

---

## 10. 已知限制

- 未新增恢复 UI；只提供业务级 RPC `plan/start`。
- Phase 1B-2B Workflow NodeRun 恢复未实施；`node_run_id` 预留但 1B-2A 恒 NULL。
- 无 Provider Resume；永远新 Session，无 `resumeSessionId`。
- 无 SideEffect Ledger；高风险 + `not_tracked` 仍 blocked。
- 历史 Checkpoint 允许，但必须重新计算资格；不覆盖/回滚文件。
- completed Work 重开采用推荐 A（`completed → active`），已记录审计。
- 恢复不自动重试；超限/失败需要新的显式请求。

---

## 11. Git 与保护

- 分支 `main`，HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`
- 工作区保留全部既有改动；本次新增/修改集中在 Phase 1B-2A
- 未 commit、未 reset、未 clean、未 checkout、未 stash
- 正式库保持 `user_version=33`；不回滚
- 迁移前备份与外置副本保留
- Phase 1B-2B、Phase 1C/1D 未启动

## 12. 缺陷修复（2026-11-10）

针对 CTO 只读审计发现的三项缺陷，已完成修复并补测试。详细修复审计见
`docs/phase1b2a-defect-fix-report.md`。

1. **T3 提交后、spawn 前崩溃**
   - 新增 `ExecutionService.classifyPendingStart` / `failUnstartedExecution`。
   - 新增 `RecoveryService.reconcileInterruptedStarts`，在 Daemon 连接和 Execution reconcile 之后执行。
   - 确认未启动：Execution failed `START_INTERRUPTED`、Attempt failed、Team run failed、subtask blocked，写 `recovery.crash_reconciled`；不自动 spawn。
   - 已启动或无法确认：分别保留运行/待处理状态，并写明确审计；不误判、不重复 spawn。
2. **Team Member 子任务一致性**
   - 子任务置 running 移入 T3 Session/Execution 事务（`onStarted` 回调）；`updateStatus` false 直接抛错回滚。
   - 并发 done 在事务内重新检查并拒绝。
   - 启动失败/崩溃对账补偿 subtask 到 blocked，写 `recovery.subtask_reconciled`。
3. **Execution 成功但 Checkpoint 失败**
   - CheckpointService 增加结果观察器与 `getCheckpointForExecution`。
   - RecoveryService 不再仅凭 Execution 成功标记 Attempt succeeded；Checkpoint failed 时 Attempt failed，写 `recovery.checkpoint_failed`。
   - Execution 保持 succeeded；Checkpoint 保持 failed；高风险继续被 `assertCanStart` 阻断。

---

## 13. 结论

Phase 1B-2A 已完成代码实施、正式 v33 迁移、缺陷修复与运行验证，等待 CTO 复审。**不进入 Phase 1B-2B，不启动 Phase 1C/1D。**
