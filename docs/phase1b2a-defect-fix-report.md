# Phase 1B-2A 缺陷修复审计报告

- 日期：2026-11-10
- 性质：针对 CTO 只读审计三项 FAIL 的修复与回归验证
- 状态：**技术修复复审通过；等待 unconfirmed 处理边界与 Shell 状态确认后正式关闭**
- 范围：仅 Phase 1B-2A；未进入 1B-2B/1C/1D
- 正式库：`user_version=33`（未迁移、未回滚、未执行真实恢复）
- 工作区：未 commit/reset/clean/checkout/stash
- 本文件与更新后的实施报告是本次新增/更新文档

---

## 0. 结论

| 审计问题 | 修复结论 | 新增测试 |
|---|---|---|
| 1. T3 提交后、spawn 前崩溃 | **PASS** | 3 项 |
| 2. Team Member 子任务一致性 | **PASS** | 3 项 |
| 3. Execution 成功但 Checkpoint 失败 | **PASS** | 3 项 |

全部 953 个测试通过；未发现新增的重复执行或自动重发路径。

---

## 1. 修复一：T3 提交后、spawn 前崩溃

### 1.1 修改文件

- `apps/core/src/services/execution-service.ts`
  - `classifyPendingStart(executionId)`：只读判断 `spawned | not_started | unconfirmed`。
  - `failUnstartedExecution(executionId, reason)`：仅在 execution 仍为 pending 且 `processId/startedAt` 均为空时，收敛为 failed。
  - `processTerminalCompensation`：`reason='START_INTERRUPTED'` 时不创建 Checkpoint（从未启动的执行不产生任务事实）。
- `apps/core/src/services/recovery-service.ts`
  - `reconcileInterruptedStarts(daemonAvailable)`：在 Daemon 连接与 Execution reconcile 之后执行。
  - `recoverOnStartup`：终态收敛，pending 留给 reconcile。
  - `finishStartupAttempt` / `compensateMemberSubtask` / `auditStartUnconfirmed`。
- `apps/core/src/index.ts`
  - 在 `executionService.reconcile()` 之后调用 `recoveryService.reconcileInterruptedStarts(true)`。
  - Daemon 不可用分支调用 `reconcileInterruptedStarts(false)`，保留明确待处理状态。

### 1.2 状态流转与事务边界

- T3 提交后 execution=pending、attempt=running、Session=active。
- 启动对账：
  - Execution 已终态 → `finalizeFromTerminal`。
  - Execution 仍 running → 留给 ExecutionService reconciliation。
  - Execution pending：
    - Daemon 不可用 → `recovery.start_unconfirmed` 审计，attempt/execution 保持显式待处理。
    - `classifyPendingStart='spawned'` → 不动，等待 reconcile。
    - `'unconfirmed'` → `recovery.start_unconfirmed` 审计，不误判、不重发。
    - `'not_started'` → `failUnstartedExecution('START_INTERRUPTED')`；attempt failed、Team run failed、subtask blocked，写 `recovery.crash_reconciled`。
- 不创建第二个 Execution；不自动 spawn。
- 从未启动的 recovery execution 不创建 Checkpoint，避免把启动中断伪装成任务事实。

### 1.3 新增测试

- `converges a confirmed-unstarted pending recovery without spawning again`
- `does not misclassify an already-spawned pending execution`
- `keeps an explicit unconfirmed state when start evidence cannot be established`
- ExecutionService：
  - `classifies a pending execution with no daemon evidence and fails it as unstarted`
  - `does not misclassify a pending execution with start evidence as unstarted`

---

## 2. 修复二：Team Member 子任务一致性

### 2.1 修改文件

- `apps/core/src/services/execution-service.ts`
  - `ExecutionStartOptions.recovery.onStarted`：在 Session/Execution 创建事务内执行。
- `apps/core/src/services/recovery-service.ts`
  - Member 恢复不再在 T3 前单独修改 subtask。
  - `onStarted` 内重新检查 subtask 非 done、ensure assignment、`updateStatus` 成功；false 直接抛错，T3 事务回滚。
  - catch 补偿：`running → blocked`，写 `recovery.subtask_reconciled`。
  - 启动/崩溃对账 `compensateMemberSubtask`：Team run 为 member 且 subtask running → blocked，写审计。
- 保留 preflight done 拒绝。

### 2.2 事务边界

- T1：attempt starting + team run queued。
- T3 事务：
  - 创建新 Session/Execution；
  - attempt starting → running；
  - `onStarted` 内 ensure assignment + subtask → running；
  - 任一失败整体回滚。
- T3 成功后进程/启动失败：catch/对账把 subtask 从 running 补偿为 blocked。
- subtask done 在事务内被重新检查并拒绝，不创建 Session/Execution。
- 不会重新执行已完成子任务。

### 2.3 新增测试

- `recovers a Team Member with subtask/attempt/run/execution consistent`
- `does not leave a running subtask when Member recovery fails after start`
- `rejects a Member recovery when the subtask becomes done concurrently`
- 崩溃对账测试与修复一共享：`converges a confirmed-unstarted pending recovery...` 断言 Team run failed、subtask blocked。

---

## 3. 修复三：Execution 成功但 Checkpoint 创建失败

### 3.1 修改文件

- `apps/core/src/db/repositories/checkpoint-repository.ts`
  - `getLatestByExecution(executionId)`。
- `apps/core/src/services/checkpoint-service.ts`
  - `CheckpointCreationEvent`、`onCheckpointResult` 观察器。
  - `getCheckpointForExecution(executionId)`。
  - `createForExecution` 在 valid/existing/failed 时发出结果事件。
- `apps/core/src/services/recovery-service.ts`
  - `onExecutionTerminal`：succeeded 不再直接标记 attempt succeeded，等待 Checkpoint 结果。
  - `onCheckpointResult`：
    - Execution succeeded + Checkpoint valid/existing → attempt succeeded、`recovery.completed`；
    - Execution succeeded + Checkpoint failed → attempt failed、`recovery.checkpoint_failed`；
    - Execution failed/cancelled → 对应终态；
    - skipped → 忽略，等待专用 owner。
  - `recoverOnStartup`/`finalizeFromTerminal`：成功 execution 按最新 Checkpoint 状态收敛；无 Checkpoint → attempt failed `CHECKPOINT_NOT_CREATED`。
- `apps/core/src/index.ts`
  - `recoveryResultSink` 把 Checkpoint 结果转发给 RecoveryService。

### 3.2 状态语义

- Execution：保持 `succeeded`，历史事实不修改。
- Checkpoint：保持 `failed`；`checkpoint.failed` 审计与 failed 行仍存在。
- Recovery Attempt：`failed`；写 `recovery.checkpoint_failed`，包含 executionId、checkpointId、stage、riskLevel、reasonCodes。
- 高风险：`assertCanStart` 继续阻断后续执行。
- 不新增 `succeeded_with_checkpoint_failure` 状态；不自动重试。
- 失败 Checkpoint 不作为有效恢复基线。

### 3.3 新增测试

- `marks recovery succeeded only after a successful Checkpoint result`
- `marks recovery failed when Execution succeeds but Checkpoint creation fails`
- `keeps high-risk checkpoint failure blocking future execution`

---

## 4. 修改文件清单

核心：

- `apps/core/src/db/repositories/checkpoint-repository.ts`
- `apps/core/src/services/checkpoint-service.ts`
- `apps/core/src/services/execution-service.ts`
- `apps/core/src/services/recovery-service.ts`
- `apps/core/src/index.ts`

测试：

- `apps/core/src/services/execution-service.test.ts`
- `apps/core/src/services/recovery-service.test.ts`

文档：

- `docs/phase1b2a-implementation-report.md`（更新）
- `docs/phase1b2a-defect-fix-report.md`（新增）

没有新增迁移、协议、UI、RPC 或表结构变更。

---

## 5. 门禁结果

- `pnpm test`：**107 文件 / 953 用例全部通过**
- `pnpm typecheck`：通过
- `pnpm lint`：退出码 0，11 个既有 optional-chain warning，无 error
- `pnpm build`：通过，发布构建检查通过

---

## 6. 数据库与 Git 保护状态

- 正式库：`user_version=33`
- Works=2
- `task_recovery_attempts=0`
- `task_checkpoints=0`
- active Execution=0
- Core PID 35787，`core.health=ok`，`core.log` 无 error
- 未执行真实 Recovery、未启动真实 Agent/Team Run、未迁移/回滚正式库
- v33 迁移前备份及外置副本保留
- Git `main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`
- 未 commit、未 reset、未 clean、未 checkout、未 stash
- Phase 1B-2B / 1C / 1D 未启动

---

## 7. unconfirmed 状态的人工处理边界

`reconcileInterruptedStarts` 的 `unconfirmed` 是三态分类中的保守分支：Execution 仍为 `pending`，Recovery Attempt 仍为 `running`，并写 `recovery.start_unconfirmed` 审计。该状态是**需要人工介入的异常状态**，不是可自动继续的正常状态。

当前限制：

- **不允许再次启动同一 Work 的恢复**；active Attempt 唯一约束和启动检查继续生效。
- **不允许直接把 Attempt 改为 succeeded**，也不允许直接把 Execution 当作成功。
- **不允许自动 spawn 第二个 Execution**；对账不会重发。
- **不允许用直接改库/改状态字段绕过** active Attempt 或恢复资格。
- **必须先核实 Daemon / Execution 实际状态**，再通过受控流程处理（当前尚未提供 RPC/UI 或受控 CLI；不得以手工 SQL 作为正式流程）。
- 在受控处理能力建立前，**保持阻断**，不允许绕过 active Attempt 唯一约束。
- 审计保留 `recovery.start_unconfirmed`、Recovery Attempt/Execution 的原始状态和原因，供人工核实。

未来受控处理的方向（本阶段不实施）：

- 核实确认“从未启动”：将 Execution/Attempt/Team Run 收敛为 failed（`START_INTERRUPTED`），subtask 补偿为 blocked，写审计。
- 核实确认“已启动或可能已启动”：按 Daemon/Execution 实际终态收敛；不得重复执行或重复副作用。
- 任何解除都必须经过受控 Core 流程和审计；本阶段不新增相关 RPC/UI。

---

## 8. Shell 与运行进程核对

本次检查到的“1 个 shell”是此前启动的 Agentra 开发运行实例，不是测试、迁移或恢复命令：

- `electron-vite dev` 父进程及 Electron 主进程；
- Core PID 35787（`apps/core/dist/index.js`）；
- Daemon PID 35789（`apps/daemon/dist/index.js`）。

检查结果：

- 未发现 `vitest`、`tsx`、`pnpm test`、迁移脚本或真实 Recovery/Agent 启动进程。
- 正式库仍为 `user_version=33`；`task_recovery_attempts=0`、`task_checkpoints=0`、active Execution=0。
- `core.log` 无 error。
- 该实例是当前开发应用本身；本轮只读核对未让它执行测试、迁移或真实 Agent/Team Run。未停止该应用，因为 CTO 只要求确认 Shell 状态，未要求关闭运行实例。
- 如果 CTO 希望释放该开发实例，可另行指示停止；本报告未执行停止、重启或迁移。

---

## 9. 复审请求

三项缺陷已修复并补测试，技术修复复审通过。等待 CTO 确认 unconfirmed 人工处理边界与 Shell 状态后，正式关闭 Phase 1B-2A；复审通过前不进入 Phase 1B-2B，不启动 Phase 1C/1D。
