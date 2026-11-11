# Phase 1B-2B 实施报告：Workflow NodeRun 恢复

- 日期：2026-11-11
- 状态：**代码实施完成；临时库测试通过；正式库仍为 v33，未迁移、未运行真实恢复**
- 设计依据：`docs/phase1b2b-workflow-noderun-recovery-detailed-design.md`
- 范围：Phase 1B-2B；Phase 1C/1D 未启动

---

## 1. 交付摘要

| 项目 | 结果 |
|---|---|
| 全量测试 | **111 文件 / 969 用例全部通过** |
| 类型检查 | `pnpm typecheck` 通过 |
| Lint | 退出码 0；17 个既有/新增 optional-chain warning，无 error |
| Build | 通过，发布构建检查通过 |
| 正式库 | `user_version=33`（未迁移） |
| 真实恢复 | 未执行 |
| Git | 未 commit/reset/clean/checkout/stash |

---

## 2. 主要实现

### 2.1 v34 数据模型

`apps/core/src/db/migrations.ts`

- 新增 v34 `workflow_node_recovery`（`rebuildsTables: true`）：
  - `task_recovery_attempts` 保留数据重建，`kind` 增加 `workflow_node`；
  - 新增 `workflow_run_id`、`branch_run_id`、`recovered_node_run_id`、`chain_attempt_no`；
  - 链预算唯一索引 `(recovered_node_run_id, chain_attempt_no)`；
  - 活跃链唯一索引 `(recovered_node_run_id) WHERE status IN ('starting','running')`；
  - 非 workflow 行保持旧唯一约束语义（partial unique index）。
- `node_runs(workflow_run_id, workflow_node_key, attempt)` 改为唯一索引。
- `worktrees(work_id, branch_name) WHERE status='active'` 新增唯一索引。
- `workdir_locks` 新增 `holder_started_at`、`holder_kind`。

### 2.2 恢复账本仓储

`apps/core/src/db/repositories/recovery-attempt-repository.ts`

- 扩展 `RecoveryAttemptRecord` 的 workflow 字段。
- 新增：
  - `getByNodeRunId`
  - `getByRecoveredNodeRunId`
  - `countByRecoveredNodeRun`
  - `getActiveByRecoveredNodeRun`
  - `nextChainAttemptNo`
  - `updateWorktreeIntent`（CAS）
  - `updateWorktreeReady`（CAS + owner token）
  - `updateWorktreeDisposition`
  - `markWorkflowRunning`

### 2.3 Workflow NodeRun 恢复服务

`apps/core/src/workflow/node-recovery-service.ts`

- `plan`：目标/分支/Work/Run/Node 类型/Checkpoint/风险/链预算/执行证据/Worktree 策略检查。
- `start`：
  - 幂等重放；
  - T1 创建 `starting` Attempt；
  - T2a 持久化 Worktree 归属意图（owner token、预生成 newNodeRunId、分支、路径）；
  - T2b 创建并验证隔离 Worktree；
  - T3 单事务：旧 attempt `recovery_superseded`、新 attempt、Session、Execution、RecoveryAttempt running、条件 Run 重入；
  - COMMIT 后 spawn；spawn 失败收敛 R failed / B reconciliation_required / Worktree orphaned。
- `convergeAfterT3Failure`：T3 回滚后独立事务收敛 R/Worktree。
- `convergeSpawnFailure`：spawn 失败收敛。
- `reconcileStartup`：启动时处理 Worktree 意图，持久化 orphan/abandoned/manual_review。
- `reconcileRun` / `reconcileAll`：Run 条件重入。

### 2.4 Worktree 隔离与 Git 身份

`apps/core/src/workflow/recovery-worktree.ts`

- realpath + `path.relative` 边界检查。
- `git check-ref-format --branch`；nodeKey slug + hash。
- baseCommit 在目标仓库内校验。
- `git worktree list --porcelain`、worktree 内 `show-toplevel` / `symbolic-ref` / `rev-parse HEAD` 校验。
- 记录 `worktreeId/worktreePath/branchName/baseCommit/gitCommonDir/registeredWorktreePath/ownerToken`。

### 2.5 ExecutionService T3 事务入口

`apps/core/src/services/execution-service.ts`

- 新增 `RecoveryTxContext`。
- `prepareRecoveryForNode(tx, ...)`：只使用 T3 同一连接，创建 Session/Execution，不 spawn、不加锁、不做文件系统操作。
- `spawnPreparedRecovery(executionId)`：COMMIT 后获取 Workdir 锁、spawn、把 holder 转移为 CLI PID。
- `discardPreparedRecovery`：T3 回滚清理内存任务。

### 2.6 执行桥与终态观察

`apps/core/src/workflow/execution-bridge.ts`

- 新增 `recoveryExecution.isRecoveryExecution`。
- 恢复执行失败时禁止 `retryOrFail` 自动创建下一 attempt。
- 新增 `notifyWorkflowNodeTerminal`：
  - 成功、失败、取消、reconciliation_required 都通知恢复账本；
  - 输出契约/Artifact 提交失败也会把 R 收敛为 failed。

`apps/core/src/services/recovery-service.ts`

- `onWorkflowNodeTerminal`。
- `onCheckpointResult` 对 workflow_node 校验 Checkpoint 的 executionId/nodeRunId/workId/state。
- `recoverOnStartup` / `reconcileInterruptedStarts` 对带 Worktree 意图的 R 跳过，交给 Reconciler 先处理。
- `finishAttempt` 终态后通知 Run 收敛协调器。

### 2.7 Workdir 锁

`apps/core/src/services/workdir-lock-service.ts`

- key 使用 realpath（目录不存在时规范化父目录）。
- `holder_started_at` / `holder_kind`。
- `updateHolderPid`：Core → CLI。
- `purgeStale` 顺序固定：
  1. Execution 记录；
  2. Execution 状态；
  3. CLI/Core 存活 + 启动标识；
  4. 无法确认 → 保留 + manual review；
  5. Boot UUID 只作辅助，不再单独回收。
- PID 复用通过启动标识识别。

### 2.8 RPC 与协议

- `packages/protocol/src/methods/workflow-recovery.ts`：
  - `workflow.node.recovery.plan`
  - `workflow.node.recovery.start`
- `packages/protocol/src/index.ts` 导出。
- `apps/core/src/rpc/methods.ts` 注册；plan 只读，start 写。
- `apps/core/src/lifecycle/rpc-policy.ts` 将 plan 加入维护期只读白名单。
- 新增 `NODE_RECOVERY_*` 稳定错误码。

### 2.9 启动编排

`apps/core/src/index.ts`

```text
1. Execution processTerminalBacklog / discardQueued / reconcile
   → WorkdirLockService.purgeStale()
2. WorkflowRecoveryService.recover
3. WorkflowWorktreeRecoveryReconciler（逐条 reconcileStartup）
4. RecoveryService.recoverOnStartup
5. RecoveryService.reconcileInterruptedStarts
6. WorkflowNodeRecoveryService.reconcileAll
7. 开放业务入口（由现有启动流程保证）
```

---

## 3. 测试

新增/更新：

- `apps/core/src/workflow/node-recovery-service.test.ts`：6 项
  - plan eligible；
  - shared/work_root 阻断；
  - start 创建新 NodeRun / R running；
  - T3 失败收敛；
  - 启动 Reconciler orphan；
  - Run 重入条件与 kick。
- `apps/core/src/workflow/recovery-worktree.test.ts`：真实临时 Git 仓库下的 Worktree 创建、预生成 ID、Git 注册校验、重复分支拒绝。
- `apps/core/src/db/workflow-node-recovery-migration.test.ts`：v33 数据保留、v34 列/索引/外键。
- `apps/core/src/services/phase2-workdir.test.ts`：新增 3 项锁回收/CLI holder 测试，并更新旧规则。
- `packages/protocol/src/envelope.test.ts`：错误码数量与新增码。

全量：**111 文件 / 969 用例通过**。

### 3.1 实施后补齐的缺口

- Run 重入后触发 `WorkflowEngine.kick`。
- `reconcileRun` 完整检查活跃恢复、`reconciliation_required`、`waiting_approval`、未确认执行、遗留 pending、全部分支终态。
- 启动 Reconciler 用 `inspectCreation` 区分 Git 已注册（orphaned）/确认不存在（abandoned）/无法确认（manual_review）。
- spawn 前锁获取失败将 pending Execution 收敛为 failed；holder 转移失败时若进程无法确认退出则保留锁并交给对账。
- T3 显式复核 `state='ready'`、`newNodeRunId`、`predictedAttempt=max+1`、ID 未被占用。
- T3 失败收敛异常不再掩盖原始异常。
- Workflow 恢复审计 target 改为 `workflow_run`。
- Workdir 锁增加 `workdir.lock_acquired/released/reclaimed/retained_alive/manual_review/holder_transferred` 审计。
- Worktree ID 由 T2a 预生成并传给 T2b 创建，不再被覆盖。

---

## 4. 正式库与保护状态

- 正式库：`user_version=33`，**未迁移**。
- 迁移前置检查（只读）：
  - `task_recovery_attempts=0`；
  - 重复 `(workflow_run_id, workflow_node_key, attempt)` = 0；
  - 重复 active `worktrees(work_id, branch_name)` = 0。
- **迁移演练（副本）已通过**：
  - 副本 `/tmp/agentra-v34-rehearsal/agentra-before.db`；
  - 33 → 34，`integrity_check=ok`，`foreign_key_check=[]`；
  - Works/Checkpoints/NodeRuns/Worktrees 数量保持不变；
  - 新索引与 `workdir_locks` 新列存在。
- **正式库迁移前备份已生成**：
  - `/Volumes/MacExt SSD/AgentraBackups/phase1b2b-pre-v34-20261111-0935/agentra.db`
  - SHA-256 `1fb155a6ab7eb739d3db6d231db21c660cb8e9a732804e4bdc8b05ef93ea56e9`
  - `integrity_check=ok`，`user_version=33`
- **正式库实际迁移未执行**：执行环境分类器拒绝了直接迁移正式库。开发实例已停止，正式库保持 v33。
- 未执行真实 Workflow NodeRun 恢复。
- Git：工作区保留全部未提交变更；未 commit/reset/clean/checkout/stash。

---

## 5. 尚未完成 / 下一步

1. **正式库 v34 迁移**：备份已就绪；当前执行环境的分类器拒绝直接迁移正式库。备份完成后由用户执行：
   ```bash
   pnpm db:migrate:v34 --yes
   ```
   或允许 Agent 执行该命令。迁移后复查 `foreign_key_check`/行数/索引/触发器。
2. **重启开发实例**：当前已停止；重启新 Core 会自动执行 v34。应在正式迁移完成后重启，避免绕过授权。
3. **RPC 冒烟**：在临时库上启动 Core，调用 plan/start（不运行真实 Agent）。
4. **Desktop 入口**：本阶段按设计不提供 UI；后续如需 UI 单独授权。
4. **控制节点恢复**：仍按设计排除，另案设计。
5. **真实恢复 E2E**：需真实崩溃/Worktree/Agent 环境，单独授权。
