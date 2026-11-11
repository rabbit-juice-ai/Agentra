# Phase 1B-2A CTO 最终只读审计

- 日期：2026-11-10
- 性质：只读补充核对；**未修改代码、数据库、迁移、协议或 Git**
- 正式库：`user_version=33`；Works=2；`task_recovery_attempts=0`；`task_checkpoints=0`；active Execution=0
- Core：PID 74964；`core.health=ok`；`core.log` 无 error
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；未 commit/reset/clean/checkout/stash
- 本次未运行测试、迁移、恢复或真实 Agent/Team Run；结论基于现有代码、测试定义、日志和数据库只读查询
- 本文件是本次审计唯一新增文件

---

## 0. 结论摘要

| 问题 | 结论 | 测试覆盖 |
|---|---|---|
| 1. T3 提交后、Agent spawn 前崩溃 | **FAIL**：可能留下 execution=pending、attempt=running 的永久不一致状态 | **NOT COVERED**（现有测试只覆盖 starting 无 execution） |
| 2. Team Member 子任务与 attempt/run/session/execution 一致性 | **FAIL**：启动失败时 subtask 可能停留在 running；成员恢复路径无测试 | **NOT COVERED**（现有团队恢复测试只覆盖 leader） |
| 3. Execution 成功但 T4 Checkpoint 创建失败 | **FAIL**：execution 状态正确，Checkpoint 失败已记录；但 Recovery Attempt 仍标 succeeded，缺少恢复级失败关联/审计 | **NOT COVERED** |

三项均未发现“重复创建第二份执行”的缺陷；问题集中在校验后的状态收敛与审计一致性。建议先修复/补测，再正式验收 Phase 1B-2A。

---

## 1. 问题一：T3 事务提交成功后、Agent spawn 前进程崩溃

### 1.1 涉及文件、类、方法

| 文件 | 类/方法 | 作用 |
|---|---|---|
| `apps/core/src/services/recovery-service.ts` | `RecoveryService.start`（约 243–537） | T1 attempt/Team run、T3 startRecovery |
| 同上 | `RecoveryService.recoverOnStartup`（601–636） | 启动时收敛 unfinished attempts |
| `apps/core/src/services/execution-service.ts` | `ExecutionService.startRecovery`（450+） | 恢复执行入口 |
| 同上 | `ExecutionService.startInternal`（约 491–737） | T3 创建 Session/Execution、attempt=running、Work reopen |
| 同上 | `ExecutionService.spawnInternal`（749+） | 真正调用 Daemon spawn |
| 同上 | `ExecutionService.reconcile`（1042–1131） | 启动/重连后的 Execution 对账 |
| 同上 | `ExecutionService.discardQueuedOnStartup`（1643–1660） | 只处理 queued execution |
| `apps/core/src/db/repositories/recovery-attempt-repository.ts` | `listUnfinished`（307+） | 读取 starting/running attempts |
| `apps/core/src/index.ts` | 启动顺序（约 799、1145、1166–1187） | RecoveryService 对账、discard、Execution reconcile |

### 1.2 实际状态流转与事务边界

1. `RecoveryService.start` T1 事务：插入 `task_recovery_attempts(status='starting')`，Team 场景插入 queued `team_task_run`；**Work 重开不在 T1 提交**。
2. `ExecutionService.startRecovery` T3 事务：
   - 创建 `agent_sessions`、`executions(status='pending')`；
   - attempt `starting → running`，写入 execution_id/session_id/team_run_id；
   - 通过 `reopenWork` 回调执行 completed Work 重开。
3. T3 提交后，`startInternal` 构造 SpawnJob，并调用 `spawn(job)`。
4. **如果进程在 T3 提交后、`runtime.start` 之前/期间崩溃**：
   - DB 中 execution 仍为 `pending`；
   - attempt 为 `running`；
   - Session 为 `active`；
   - Team run（如有）为 `running` 或 queued；
   - 无 Daemon 进程证据。

### 1.3 重启后的实际收敛

- `RecoveryService.recoverOnStartup`：
  - 对 `running` attempt + `pending` execution：既不进入终态分支，也不进入 `starting` 分支，**什么也不做**。
  - 只有 `starting` 且无 execution 才会被标记 `START_INTERRUPTED`。
- `ExecutionService.discardQueuedOnStartup`：
  - 只处理 `recovery_state_json.queued=1` 的 execution；
  - 非 queued 的 `pending` execution 不会被丢弃。
- `ExecutionService.reconcile`：
  - `pending` 非 queued execution 进入 `runtime.status()`；
  - Daemon 返回 `EXECUTION_NOT_FOUND` → 进入 `unconfirmed`；
  - 按 A3/A6 设计，不把执行判为 crashed，也不改终态。
- `WorkflowRecoveryService.recover`：
  - `unconfirmedExecutionIds` 只用于 NodeRun；
  - 通用 Work 恢复没有 node_run，不会被处理。
- 结果：**execution 永久 pending、attempt 永久 running、Work 保持 active**；没有自动重试（安全），但也没有明确失败/待人工处理状态。

### 1.4 现有测试与覆盖范围

| 测试 | 覆盖 | 缺口 |
|---|---|---|
| `recovery-service.test.ts` → `fails interrupted starting attempts without creating a new execution` | `starting` 且无 execution → failed START_INTERRUPTED | 未覆盖 `running` + `pending execution` |
| `execution-service.test.ts` → `does not mark an execution crashed when the daemon no longer knows it (A3)` | `running` execution 未被 Daemon 识别 → unconfirmed，保持原状态 | 未覆盖 `pending` execution |
| `execution-service.test.ts` → reconcile 相关测试 | confirmed active / observed terminal | 未覆盖恢复路径的 pending 行 |

**测试覆盖：NOT COVERED。**

### 1.5 是否存在状态不一致 / 永久 running

- **是。** T3 提交后崩溃会留下永久 `pending` execution 与 `running` attempt；没有失败标记、没有人工待处理标记。
- 不存在重复执行：没有自动重试或自动 spawn。
- 这是验收级状态一致性缺陷。

### 1.6 最小修复建议（不实施）

- 在 `RecoveryService.recoverOnStartup`（或 Core 启动对账）中增加：
  - 对 `running` attempt + `pending` execution 且 Daemon 无证据的情况，标记 execution failed（`START_INTERRUPTED`/`EXECUTION_NOT_STARTED`）并标记 attempt failed；
  - 对 Team run 同步 finish failed；
  - 写 `recovery.crash_reconciled` 审计；
  - 不自动重试、不自动创建新 Session。
- 或者增加一个只针对 recovery execution 的 boot sweep：先执行 `ExecutionService.reconcile`，把 unconfirmed 的 recovery pending execution 收敛为 failed。
- 新增测试：T3 提交的 pending execution + running attempt，模拟重启对账，断言 execution/attempt/team run 均 failed 且无新 spawn。

---

## 2. 问题二：Team Member 子任务状态与 Recovery Attempt / Team Run / Session / Execution 一致性

### 2.1 涉及文件、类、方法

| 文件 | 类/方法 | 作用 |
|---|---|---|
| `apps/core/src/services/recovery-service.ts` | `RecoveryService.start`（426–444） | Member 恢复：ensure assignment + subtask → running |
| 同上 | `RecoveryService.start` catch（511–536） | 启动失败：attempt failed + team run failed |
| `apps/core/src/db/repositories/collaboration-repository.ts` | `TeamTaskSubtaskRepository.updateStatus`（334+） | 子任务状态迁移 |
| 同上 | `TeamTaskRunRepository.markRunning`（554+）/ `finish`（565+） | Team run 状态 |
| `apps/core/src/services/execution-service.ts` | `ExecutionService.startRecovery` | Session/Execution + attempt 原子关联 |

### 2.2 实际状态流转与事务边界

1. T1 事务：创建 attempt `starting` + team run `queued`。
2. T1 之后、T3 之前，Member 分支在独立事务中：
   - `AssignmentService.ensureWithRoleInTransaction`；
   - `teamSubtasks.updateStatus(subtaskId, ['pending','blocked','review'], 'running')`。
   - **`updateStatus` 的 boolean 返回值被忽略**。
3. T3：创建 Session/Execution，attempt → running；之后 team run → running。
4. 如果 T3 或后续启动失败：
   - catch 将 attempt 标 failed；
   - team run 标 failed；
   - **subtask 没有回滚/补偿，仍停留在 running**。
5. 如果进程在“subtask → running”之后、T3 之前崩溃：
   - attempt 仍是 `starting`；
   - team run `queued`；
   - subtask `running`；
   - 重启时 `recoverOnStartup` 因无 execution 将 attempt failed、team run failed；
   - **subtask 仍 running**。
6. 子任务并发变化时，`updateStatus` 可能返回 false（例如被其他流程改为 done），但代码仍继续启动 Execution，导致“任务未实际 running 但执行已启动”。

### 2.3 现有测试与覆盖范围

| 测试 | 覆盖 | 缺口 |
|---|---|---|
| `recovery-service.test.ts` → `creates a team recovery run for a team checkpoint` | **Leader** 恢复、新 team run、新 Session | 未覆盖 Member 恢复 |
| `recovery-service.test.ts` → 其他 recovery 测试 | Generic / Work | 未覆盖 subtask 状态回滚 |
| `execution-service.test.ts` → recovery Session 创建/关联失败 | Session 回滚 | 不涉及 Team subtask |
| `team-collaboration-service.test.ts` → checkpoint blocked | Team run 阻断 | 不是 Member recovery |

**测试覆盖：NOT COVERED（Member 恢复路径与失败补偿均无测试）。**

### 2.4 是否存在状态不一致 / 重复执行 / 永久 running

- **是。** 启动失败或 T3 前崩溃时，subtask 可以永久停在 `running`，而 attempt/team run 已 failed；Leader 可能因此不再派发该子任务。
- 不会重复创建 Session/Execution（失败路径无 T3 成功）；但 subtask 状态与 attempt/run 不一致。
- `updateStatus` false 被忽略时，存在“未真正置 running 就启动执行”的不一致。

### 2.5 最小修复建议（不实施）

- 检查 `teamSubtasks.updateStatus(...)` 返回值；false 时在创建 Session 前中止，attempt/team run 标 failed/blocked。
- 启动失败/崩溃对账时，将本次恢复启动前状态记录到 attempt（例如 context manifest/额外字段），并补偿 subtask：
  - 首选恢复为 `blocked`（而不是原 running）；
  - 写 `recovery.subtask_reconciled` 审计。
- 更彻底的方案：把 subtask → running 移入 T3 的 Session/Execution 事务，通过类似 `reopenWork` 的 callback 原子提交，失败自动回滚。
- 新增测试：
  - Member 恢复成功：subtask running、attempt running、team run running、execution running；
  - Member 恢复 T3 失败：subtask 不为 running，attempt/run failed；
  - 并发 subtask 已 done：拒绝启动且零 Session/Execution。

---

## 3. 问题三：Execution 终态成功但 T4 Checkpoint 创建失败

### 3.1 涉及文件、类、方法

| 文件 | 类/方法 | 作用 |
|---|---|---|
| `apps/core/src/services/execution-service.ts` | `ExecutionService.processTerminalCompensation`（1260–1325） | 终态后调用 CheckpointService |
| 同上 | `ExecutionService.recordTerminalObservation` | 终态落库 |
| `apps/core/src/services/checkpoint-service.ts` | `CheckpointService.createForExecution` / `recordFailure`（884+） | Checkpoint 失败记录 |
| 同上 | `CheckpointService.assertCanStart`（207+） | 高风险失败阻断新执行 |
| `apps/core/src/services/recovery-service.ts` | `RecoveryService.onExecutionTerminal`（540–568） | 仅按 Execution 终态更新 attempt |

### 3.2 实际状态流转与事务边界

1. Execution 终态 `succeeded` 已通过 `recordTerminalObservation` 落库。
2. `processTerminalCompensation` 调用 `checkpoints.createForExecution(executionId, 'generic')`：
   - 对 Team/Node 执行，专用路径也会创建 Checkpoint；
   - CheckpointService 失败时内部 `recordFailure` 写 `task_checkpoints.state='failed'`、`checkpoint.failed` 审计、`checkpointProcessing` failed；
   - 如果抛出异常，ExecutionService 只 `logger.warn`，随后仍写 `terminalProcessing.state='completed'`。
3. Execution 保持 `succeeded`（正确，不把 Checkpoint 失败伪装成执行失败）。
4. `RecoveryService.onExecutionTerminal` 通过 hub/terminal 事件只读取 Execution status：
   - status=succeeded → attempt `succeeded`；
   - 不查询 Checkpoint 创建结果。
5. 结果：
   - Execution：succeeded（正确）；
   - 新 Checkpoint：failed 行/审计（已记录）；
   - Recovery Attempt：succeeded；
   - 高风险失败 Checkpoint：`assertCanStart` 会阻断后续自动执行；
   - **Recovery Attempt 与 Checkpoint 状态没有关联，也没有 `recovery.checkpoint_failed` 审计。**

### 3.3 现有测试与覆盖范围

| 测试 | 覆盖 | 缺口 |
|---|---|---|
| `execution-service.test.ts` → checkpoint gate tests | 高风险失败阻断启动 | 不覆盖“成功执行 + Checkpoint 失败” |
| `team-collaboration-service.test.ts` → checkpoint blocked | Team queued run 阻断 | 不覆盖 Recovery Attempt 状态 |
| `recovery-service.test.ts` | plan/start/终态 | 未注入 Checkpoint 失败 |

**测试覆盖：NOT COVERED。**

### 3.4 是否存在状态不一致 / 重复执行 / 永久 running

- 无永久 running、无重复执行。
- Execution 状态正确；Checkpoint 失败有独立记录。
- **存在 Recovery Attempt 与 Checkpoint 状态的审计/语义不一致**：attempt 显示 succeeded，但其恢复产出的 Checkpoint 是 failed；对于高风险任务，后续启动会被 `assertCanStart` 阻断，而 attempt 仍显示成功，缺少“恢复成功但 Checkpoint 失败”的明确状态/审计。

### 3.5 最小修复建议（不实施）

- `RecoveryService.onExecutionTerminal` 在 attempt succeeded 前/后查询该 execution 的 Checkpoint 创建结果：
  - 若存在 `checkpointProcessing=failed` 或对应 failed Checkpoint attempt：
    - 增加 `recovery.checkpoint_failed` 审计；
    - 将 Recovery Attempt 标记为 `failed` 或新增明确的 `succeeded_with_checkpoint_failure`/`blocked` 状态（需 CTO 设计决定）；
    - 高风险保持 blocked。
- 或者在 `task_recovery_attempts` 增加 checkpoint 结果关联字段（会增加 v34 迁移，需单独授权）。
- 新增测试：模拟 CheckpointService 失败，断言 Execution 仍 succeeded、Checkpoint failed 审计存在、Recovery Attempt 状态/审计明确、后续高风险启动被阻断。

---

## 4. 只读证据与环境

### 4.1 数据库

```text
PRAGMA user_version = 33
works = 2
task_recovery_attempts = 0
task_checkpoints = 0
active executions = 0
```

本次未执行恢复、未启动真实 Agent/Team Run、未运行迁移、未修改正式库。

### 4.2 日志

- `~/Library/Application Support/agentra/logs/core.log`：当前启动无 `level=error`。
- 没有真实 recovery attempt/checkpoint 运行记录，因此无法从日志验证上述三个故障场景；结论来自代码路径与测试定义。
- 没有为验收而在正式库执行真实恢复。

### 4.3 测试状态

- 本次审计未运行测试或恢复；现有实施报告记录全量 942/942 通过。
- 上述三个问题对应的故障场景均未在现有测试中出现（见各节）。
- 不修改测试、不新增测试；修复后应补相应回归测试。

---

## 5. 最终审计结论

| 项目 | 结论 | 说明 |
|---|---|---|
| 1. T3 提交后/spawn 前崩溃 | **FAIL** | pending execution + running attempt 可永久不一致；测试 NOT COVERED |
| 2. Team Member 子任务一致性 | **FAIL** | subtask 可停留在 running；`updateStatus` false 被忽略；Member 路径无测试 |
| 3. Execution 成功/T4 Checkpoint 失败 | **FAIL** | Execution 状态正确、Checkpoint 失败已记录，但 Recovery Attempt 仍 succeeded，缺少关联/审计；测试 NOT COVERED |

**建议：暂不正式验收 Phase 1B-2A。先按最小修复建议修复问题 1/2/3 并补充对应测试，再提交复审。** 不进入 Phase 1B-2B、1C 或 1D；不修改正式库或 Git。

当前保护基线保持不变：

- 正式库 `user_version=33`，不回滚。
- v33 迁移前备份及外置副本保留。
- Git `main`，HEAD `9a2c60a5...`，工作区 52 modified + 55 untracked（含本审计文件）。
- 未 commit/reset/clean/checkout/stash。
- 不创建恢复 Session、不自动恢复、不调用外部工具执行恢复。
