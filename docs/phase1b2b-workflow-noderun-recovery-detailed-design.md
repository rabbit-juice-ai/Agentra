# Phase 1B-2B 详细设计：Workflow NodeRun 恢复

- 状态：**设计复核中（2026-11-10 修订稿）；未授权代码实施、v34 迁移或真实恢复**
- 前置：Phase 1B-2A 已于 2026-11-10 正式验收通过并关闭
- 基线：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；正式库 `user_version=33`
- 上游依据：
  - `docs/phase1b2-session-recovery-design-gate.md`（D-3、D-9）
  - `docs/phase1b2a-session-recovery-detailed-design.md`（第 13 节 1B-2A / 1B-2B 隔离）
  - `docs/phase1b2a-implementation-report.md`
  - `docs/phase1b2a-defect-fix-report.md`
- 范围：仅 Phase 1B-2B 设计；Phase 1C SessionLifecycle、Phase 1D SideEffect Ledger 未启动
- 保护：不修改 `agent_sessions` / `executions` 表结构；不执行迁移；不启动真实 Recovery/Agent/Team Run；不 commit/reset/clean/checkout/stash

---

## 0. 设计结论摘要

本设计只回答 CTO 指定的七个问题。核心立场：**不在 Workflow 层再造一套恢复引擎**。1B-2A 的 `RecoveryService` 继续作为唯一恢复引擎；1B-2B 只新增一个 Workflow 目标适配器、一个 Run 收敛协调器，以及最小限度的表字段扩展。

| # | CTO 问题 | 设计结论 | 章节 |
|---|---|---|---|
| 1 | 新 Attempt 与旧 NodeRun 的关系 | 新 attempt = `max(attempt)+1`；旧 attempt 保持历史事实，启动恢复时从 `reconciliation_required` 显式收敛为 `failed(recovery_superseded)`；旧 attempt 永不被改为 `succeeded` | §4、§7 |
| 2 | Workflow Run / Branch / NodeRun 恢复状态机 | 不新增状态值。Node 复用 `reconciliation_required`；Run 仅允许 `reconciliation_required → running` 的条件重入；Branch 不因恢复被改写 | §4、§9 |
| 3 | 新 Attempt 与 Session / Execution 的关联 | T3 同一事务内：新 NodeRun attempt(`running`) + 新 Session + 新 Execution(`pending`, 绑定该 attempt) + 恢复 Attempt(`running`)；`executions.node_run_id` 唯一索引保证 1:1 | §7 |
| 4 | Scheduler 如何避免重复调度 / 重复副作用 | 新 attempt 从未以 `ready` 提交，Scheduler 不会看到它；执行由恢复事务直接创建。Scheduler 代码零改动，靠状态约束 + 唯一索引 + CAS 提供保护 | §8 |
| 5 | 分支级暂停、失败、恢复的收敛 | 恢复只允许在 `active` 分支上进行；从不自动恢复暂停分支；恢复失败不改写分支状态，不做自动分支失败级联；Run 重入有明确条件 | §9 |
| 6 | 崩溃对账与幂等约束 | 完全复用 1B-2A 的 `starting` 意图、`classifyPendingStart`、`reconcileInterruptedStarts`；新增 NodeRun 补偿；链级预算 3 次 + 唯一约束 + 幂等键 | §7、§13 |
| 7 | 如何复用 1B-2A RecoveryService | 单一引擎、单一账本（`task_recovery_attempts` 扩展）、单一 Checkpoint 资格与 ContextBuilder；Workflow 只做目标解析、NodeRun 创建与补偿 | §3、§12 |

**需要 CTO 决策的事项集中在 §16。在 CTO 明确批准前不得实施，尤其不得执行 v34 迁移。**

### 0.1 CTO 评审状态（2026-11-10）

| 决策 | CTO 结论 | 本修订稿落实 |
|---|---|---|
| D-1 | 有条件通过 | §6.1 / §6.5 / §6.6：保留数据迁移、完整字段/触发器/索引/外键重建、失败回滚、外部备份、真实结构迁移测试 |
| D-2 | 通过 | §5.2 / §5.3：只允许 `agent_task`，Node 类型在 plan 与 start 双重校验 |
| D-3 | 通过 | §4.3 / §7.4：`failed(recovery_superseded)`，旧 attempt 永不改 succeeded，旧输出不作交付物 |
| D-4 | 通过 | §13.1：`BEGIN IMMEDIATE` + 部分唯一索引 + CAS，跨进程只允许一个恢复成功 |
| D-5 | 通过 | §9.2 / §9.2.1：六项条件 + 重入后调度幂等边界 |
| D-6 | 通过 | §13.2.1：稳定 chain identity；预算按链累计；跨 Run 全局唯一；编号分离 |
| D-7 | 通过 | §9.1 / §9.4：恢复适配器不改写 Branch 状态 |
| D-8 | 通过 | §1.2 / §5.2：控制节点不得进入 agent_task 恢复接口 |
| D-9 | 主体通过，启动对账缺口待闭合 | §7.2 / §7.3 / §7.4 / §7.7 / §8.6 / §13.2.2：真实路径/Git 身份/owner token 通过；Worktree Reconciler 必须先于通用终态收敛 |
| D-10 | 通过 | §10：RPC 权限、服务端重算、确认/风险确认、幂等、稳定错误码；不暴露 Session 管理接口 |

### 0.2 实施前必须锁定的 P0 安全不变量

以下十五项进入正式设计约束，任何实现批次不得绕过：

1. **先确认旧执行已停止或确定未启动，才能 supersede。** `reconciliation_required` 本身不等于底层 Agent 进程已停止。若无法确认旧进程状态，必须阻止新 attempt 启动，不能让两个 Agent 同时操作同一业务目标。
2. **T3 必须原子化。** 旧 attempt 收敛、新 NodeRun attempt、Session、Execution、RecoveryAttempt 的关联不得出现部分提交。
3. **Scheduler 不得看到半成品。** 新 attempt 不得以已提交的 `ready` 状态暴露给 Scheduler；唯一索引与 CAS 是数据库级防线，不是服务层约定。
4. **恢复失败不得伪造成功。** Execution、NodeRun、Checkpoint、RecoveryAttempt 四者的终态含义分开定义，不能互相替代。
5. **新 Worktree 不代表自动交付。** 新 attempt 的输出必须经过原有节点输出契约、Artifact 提交和 Workflow 终态验证。
6. **恢复账本不能被客户端计划授权。** `plan` 只是预览；`start` 必须重新验证 Work、Run、Branch、NodeRun、旧执行状态、Checkpoint、风险、预算和幂等键。
7. **Run 重入后的 Scheduler 必须幂等。** `engine.kick` 只能处理原有状态机中具备执行资格的节点；不得因 Run 重入而新建 NodeRun attempt、Session、Execution、Artifact 或重复触发副作用；无法确认状态一致时必须维持阻塞。
8. **Checkpoint 成功证明必须归属本次恢复。** 只有与本次 Execution、新 NodeRun B、当前 RecoveryAttempt 关联且 `valid` 的 Checkpoint 才能证明恢复成功；旧 attempt 的 Checkpoint 不得复用。
9. **Worktree 必须通过真实路径与 Git 身份校验。** `realpath` 边界、Git ref 合法性、baseCommit 属于目标仓库、Git 注册信息与数据库一致；一个 Worktree 只能属于一个 recoveryAttemptId 与预测 newNodeRunId。
10. **Checkpoint 时间戳只是辅助判据。** 归属以 executionId、nodeRunId、workId、RecoveryAttempt 关联与 content_hash 为主；时间戳不得覆盖归属冲突。
11. **启动对账顺序不得倒置。** Worktree Reconciler 必须先处理 workflow_node 的 T2a/T2b 意图并持久化 orphan/abandoned/manual_review；`recoverOnStartup()` 必须硬编码跳过带 Worktree 意图的 R。
12. **T3 必须使用统一事务上下文。** `startRecoveryForNode` 接收并使用 T3 的同一连接；不得自行开事务/提交；T3 内禁止 spawn、git、fs、网络。
13. **Workdir 锁必须有明确持有者与生命周期。** 归属 `WorkdirLockService`；key 为 realpath；spawn 后 holder 更新为 CLI PID + 启动标识；Core 死/CLI 活时保留；释放幂等且只释放自己的锁。
14. **purgeStale 不得因 Boot UUID 变化直接回收。** 必须先查 Execution 状态与 CLI 进程身份；CLI 仍存活或无法确认时保留锁，必要时进入 manual_review。
15. **T3 回滚后必须即时收敛。** 数据库可写时用独立事务将 R 收敛 failed 并处置 Worktree；独立事务失败才保留 starting 交给启动对账；R 未终态前不得被新恢复认领。

**当前评审状态：设计复核中，尚未最终验收，尚未授权实施。** D-2/D-3/D-4/D-5/D-6/D-7/D-8/D-10 通过；D-1 有条件通过；D-9 主体通过但启动对账缺口已在本稿闭合。第四轮新增的启动对账顺序、T3 统一事务上下文、Workdir 锁契约已补入 §7.2/§7.4.1/§7.5.1/§7.7。Phase 1B-2B 代码、v34 迁移、RPC 实现、真实恢复均未授权；Phase 1C、1D 继续暂停。

---

## 1. 范围与非目标

### 1.1 本阶段范围

1. `agent_task` 类型 NodeRun 的显式恢复：
   - 因崩溃、Daemon 不可用、执行不可确认而被标记 `reconciliation_required` 的节点；
   - 恢复后创建新的 NodeRun attempt、新 Session、新 Execution；
   - **仅限 `workingDirectoryPolicy='worktree'` 的节点**（D-9 强制隔离 Worktree）。
2. 恢复资格、风险、预算、ContextBuilder 组装与 Checkpoint 复用。
3. `workflow.node.recovery.plan` / `workflow.node.recovery.start` 两个业务 RPC（只做设计，不实施）。
4. Workflow Run 从 `reconciliation_required` 到 `running` 的条件重入。
5. 崩溃对账、幂等、并发与审计。
6. v34 最小数据模型扩展（仅恢复账本与 NodeRun 唯一索引）。

### 1.2 明确非目标

- 不自动恢复、不在后台自动继续、不自动重试。
- 不恢复控制节点：`start` / `parallel_split` / `join` / `condition` / `human_approval` / `end`（依据 D-9；控制节点对账另案设计）。
- 不恢复普通 `failed` 节点；普通失败继续由现有 `retryPolicy` 与 ReworkPolicy 处理。唯一例外见 §5.2 的“恢复链内失败 attempt”。
- 不恢复共享工作目录或无 repository 的节点；不允许降级复用旧 Worktree。
- 不复用旧 Session、不复用旧 Execution、不引入 Provider Resume / `resumeSessionId`。
- 不修改 Workflow Scheduler、`WorkflowExecutionBridge` 的既有状态语义、`WorkflowRunService`、`WorkflowEngine` 的节点分发。
- 不修改 `agent_sessions` / `executions` 列结构。
- 不引入 SessionLifecycleManager、压缩阈值（1C）。
- 不引入 SideEffect Ledger、自动副作用对账（1D）。
- 不提供 UI 入口；本阶段只定义 RPC 契约。
- 不恢复审批、不改写审批决策，不绕过人工门禁。
- 不对暂停分支做自动恢复，也不把恢复实现为画布循环或 Retry 节点。

---

## 2. 当前代码基线（设计依据）

### 2.1 已存在的机制

| 机制 | 位置 | 事实 |
|---|---|---|
| NodeRun 每 attempt 一行 | `db/repositories/node-run-repository.ts` | `attempt` 从 1 开始；`transition` 做“状态机对照 + CAS”；`fail` 要求结构化 `NodeFailure` |
| 最新 attempt 选择 | `workflow/scheduler.ts`、`workflow/recovery-service.ts`、`control-nodes.ts` | 均按 `attempt` 取最大；下游只读最新 attempt |
| 派发 | `workflow/scheduler.ts` | 只把 `ready` CAS 到 `running`，再调用 `onNodeStarted`；没有恢复概念 |
| 执行桥 | `workflow/execution-bridge.ts` | `startForNode` 创建执行；终态回写节点；失败时 `retryOrFail` 原子地创建 `attempt+1` 的 `ready` 行 |
| 启动恢复 | `workflow/recovery-service.ts` | 运行中节点有非终态执行且 Daemon 不可用/证据不可确认 → `reconciliation_required`；无执行 → 先尝试终态补记账，再标 `reconciliation_required`；**从不重跑** |
| Checkpoint | `services/checkpoint-service.ts` | 每个终态 Execution 可产生一条 `task_checkpoints`，带 `node_run_id`；失败为 `state='failed'`；高风险失败阻断后续 |
| 1B-2A 恢复引擎 | `services/recovery-service.ts` | `plan/start`、Checkpoint 资格、风险确认、链式预算、新 Session/Execution、启动意图、崩溃对账、Checkpoint 结果观察器 |
| 恢复账本 | `task_recovery_attempts`（v33） | `kind IN ('team','work','generic')`；`node_run_id` 预留且 1B-2A 恒为 NULL；每个 Work 至多一个 `starting/running` |
| 一致性约束 | `workflow/consistency.ts` | 运行中节点必须恰有一条非终态 Execution；终态节点不得有非终态 Execution；`(run,key,attempt)` 不得重复；终态 Run 不得有非终态节点 |

### 2.2 当前缺口

1. 被标记 `reconciliation_required` 的节点没有任何显式恢复入口，也没有新 attempt。
2. 普通 `retryOrFail` 会在执行失败时自动创建下一 attempt；如果直接拿它当“恢复”，会绕过人工确认、风险确认和预算，必须避免。
3. Run 进入 `reconciliation_required` 后没有回到 `running` 的路径，即使节点已被处理也会永久停住。
4. `executions.node_run_id` 唯一索引已存在，可直接作为“一个 NodeRun attempt 至多一条 Execution”的硬约束。
5. `node_runs` 的 `(run,key,attempt)` 目前只有普通索引，重复 attempt 只能靠一致性检查事后发现；1B-2B 需要数据库级唯一约束。

---

## 3. 核心架构：一个引擎，一个账本，一个适配器

```text
workflow.node.recovery.plan
  → RecoveryService.planWorkflowNode
      → WorkflowNodeRecoveryAdapter.inspectTarget
          - NodeRun / Run / Branch / Definition 校验
          - 执行证据分类（not_started | terminal | active | unconfirmed）
          - 目标 Checkpoint 选择
      → CheckpointService.getRecoveryPlan / assertCanStart   （复用 1B-2A）
      → ContextBuilder.buildRecoveryPrompt                    （复用 1B-2A）
      → 返回 eligibility / limits / nextAttempt

workflow.node.recovery.start
  → RecoveryService.startWorkflowNode
      → T1: task_recovery_attempts(starting, kind=workflow_node)
      → T2: 重新计算资格 + ContextBuilder + Assignment 解析
      → T3（单一事务）:
          WorkflowNodeRecoveryAdapter.prepareAttempt
            - 旧 attempt: reconciliation_required → failed(recovery_superseded)
            - 新 attempt: max+1, blocked? ready → running
            - 分支 / Run 前置校验
          ExecutionService.startRecoveryForNode
            - 新 Session + 新 Execution(pending, node_run_id=新 attempt)
          - 恢复 Attempt: starting → running
      → COMMIT 后 spawn
      → 返回 recoveryAttemptId / newNodeRunId / executionId / sessionId

Execution 终态
  → ExecutionService 现有终态观察器
  → WorkflowExecutionBridge 回写新 attempt
  → CheckpointService.createForExecution
  → RecoveryService.onExecutionTerminal / onCheckpointResult   （复用 1B-2A）

恢复 Attempt 终态后
  → WorkflowRunRecoveryCoordinator.reconcileRun(runId)
      - 条件满足时 reconciliation_required → running
      - 触发 engine.kick
```

### 3.1 职责边界

| 组件 | 职责 | 不负责 |
|---|---|---|
| `RecoveryService` | 唯一恢复引擎：资格、风险、预算、Checkpoint、Context、新 Session/Execution、恢复 Attempt 状态机、启动对账 | 不理解 Workflow 图、不写 NodeRun 业务状态 |
| `WorkflowNodeRecoveryAdapter`（新增，薄） | 目标解析、旧 attempt 收敛、新 attempt 创建、分支/Run 前置校验、崩溃补偿 | 不自己发 RPC、不自己建恢复账本、不自己构建 Prompt |
| `WorkflowRunRecoveryCoordinator`（新增，薄） | Run 级重入与收敛、触发 kick、审计 | 不直接派发节点、不改 Scheduler |
| `WorkflowScheduler` | 既有 `blocked→ready→running` 派发 | **零改动** |
| `WorkflowExecutionBridge` | 既有终态回写 | 仅新增一个只读查询接缝：判断“该 Execution 是否属于恢复”，用于禁止自动 retry |
| `ExecutionService` | 新 Session/Execution 创建与进程启动 | 不决定恢复资格 |

### 3.2 为什么不新建 `workflow_node_recovery_attempts`

- 1B-2A 已经定义了恢复 Attempt 的状态机、幂等键、风险与审计、启动意图与崩溃对账。
- 新表会复制状态机与预算逻辑，形成第二套恢复引擎，违反 CTO 的第七条要求。
- `task_recovery_attempts` 已预留 `node_run_id`，1B-2A 恒为 NULL；1B-2B 显式增加 `recovered_node_run_id` / `workflow_run_id` / `chain_attempt_no` 并定义语义，不是复用旧语义绕过。
- 代价是需要一次最小表重建（v34）；正式库当前 `task_recovery_attempts` 为 0 行，但迁移仍按通用数据保全方式编写。

### 3.3 与 1B-2A 的接口隔离

- `work.recovery.plan` / `work.recovery.start` 的参数、返回结构与错误码**不变**。
- 1B-2A 的 `kind='team' | 'work' | 'generic'` 行语义不变；v34 只增加 `workflow_node` 分支字段。
- `agent_sessions` / `executions` 列结构不变。
- 1B-2A 全部既有测试必须保持通过；新增行为只在 `kind='workflow_node'` 分支生效。
- 不把 Workflow 恢复伪装成 generic recovery，也不复用 `node_run_id` 的旧语义；`node_run_id` 在 workflow 行明确为新 attempt，旧 attempt 使用新列 `recovered_node_run_id`。

### 3.4 恢复执行与普通执行的桥接差异

| 行为 | 普通节点执行 | 恢复执行 |
|---|---|---|
| 启动入口 | Scheduler → `onNodeStarted` → `startForNode` | `RecoveryService` T3 → `startRecoveryForNode` |
| NodeRun 创建 | Run 创建时预建 `blocked`，后由 Scheduler 推进 | T3 内新建 attempt 并直接 `running` |
| 失败重试 | `retryOrFail` 自动创建下一 attempt | 禁止自动 retry；由链预算与显式恢复决定 |
| 终态回写 | `WorkflowExecutionBridge.onExecutionFinished` | 同一入口（行为一致） |
| Checkpoint | `createForExecution(execution.id, 'node')` | 同一入口（行为一致） |
| 任务事件 | 群聊 started/succeeded/failed | 同一入口（行为一致） |

---

## 4. 实体与状态模型

### 4.1 术语

| 术语 | 含义 |
|---|---|
| **目标节点** | 需要恢复的 `workflow_node_key` |
| **旧 attempt A** | 触发恢复的 NodeRun attempt；通常处于 `reconciliation_required`；也可能是恢复链中已失败的 attempt |
| **恢复链 chain** | 以最初的目标 NodeRun ID 为标识的一组恢复尝试；`recovered_node_run_id = A0.id` |
| **恢复 Attempt R** | `task_recovery_attempts` 中的一行，`kind='workflow_node'` |
| **新 attempt B** | `node_runs` 中 `attempt = max+1` 的一行，绑定新 Execution |
| **恢复执行 E** | `executions` 中绑定 B 的一行；新 Session |

### 4.2 不新增状态值

- NodeRun：复用 `reconciliation_required`。状态机已有 `reconciliation_required → failed / cancelled / ready / succeeded`，足以表达旧 attempt 收敛与新 attempt 启动。
- WorkflowRun：复用 `reconciliation_required`。状态机已有 `reconciliation_required → running / failed / cancelled`。
- BranchRun：不新增、不因恢复改写。
- 恢复 Attempt：完全复用 1B-2A 的 `starting / running / succeeded / failed / cancelled / blocked`。

### 4.3 NodeRun 状态流转

```text
旧 attempt A（正常恢复入口）
  reconciliation_required ──T3──> failed (category=recovery_superseded)
  说明：A 的 ended_at 由 nodes.fail() 写入；A 的 error_json 记录 supersededByNodeRunId / recoveryAttemptId。
  若 T3 回滚，A 保持 reconciliation_required，可再次恢复。

旧 attempt A（恢复链内再次恢复）
  failed（终态，不再迁移）
  说明：failed 无出边；不伪造成功，也不改写历史。

新 attempt B
  T3 内 create(status='ready') ──CAS──> running
  说明：B 从未以 ready 提交到事务外，Scheduler 不可见；CAS 失败则整个 T3 回滚。
  running ──> succeeded | failed | cancelled | reconciliation_required
  reconciliation_required 的产生：
    - 新执行崩溃 / 证据不可确认（复用 WorkflowRecoveryService）
    - 启动后、spawn 前崩溃且确认未启动：B 保持可恢复，进入 reconciliation_required
```

### 4.4 恢复 Attempt 状态流转

与 1B-2A 完全一致：

```text
starting ──T3 成功──> running ──执行成功 + Checkpoint 有效──> succeeded
   │                     ├──执行失败/取消/启动中断──> failed
   │                     └──Work/Run 取消且执行取消──> cancelled
   └──T1 后崩溃、未进入 T3──> failed (RECOVERY_START_INTERRUPTED，启动对账收敛)
blocked 仅用于 plan 视图语义；不落库为恢复尝试
```

### 4.5 关键不变量

1. 一个 NodeRun attempt 至多一条 Execution（现有唯一索引）。
2. 一个恢复链最多 3 次恢复尝试（服务 + 唯一索引双重约束）。
3. 一个 Work 同时至多一个 `starting/running` 的恢复尝试（沿用 1B-2A）。
4. 同一恢复链同时至多一个 `starting/running` 恢复尝试（新增部分唯一索引）。
5. 旧 attempt 永不被改为 `succeeded`。
6. 恢复执行失败不得触发 `retryOrFail` 自动创建下一 attempt。
7. Run 只有满足重入条件才可从 `reconciliation_required` 回到 `running`。
8. 恢复执行必须使用 T2 新建并通过 T3 归属校验的隔离 Worktree；`worktreeId` 不可选。
9. 恢复成功必须由绑定本次 Execution、NodeRun B、RecoveryAttempt 的 valid Checkpoint 证明。
10. Run 重入后的 Scheduler 不得新建 NodeRun/Session/Execution/Artifact，不得重复副作用。
11. 恢复链身份跨 Workflow Run 全局唯一，预算不可通过更换 Run 重置。

---

## 5. 目标选择与恢复资格

### 5.1 目标输入

`plan` / `start` 均以 `(workflowRunId, nodeRunId)` 定位目标：

- `nodeRunId` 必须是该 Run 内该节点 **最新** attempt；否则 `NODE_RECOVERY_TARGET_NOT_LATEST`。
- 不接受仅用 `nodeKey` 定位，避免并发或重试后指向错误 attempt。

### 5.2 可恢复状态

| 最新 attempt 状态 | 是否可恢复 | 条件 |
|---|---|---|
| `reconciliation_required` | 是 | 主路径；且满足 §5.3 全部检查 |
| `failed` | 条件式（决策 D-6） | 仅当该 attempt 是由恢复创建（存在 `task_recovery_attempts.node_run_id = B.id` 且 `kind='workflow_node'`），且其恢复 Attempt 已 `failed`，且链预算未耗尽 |
| `running` | 否 | 有活跃执行或对账未完成；先由既有对账收敛 |
| `ready` / `blocked` | 否 | 尚未执行，恢复无意义；由 Scheduler 正常派发 |
| `waiting_approval` | 否 | 人工门禁未通过；不得绕过 |
| `paused` | 否 | 分支暂停语义；先恢复分支 |
| `succeeded` / `cancelled` / `skipped` | 否 | 终态，不得重开 |

普通 `failed` 节点不在本阶段恢复范围；它们继续走 `retryPolicy` / ReworkPolicy。

### 5.3 资格检查清单

按下表顺序检查；任一失败即 `eligibility.status='blocked'`，`plan` 返回原因码，`start` 拒绝且不写任何行。

| # | 检查 | 失败原因码 |
|---|---|---|
| 1 | Run 存在，状态 ∈ `running` / `reconciliation_required` | `NODE_RECOVERY_RUN_STATE_INVALID` |
| 2 | Work 存在且 `status='active'` | `NODE_RECOVERY_WORK_STATE_INVALID` |
| 3 | 目标是最新 attempt | `NODE_RECOVERY_TARGET_NOT_LATEST` |
| 4 | 目标状态符合 §5.2 | `NODE_RECOVERY_TARGET_NOT_RECOVERABLE` |
| 5 | 节点定义类型为 `agent_task` | `NODE_RECOVERY_NODE_TYPE_UNSUPPORTED` |
| 6 | 节点归属分支存在且 `active` | `NODE_RECOVERY_BRANCH_NOT_ACTIVE` |
| 7 | 目标节点没有 `pending/running` Execution | `NODE_RECOVERY_EXECUTION_ACTIVE` |
| 8 | 执行证据已确认（非 unconfirmed） | `NODE_RECOVERY_EXECUTION_UNCONFIRMED` |
| 9 | Daemon 可用（`start` 必需；`plan` 可仅报告） | `NODE_RECOVERY_DAEMON_UNAVAILABLE` |
| 10 | 目标 Checkpoint 可按 §5.4 解析 | `NODE_RECOVERY_CHECKPOINT_NOT_FOUND` / `NODE_RECOVERY_CHECKPOINT_INVALID` |
| 11 | `CheckpointService.getRecoveryPlan` 非 blocked | 透传 reasonCodes（如 `CHECKPOINT_HASH_MISMATCH`） |
| 12 | `assertCanStart` 通过（高风险失败阻断） | `RECOVERY_REQUIRED` |
| 13 | 链预算 < 3 | `NODE_RECOVERY_LIMIT_REACHED` |
| 14 | 当前 Work 无其他 `starting/running` 恢复 | `NODE_RECOVERY_ACTIVE_EXISTS` |
| 15 | Assignment 可解析且 Agent 有效 | `NODE_RECOVERY_ASSIGNMENT_UNRESOLVED` |
| 16 | 新 attempt 编号可安全分配（`max+1`，无唯一冲突） | `NODE_RECOVERY_ATTEMPT_CONFLICT` |
| 17 | 节点 `workingDirectoryPolicy='worktree'`，且 Work 有可用 `repository_path` | `NODE_RECOVERY_WORKTREE_REQUIRED` |
| 18 | 可生成唯一的新恢复 Worktree 分支名（含 run / nodeKey / newAttempt / chainAttemptNo） | `NODE_RECOVERY_WORKTREE_CONFLICT` |

> 与 1B-2A 的差异：**不使用“Work 内存在任意活跃 Execution 就阻断”的检查**。Workflow 的正常形态就是并行分支各有一个活跃 Execution；1B-2B 只阻断目标节点自身的活跃执行，避免误伤并行分支。`assertCanStart` 的 Work 级高风险阻断仍然保留。

> **D-9 的范围影响**：1B-2B 只恢复 `workingDirectoryPolicy='worktree'` 的节点。使用共享工作目录的节点在本阶段不可恢复（`NODE_RECOVERY_WORKTREE_REQUIRED`），**不允许降级复用共享目录或旧 Worktree**。这是安全边界，不是实现遗漏。

### 5.4 Checkpoint 选择规则

1. 若调用方显式提供 `checkpointId`：必须属于同一 Work，且创建时间不晚于目标 attempt 的 `startedAt`（为空则 `createdAt`）；否则 `NODE_RECOVERY_CHECKPOINT_INVALID`。
2. 否则优先选择 `node_run_id = A.id` 的最新 `valid` Checkpoint。
3. 否则选择同一 Work 中 `created_at <= A.startedAt/createdAt` 的最新 `valid` Checkpoint。
4. 仍无 → `NODE_RECOVERY_CHECKPOINT_NOT_FOUND`，不进行恢复。

Checkpoint 是 Work 级事实快照，可能来自并行分支；因此 Prompt 必须额外包含 Workflow 节点上下文（§11），不得只依赖 Checkpoint。

### 5.5 执行证据分类

复用 1B-2A 的三态分类，不新增判据：

| 证据 | 判定 | 处理 |
|---|---|---|
| 目标 Execution 为 `succeeded/failed/cancelled/crashed`，且 Daemon 无该进程 | `terminal` | 允许恢复 |
| Execution 为 `pending`，且确认从未 spawn | `not_started` | 允许恢复（但正常情况下应先由 1B-2A 对账收敛） |
| Execution 为 `pending/running`，Daemon 明确无记录 | `unconfirmed` | **阻断**；保持人工处理边界，不重复执行、不伪造成功 |
| Execution 为 `pending/running`，Daemon 确认进程仍活 | `active` | 阻断，等待终态 |

**注意**：`reconciliation_required` 只是 NodeRun 状态，**不等于**底层 Agent 进程已停止。`start` 必须在 T1 与 T3 各重新核实一次执行证据；`active` / `unconfirmed` 一律阻断，绝不能出现两个 Agent 同时操作同一业务目标。

---

## 6. v34 数据模型

> **本阶段只设计，不实施迁移。** 正式库当前为 v33，`task_recovery_attempts` 为 0 行。

### 6.1 `task_recovery_attempts` 重建

SQLite 的 `CHECK` 约束不能原地修改，且需要放宽两个既有唯一约束以支持链级编号。v34 采用**保留数据**的迁移流程：先把 v33 表重命名为备份表，再创建 v34 新表并逐行复制，校验通过后才在同一事务内删除旧表；**禁止先 DROP 原表再重建**。v33 数据同时由迁移前文件备份保留。

```sql
-- 步骤 0：迁移前备份（D-013）并校验备份完整性，失败即中止。
-- 步骤 1：进入 BEGIN IMMEDIATE；以下 DDL 全部在同一事务内，失败整体回滚。
ALTER TABLE task_recovery_attempts RENAME TO task_recovery_attempts_v33_backup;

-- 重命名会保留旧索引名；先删除旧索引，避免与 v34 新索引同名冲突。
DROP INDEX IF EXISTS idx_task_recovery_attempts_active;
DROP INDEX IF EXISTS idx_task_recovery_attempts_work;
DROP INDEX IF EXISTS idx_task_recovery_attempts_checkpoint;
DROP INDEX IF EXISTS idx_task_recovery_attempts_execution;
DROP INDEX IF EXISTS idx_task_recovery_attempts_team_run;
DROP INDEX IF EXISTS idx_task_recovery_attempts_node_run;

-- 步骤 2：创建 v34 新表（最终名称）
CREATE TABLE task_recovery_attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (
    kind IN ('team', 'work', 'generic', 'workflow_node')
  ),
  base_dedupe_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')
  ),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  eligibility_status TEXT NOT NULL CHECK (
    eligibility_status IN ('eligible', 'conditional', 'blocked')
  ),
  original_work_status TEXT CHECK (
    original_work_status IS NULL OR
    original_work_status IN ('active', 'paused', 'completed')
  ),
  reopen_reason TEXT,
  operator_confirmation_json TEXT NOT NULL DEFAULT '{}',
  plan_hash TEXT NOT NULL,
  context_manifest_json TEXT NOT NULL DEFAULT '{}',

  -- 1B-2A：恢复执行 / 团队运行
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  team_run_id TEXT REFERENCES team_task_runs(id) ON DELETE RESTRICT,

  -- 1B-2B：Workflow 目标
  -- node_run_id 语义在 workflow_node 下明确为「新 attempt B」
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE RESTRICT,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  branch_run_id TEXT REFERENCES branch_runs(id) ON DELETE RESTRICT,
  recovered_node_run_id TEXT REFERENCES node_runs(id) ON DELETE RESTRICT,
  chain_attempt_no INTEGER CHECK (
    chain_attempt_no IS NULL OR chain_attempt_no BETWEEN 1 AND 3
  ),

  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,

  CHECK (
    kind <> 'workflow_node' OR (
      workflow_run_id IS NOT NULL AND
      recovered_node_run_id IS NOT NULL AND
      chain_attempt_no IS NOT NULL
    )
  ),
  CHECK (
    kind = 'workflow_node' OR (
      workflow_run_id IS NULL AND
      branch_run_id IS NULL AND
      recovered_node_run_id IS NULL AND
      chain_attempt_no IS NULL AND
      node_run_id IS NULL
    )
  )
);

-- 步骤 3：逐行复制 v33 数据；字段映射见 §6.6
INSERT INTO task_recovery_attempts (
  id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
  attempt_no, status, risk_level, eligibility_status, original_work_status,
  reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
  execution_id, session_id, team_run_id, node_run_id,
  workflow_run_id, branch_run_id, recovered_node_run_id, chain_attempt_no,
  error_json, created_at, updated_at, started_at, ended_at
)
SELECT
  id, work_id, checkpoint_id, kind, base_dedupe_key, dedupe_key, idempotency_key,
  attempt_no, status, risk_level, eligibility_status, original_work_status,
  reopen_reason, operator_confirmation_json, plan_hash, context_manifest_json,
  execution_id, session_id, team_run_id, node_run_id,
  NULL, NULL, NULL, NULL,
  error_json, created_at, updated_at, started_at, ended_at
FROM task_recovery_attempts_v33_backup;

-- 步骤 4：迁移代码校验（必须在 CREATE INDEX / COMMIT 之前完成）：
--   a) SELECT COUNT(*) 旧表 = 新表；b) 逐列抽样/全列校验；
--   c) 新表不存在 NULL 违反 CHECK 的行；d) 非 workflow 行的 node_run_id 均为 NULL。
-- 任一失败 → ROLLBACK；SQLite 会回滚 RENAME、DROP INDEX、CREATE 与 INSERT。

-- 步骤 5：重建索引（见下）
-- 步骤 6：PRAGMA foreign_key_check 必须为空
-- 步骤 7：全部校验通过后，同一事务内 DROP TABLE task_recovery_attempts_v33_backup。
--         旧表数据已完整复制到 v34，且迁移前文件备份保留；
--         这不是“先 DROP 后重建”，因为删除发生在复制与校验之后。
-- 步骤 8：COMMIT 后执行迁移后完整性检查 + 启动一致性检查。
```

约束与索引：

```sql
-- 1B-2A 既有语义（仅非 workflow_node）
CREATE UNIQUE INDEX idx_task_recovery_attempts_non_workflow_checkpoint_attempt
  ON task_recovery_attempts(work_id, checkpoint_id, attempt_no)
  WHERE kind <> 'workflow_node';

CREATE UNIQUE INDEX idx_task_recovery_attempts_non_workflow_base_attempt
  ON task_recovery_attempts(work_id, base_dedupe_key, attempt_no)
  WHERE kind <> 'workflow_node';

-- 跨所有 kind 的请求幂等
CREATE UNIQUE INDEX idx_task_recovery_attempts_idempotency
  ON task_recovery_attempts(work_id, idempotency_key);

CREATE UNIQUE INDEX idx_task_recovery_attempts_dedupe
  ON task_recovery_attempts(work_id, dedupe_key);

-- 恢复链预算：按原始 NodeRun A0 全局唯一（不依赖 workflow_run_id）
CREATE UNIQUE INDEX idx_task_recovery_attempts_chain_attempt
  ON task_recovery_attempts(recovered_node_run_id, chain_attempt_no)
  WHERE kind = 'workflow_node';

-- 同一恢复链至多一个进行中恢复
CREATE UNIQUE INDEX idx_task_recovery_attempts_active_chain
  ON task_recovery_attempts(recovered_node_run_id)
  WHERE kind = 'workflow_node' AND status IN ('starting', 'running');

-- 沿用 1B-2A：每个 Work 至多一个进行中恢复
CREATE UNIQUE INDEX idx_task_recovery_attempts_active
  ON task_recovery_attempts(work_id)
  WHERE status IN ('starting', 'running');

CREATE INDEX idx_task_recovery_attempts_work
  ON task_recovery_attempts(work_id, created_at);
CREATE INDEX idx_task_recovery_attempts_checkpoint
  ON task_recovery_attempts(checkpoint_id, attempt_no);
CREATE INDEX idx_task_recovery_attempts_execution
  ON task_recovery_attempts(execution_id);
CREATE INDEX idx_task_recovery_attempts_team_run
  ON task_recovery_attempts(team_run_id);
CREATE INDEX idx_task_recovery_attempts_node_run
  ON task_recovery_attempts(node_run_id);
CREATE INDEX idx_task_recovery_attempts_recovered_node_run
  ON task_recovery_attempts(recovered_node_run_id);
CREATE INDEX idx_task_recovery_attempts_workflow_run
  ON task_recovery_attempts(workflow_run_id, status);
```

### 6.2 `node_runs` 唯一索引

```sql
DROP INDEX IF EXISTS idx_node_runs_run_key_attempt;

CREATE UNIQUE INDEX idx_node_runs_run_key_attempt
  ON node_runs(workflow_run_id, workflow_node_key, attempt);
```

迁移前必须执行重复检查；发现重复则**失败迁移**，不自动修复：

```sql
SELECT workflow_run_id, workflow_node_key, attempt, COUNT(*)
FROM node_runs
GROUP BY workflow_run_id, workflow_node_key, attempt
HAVING COUNT(*) > 1;
```

### 6.2.1 `worktrees` 活跃分支唯一索引（P0-2）

```sql
CREATE UNIQUE INDEX idx_worktrees_work_branch_active
  ON worktrees(work_id, branch_name)
  WHERE status = 'active';
```

作用：数据库级阻止同一 Work 同时存在两个 active Worktree 使用同一分支；配合 `worktrees.worktree_path` 既有唯一约束与 T1 活跃恢复唯一索引，保证恢复 Worktree 的“一资源一归属”。

迁移前检查重复；发现重复则失败迁移，不自动删除或合并：

```sql
SELECT work_id, branch_name, COUNT(*)
FROM worktrees
WHERE status = 'active'
GROUP BY work_id, branch_name
HAVING COUNT(*) > 1;
```

### 6.2.2 `workdir_locks` 进程身份列（P1）

为支持 PID 复用判断与 holder 转移，v34 增加可空列：

```sql
ALTER TABLE workdir_locks ADD COLUMN holder_started_at TEXT;
ALTER TABLE workdir_locks ADD COLUMN holder_kind TEXT; -- 'core' | 'cli'，服务层校验
```

- 旧行为 NULL，视为“身份未知”：`purgeStale` 必须保留锁并进入 `manual_review`，不得回收。
- 新写入：acquire 时 `holder_kind='core'` + Core 启动标识；spawn 后更新为 `holder_kind='cli'` + CLI 启动标识。
- 不新增 NOT NULL/CHECK（SQLite ADD COLUMN 兼容旧行）；服务层负责枚举校验。
- 迁移测试必须覆盖旧行 NULL、CLI 存活、CLI 退出、PID 复用四种情况。

### 6.3 字段语义

| 字段 | 非 workflow_node | workflow_node |
|---|---|---|
| `node_run_id` | NULL | **新 attempt B** |
| `recovered_node_run_id` | NULL | 恢复链的原始目标 attempt A0 |
| `workflow_run_id` / `branch_run_id` | NULL | 目标 Run / 分支 |
| `attempt_no` / `chain_attempt_no` | 沿用 1B-2A 的 `attempt_no` 语义；`chain_attempt_no` 为 NULL | **两套编号明确分开**：`attempt_no` 是所选 Checkpoint 维度的恢复账本编号（与 1B-2A 一致，仅用于审计/兼容）；`chain_attempt_no` 是恢复链预算编号（1..3）。两者不要求相等，互不推导 |
| `base_dedupe_key` | 沿用 1B-2A | `workflow_node:<recoveredNodeRunId>`（A0 全局唯一；不依赖 Run） |
| `dedupe_key` | 沿用 1B-2A | `workflow_node:<recoveredNodeRunId>:<chainAttemptNo>` |
| `checkpoint_id` | 恢复基线 | 按 §5.4 选出的基线 |

Workflow 的预算计数**不使用** `countByCheckpoint`，而使用 `countByRecoveredNodeRun(recoveredNodeRunId)`（不传 workflowRunId）；`MAX_RECOVERY_ATTEMPTS` 仍为 3。`chain_attempt_no` 只由链预算计算，`attempt_no` 只由所选 Checkpoint 计算，二者不得互相覆盖或同步推导。Team/Work/generic 的 `attempt_no` 语义完全不变。数据库唯一索引 `UNIQUE(recovered_node_run_id, chain_attempt_no) WHERE kind='workflow_node'` 是预算的最终底线。

### 6.4 不修改的表

- `agent_sessions`：不新增列。
- `executions`：不新增列。恢复执行与 NodeRun 的关联使用现有 `node_run_id`；如需可观测性，可写入现有 `recovery_state_json`。
- `node_runs`：不新增列，只新增唯一索引。
- `worktrees`：不新增列，只新增 active 分支唯一索引（§6.2.1）。
- `workdir_locks`：新增可空 `holder_started_at`、`holder_kind`（§6.2.2），用于 PID 复用判断与 holder 转移。
- `workflow_runs` / `branch_runs`：不改结构。

### 6.5 迁移安全

1. 迁移前使用 SQLite 一致性备份（D-013）；备份文件必须位于数据库文件之外，备份完整性检查失败即中止。
2. 迁移在 `BEGIN IMMEDIATE` 内执行；表重建后运行 `PRAGMA foreign_key_check`。
3. 迁移前检查既有数据：`kind <> 'workflow_node' AND node_run_id IS NOT NULL`、`chain_attempt_no` 非空、`base_dedupe_key/attempt_no` 违反约束、或 `worktrees` 存在重复 active `(work_id, branch_name)` 时，**失败迁移**，不自动改写。
4. **完整字段比较**：不仅比较行数，必须逐行逐列比较 v33 与 v34 的全部 v33 字段（NULL 与空字符串、默认值、JSON 原文均按规范值比较）；不一致即回滚。
5. **触发器检查与重建**：迁移前查询 `sqlite_master` 中 `tbl_name='task_recovery_attempts'` 的全部触发器；v33 当前无触发器，但迁移代码必须枚举并重建，未知触发器视为迁移失败。
6. **约束保留**：所有旧字段的 NOT NULL、DEFAULT、CHECK、状态枚举必须保留；v34 新增字段对非 workflow 行必须为 NULL，由 CHECK 约束保证。
7. 正式库当前 `task_recovery_attempts=0`，但仍按通用迁移编写，禁止假设 0 行。
8. 迁移完成后验证：`user_version=34`、既有 1B-2A 恢复记录可读、唯一索引存在、触发器集合符合预期。
9. **提交后检查失败**：不视为迁移成功；Core 进入 `recovery_locked`，使用外部备份恢复；不得开放业务入口。
10. 不在本阶段执行迁移；只在 CTO 批准实施后执行。
11. 实施阶段必须在真实 SQLite 版本下测试：`ALTER TABLE RENAME`、索引重建、外键关系、触发器重建、失败回滚；测试必须包含有数据、有触发器、有外键、有索引的真实结构，不能只验证空表。
12. `workdir_locks` 的 `ADD COLUMN holder_started_at/holder_kind` 必须在真实 SQLite 上验证；旧行 NULL 不得被自动回收，必须走 manual_review。

### 6.6 v33 → v34 字段映射与回滚

#### 字段映射

| v33 字段 | v34 字段 | 处理 |
|---|---|---|
| `id` | `id` | 原值保留 |
| `work_id` | `work_id` | 原值保留；外键重建后仍指向 `works` |
| `checkpoint_id` | `checkpoint_id` | 原值保留；外键仍指向 `task_checkpoints` |
| `kind` | `kind` | 原值保留（`team/work/generic`） |
| `base_dedupe_key` / `dedupe_key` / `idempotency_key` | 同名 | 原值保留 |
| `attempt_no` | `attempt_no` | 原值保留 |
| `status` / `risk_level` / `eligibility_status` | 同名 | 原值保留 |
| `original_work_status` / `reopen_reason` | 同名 | 原值保留 |
| `operator_confirmation_json` / `plan_hash` / `context_manifest_json` | 同名 | 原值保留 |
| `execution_id` / `session_id` / `team_run_id` | 同名 | 原值保留；外键重建 |
| `node_run_id` | `node_run_id` | v33 必须为 NULL；非 NULL 时迁移失败（fail closed） |
| — | `workflow_run_id` | 新列，NULL |
| — | `branch_run_id` | 新列，NULL |
| — | `recovered_node_run_id` | 新列，NULL |
| — | `chain_attempt_no` | 新列，NULL |
| `error_json` / `created_at` / `updated_at` / `started_at` / `ended_at` | 同名 | 原值保留 |

#### 外键重建

v34 重建后必须逐项验证：

- `work_id → works(id) ON DELETE RESTRICT`
- `checkpoint_id → task_checkpoints(id) ON DELETE RESTRICT`
- `execution_id → executions(id) ON DELETE RESTRICT`
- `session_id → agent_sessions(id) ON DELETE RESTRICT`
- `team_run_id → team_task_runs(id) ON DELETE RESTRICT`
- `node_run_id → node_runs(id) ON DELETE RESTRICT`
- 新增：`workflow_run_id → workflow_runs(id) ON DELETE RESTRICT`
- 新增：`branch_run_id → branch_runs(id) ON DELETE RESTRICT`
- 新增：`recovered_node_run_id → node_runs(id) ON DELETE RESTRICT`

#### 索引重建

- 重建 1B-2A 的 `work/checkpoint/execution/team_run/node_run` 索引。
- 新增 §6.1 的幂等、去重、链预算、链活跃、workflow_run 索引。
- 旧索引在 RENAME 后先删除，避免与 v34 同名索引冲突；删除与重建都在同一事务内。

#### 触发器重建

- 迁移前从 `sqlite_master` 枚举 `tbl_name='task_recovery_attempts'` 的所有触发器，保存 `sql`。
- v34 表创建并复制数据后，按原定义在新表上重建；重建后的触发器集合必须与迁移前完全一致。
- v33 当前没有该表触发器；若实施时发现未知触发器，迁移失败，不猜测语义。
- 测试必须覆盖“有触发器时重建成功”和“触发器定义不兼容时迁移失败”。

#### workflow 编号说明

- `attempt_no` 为所选 Checkpoint 维度的恢复账本编号，沿用 1B-2A；`chain_attempt_no` 为链预算编号（1..3）。
- 两者不相等、不互相推导；不得用 `attempt_no` 计算链预算，也不得用 `chain_attempt_no` 覆盖 `attempt_no`。
- 非 workflow 行 `chain_attempt_no` 必须为 NULL；workflow 行 `attempt_no` 仍按 Checkpoint 计数。

#### 失败与回滚

1. 迁移前备份失败 → 不进入迁移。
2. 事务内任何步骤失败 → `ROLLBACK`；原表名、原索引、原数据恢复。
3. 提交后发现行数/字段/外键/完整性异常 → 不视为迁移成功；Core 进入 `recovery_locked`，使用迁移前备份恢复；不得带着不一致状态开放业务入口。
4. 不自动“修复”历史行；无法映射的行必须失败并报告。
5. 旧表在复制与校验通过后、同一事务内删除；v33 数据由迁移前 SQLite 一致性备份（D-013）保留。**不保留带外键的库内备份表**，避免 `ON DELETE RESTRICT` 影响后续 Work/Execution 清理。

---

## 7. 启动流程、事务边界与崩溃窗口

### 7.1 Plan（只读）

`RecoveryService.planWorkflowNode`：

1. 读取 Run / Work / NodeRun / Branch / Definition。
2. 执行 §5.3 检查（`start` 必需项在 plan 中标为 blocker）。
3. 解析 Checkpoint（§5.4），调用 `getRecoveryPlan`。
4. 计算 chain 预算与下一次 attempt 编号。
5. 构建 Context 预览（只读；失败不写任何状态）。
6. 返回 `eligibility / limits / checkpoint / nextAttempt / runReentry / contextBudget`。

Plan 不写恢复账本，不写审计（只读失败可由调用方记录，不影响状态）。

### 7.2 Start：T1 — 持久化启动意图

```text
BEGIN IMMEDIATE
  - 幂等键命中 → 直接返回既有结果（payload 校验见 §13）
  - 重新执行关键资格检查（不信任 plan 结果）
  - 重新确认旧执行证据：terminal（已停止）或 not_started（确定未启动）；
    active / unconfirmed 一律拒绝（P0-1）
  - 计算 chain_attempt_no = countByChain + 1（≤3）；启动即计数，不返还
  - INSERT task_recovery_attempts(kind='workflow_node', status='starting', ...)
COMMIT
```

T1 之后崩溃：恢复 Attempt 停在 `starting`，没有新 NodeRun、没有新 Execution。启动收敛分两种情况：

- **没有 Worktree 意图**（T2a 尚未提交）：由 `RecoveryService.recoverOnStartup()` 收敛为 `failed(RECOVERY_START_INTERRUPTED)`；旧 attempt 不变。
- **已有 Worktree 意图**（`context_manifest_json.worktree` 存在，state=`creating`/`ready`）：**通用 `recoverOnStartup()` 必须跳过**，不得提前把 R 终结为 failed。必须先由 `WorkflowWorktreeRecoveryReconciler` 检查真实 Git 注册状态并持久化 orphan/abandoned 事实，再交给 RecoveryService 收敛。
- 筛选规则必须写在 `recoverOnStartup()` 与 `reconcileInterruptedStarts()` 内部，而不是只靠调用顺序：`kind='workflow_node' AND status='starting' AND json_extract(context_manifest_json,'$.worktree') IS NOT NULL` → 跳过；`state='needs_manual_review'` → 永远跳过并阻断业务入口。
- 该跳过是通用逻辑的硬编码分支，不能被任意调用方绕过；测试必须覆盖“先 recoverOnStartup 也不会提前终态”。

### 7.3 Start：T2 — 构建恢复上下文与隔离 Worktree

1. 重新解析 Assignment（`WorkflowAssignmentResolver.resolveForNode`，保留现有 override）。
2. 调用 `ContextBuilder.buildRecoveryPrompt` 构建 P0-P3，并追加 Workflow 节点段（§11）。
3. **T2a：先持久化 Worktree 归属意图（在任何文件系统创建之前）**
   - 只接受 `workingDirectoryPolicy='worktree'`；共享目录在 plan 阶段已阻断。
   - 读取并锁定 `newAttempt = maxAttempt(run, key) + 1`、`chainAttemptNo`。
   - 生成不可混淆的归属令牌：
     - `worktreeOwnerToken = randomUUID()`；
     - `newNodeRunId = newId('nrn')`（T2a 预生成，T3 必须复用该 ID，不得重新生成）；
     - `slug(nodeKey)` = 小写、非 `[a-z0-9-]` 替换为 `-`、去除首尾 `-`、截断到 40 字符；空串用 `node`；
     - `hash8(nodeKey)` = `sha256(nodeKey)` 前 8 位；
     - `branchName = agentra/<runId 后 12 位>/<slug>-<hash8>/<newAttempt>-r<chainAttemptNo>`；
     - `branchName` 必须通过 `git check-ref-format --branch <branchName>`；`nodeKey` 不得直接拼入 ref。
     - `worktreePath = join(realpath(Agentra worktree root), workId, branchName)`。
   - 在恢复 Attempt 的 `context_manifest_json.worktree` 写入 `state='creating'` 及：
     `worktreeId`（预生成）、`worktreeOwnerToken`、`worktreePath`、`branchName`、`workflowRunId`、`workId`、`nodeKey`、`newNodeRunId`（预生成）、`predictedAttempt`、`chainAttemptNo`、`recoveryAttemptId`、`createdAt`。
   - **T2a 事务与 CAS**：上述写入必须在 `BEGIN IMMEDIATE` 内，以 CAS 更新：
     `WHERE id = ? AND status = 'starting' AND json_extract(context_manifest_json, '$.worktree') IS NULL`。
     `changes=0` → 回滚并返回 `NODE_RECOVERY_ACTIVE_EXISTS` / `NODE_RECOVERY_TARGET_CHANGED`，**不得生成第二个 owner**。
   - **幂等重放**：同一 `idempotencyKey` 命中已有 R 时只返回原 R 及其 Worktree 状态，不重新创建 Worktree、不重跑 T2b、不进入 T3；若 R 已处于 `running/terminal`，按原状态返回。
   - 该写入必须先于 `git worktree add` 提交；它是崩溃后识别“未登记 Worktree”的唯一依据。
4. **T2b：创建 Worktree 并做 Git 身份校验**
   - 使用参数数组执行 `git -C <work.repository_path> worktree add -b <branchName> <worktreePath>`；禁止 shell 字符串拼接。
   - 创建后必须完成以下真实路径与 Git 校验，任一失败即失败：
     1. **真实路径解析**：对 `worktreeRoot` 和 `worktreePath` 分别执行 `realpath`（或等效系统调用）；用 `path.relative(realRoot, realPath)` 判断，结果不得以 `..` 开头、不得为绝对路径、不得为空；禁止只用字符串前缀判断，防止符号链接逃逸。
     2. **Git ref 合法**：`git check-ref-format --branch <branchName>` 通过；分支名长度与字符集符合 Git 规则；不得包含 `..`、空格、`~^:?*[\\`、结尾 `.` 等非法序列。
     3. **baseCommit 属于目标仓库**：在 `work.repository_path` 中执行 `git rev-parse --verify <baseCommit>^{commit}` 且 `git cat-file -e <baseCommit>^{commit}`；确认 commit 对象存在于该仓库的对象库，不是从其他仓库解析出的引用。
     4. **Git 注册信息一致**：`git -C <work.repository_path> worktree list --porcelain` 中必须存在该 `worktreePath`，其 `branch` 为 `refs/heads/<branchName>`、`HEAD` 与记录一致；`git -C <worktreePath> rev-parse --show-toplevel` 的 realpath 等于 `worktreePath` 的 realpath；`git -C <worktreePath> symbolic-ref --short HEAD` 等于 `branchName`；`git -C <worktreePath> rev-parse HEAD` 等于记录的 `baseCommit`。
     5. **数据库一致**：`worktrees` 行 `status='active'`、`workId` 匹配、`branchName` 与 `worktreePath` 与 §7.3.3 意图完全一致；不存在另一个 active Worktree 使用同一 `(work_id, branch_name)`。
     6. **不是旧 attempt 资源**：`worktreeId`、`branchName`、`worktreePath` 均不得与目标节点任何历史 attempt 或历史恢复记录相同。
   - 校验通过后，T2b 事务把 `context_manifest_json.worktree` 更新为 `state='ready'`，并补齐 `baseCommit`、`gitCommonDir`、`registeredWorktreePath`、`verifiedAt`。该更新同样使用 CAS：
     `WHERE id = ? AND status = 'starting' AND json_extract(context_manifest_json, '$.worktree.state') = 'creating' AND json_extract(context_manifest_json, '$.worktree.worktreeOwnerToken') = ?`；
     `changes=0` → 不得认领，按孤儿/失败路径处理。
   - `worktrees` 表只允许创建一次；T2b 不得创建第二个 Worktree，也不得复用已有 active Worktree。
5. 任一失败 → 恢复 Attempt `starting → failed`，审计 `workflow.node.recovery.start_failed`；不创建 NodeRun/Execution；**不降级复用旧 Worktree 或共享目录**。
6. Worktree 创建成功但 T2/T3 失败或进程退出 → 该 Worktree 不得被后续 attempt 复用；记录 `workflow.node.recovery.worktree_orphaned`，交由受控孤儿资源核查流程处理。**不得在不验证归属的情况下自动删除**。
7. 文件系统 Worktree 创建无法与 SQLite 事务天然原子化：T2a 先写归属意图，T2b 创建并验证，T3 在数据库事务内重新验证 ownership token 与 Git 身份。T3 回滚不自动回滚文件系统；必须依赖第 6 条与 §7.7 的启动对账。

### 7.4 Start：T3 — 原子创建新 attempt 与执行

单一事务，顺序固定：

```text
BEGIN IMMEDIATE
  1. 重新读取 A，确认仍是最新 attempt、状态符合 §5.2，且旧执行证据仍为
     terminal / not_started；若变为 active/unconfirmed → 抛
     NODE_RECOVERY_EXECUTION_ACTIVE / NODE_RECOVERY_EXECUTION_UNCONFIRMED 并回滚
  2. 若 A 为 reconciliation_required：
       nodes.fail(A, ['reconciliation_required'], {
         category: 'recovery_superseded',
         nodeKey,
         message: 'superseded by workflow node recovery',
         details: { recoveryAttemptId, newNodeRunId }
       })
       CAS 失败 → 抛 NODE_RECOVERY_TARGET_CHANGED，回滚
     若 A 为恢复链内 failed：不改写
  3. 重新验证 T2 记录的隔离 Worktree（任何失败 → 回滚）：
       - R.context_manifest_json.worktree.state = 'ready'
       - worktreeOwnerToken === R.context_manifest_json.worktree.worktreeOwnerToken
       - newNodeRunId === R.context_manifest_json.worktree.newNodeRunId
       - node_runs 中不存在该 newNodeRunId（预生成 ID 未被占用）
       - predictedAttempt === R.context_manifest_json.worktree.predictedAttempt
         === maxAttempt(run, key) + 1；变化则冲突
       - worktrees.status='active'、workId 匹配、branchName/path 与 T2 记录完全一致
       - 重新执行 §7.3.4 的真实路径、Git ref、baseCommit、Git 注册信息校验
       - worktree.createdAt >= R.createdAt；不是旧 attempt 的 Worktree
       - 没有任何现有 Execution 正在使用该 worktreePath
       失败 → 抛 NODE_RECOVERY_WORKTREE_INVALID / NODE_RECOVERY_ATTEMPT_CONFLICT，
       回滚，不创建 B
  4. 创建 B：
       id = R.context_manifest_json.worktree.newNodeRunId  // T2a 预生成，必须一致
       workflowRunId / workflowNodeKey = A
       branchRunId = A.branchRunId（必须非空，否则回滚）
       attempt = R.context_manifest_json.worktree.predictedAttempt
       status = 'ready'
       inputSnapshot = A.inputSnapshot  // 仅原始输入；不得混入 A.outputSnapshot、
                                         // 未验证 Artifact 或旧执行结果
       outputSnapshot = NULL  // 旧 attempt 的部分输出不作为新 attempt 的交付物
     nodes.transition(B, ['ready'], 'running', now)  // 状态机校验 + started_at
     若 transition 返回 false → 抛 NODE_RECOVERY_ATTEMPT_CONFLICT，回滚
  5. ExecutionService.startRecoveryForNode(B.id, {
       agentId, workId, prompt,
       worktreeId,            // 必填，不是可选
       recoveryAttemptId
     }, tx)                    // 统一事务上下文，见 §7.4.1
       - 必须使用 T3 的同一个 tx/连接，不得自行开启事务或独立连接
       - 服务端再次校验 worktreeId 与 T2 记录一致、状态 active、归属正确
       - 新 agent_sessions 行（永远新 Session）
       - 新 executions 行：status='pending', node_run_id=B.id,
         recovery_state_json={ recoveryAttemptId, recoveredNodeRunId, checkpointId,
                               worktreeId }
       - 不 spawn、不执行 git/fs/网络/外部进程调用
  6. recoveryAttempt: starting → running，写入 node_run_id=B, execution_id, session_id,
     workflow_run_id, branch_run_id, recovered_node_run_id, worktreeId, started_at
  7. 若 run.status='reconciliation_required' 且满足 §9.2 重入条件与 §9.2.1
     一致性检查（条件 1/3/5 排除当前 R 及其新 Execution）：
       run: reconciliation_required → running
COMMIT
```

事务内任何一步失败 → 整体回滚：A 恢复原状态、B 不存在、Session/Execution 不存在、**恢复 Attempt 保持 `starting`**。**不得出现半个恢复。**

T3 失败后，R 的终态收敛必须在**另一个独立事务**中完成（写 `failed` + 审计），不得混入 T3 事务；测试必须验证回滚边界处 R 仍为 `starting`。

### 7.4.1 T3 统一事务上下文契约（P0）

`BEGIN IMMEDIATE` 不能只是调用层面的描述，必须落到明确的连接/事务上下文：

```ts
type RecoveryTxContext = {
  db: Database              // 已处于 BEGIN IMMEDIATE 的同一连接
  inTransaction: true
}

ExecutionService.startRecoveryForNode(
  nodeRunId: string,
  params: { agentId; workId; prompt; worktreeId: string; recoveryAttemptId: string },
  tx: RecoveryTxContext,
): { sessionId: string; executionId: string }
```

强制约束：

1. **同一连接**：A 收敛、B 创建/迁移、Session、Execution、R 更新、Run 重入全部使用 `tx.db`；不得另开连接或嵌套 `transaction()`。
2. **禁止内部提交**：`startRecoveryForNode` 不得调用 `transaction()`、`BEGIN/COMMIT/ROLLBACK`；它只执行 `tx.db.prepare(...).run(...)`。
3. **禁止事务内副作用**：T3 内禁止 spawn CLI、`execFile`、`git` 调用、文件系统创建/删除、网络请求、Artifact 写入；Worktree 已在 T2 完成。
4. **返回值只含 ID**：Session/Execution 的创建结果以 ID 返回，spawn 由 COMMIT 后的独立方法完成。
5. **失败注入测试**：分别在 Session 插入后、Execution 插入后、R `starting → running` 后抛错，断言：
   - A 仍为 `reconciliation_required`（或原状态）；
   - B 不存在；
   - Session/Execution 不存在；
   - R 仍为 `starting`；
   - 事务连接已回滚且可继续使用。
6. **事务上下文校验**：`startRecoveryForNode` 启动时断言 `tx.inTransaction === true`；测试覆盖传入非事务连接时拒绝。
7. **COMMIT 后 spawn**：spawn 只能由 `ExecutionService.spawnRecovery(executionId)` 在 T3 COMMIT 后调用；spawn 不属于 T3 原子性范围。

**T3 与文件系统的边界**：Worktree 创建在 T2，不在 T3；T3 只做数据库记录。T3 回滚不会回滚 T2 文件系统，因此 T2 Worktree 的孤儿/归属规则（§7.3、§7.7）独立于 T3 事务。

### 7.4.2 T3 回滚后的即时收敛责任（P0）

T3 抛错并完整回滚后，R 不能无限停留在 `starting` 并占用活跃恢复唯一索引。责任链固定为：

1. **T3 事务回滚**：A/B/Session/Execution/R 全部回到 T3 前状态；R 仍为 `starting`。
2. **数据库仍可写 → 立即独立事务收敛**：
   - 调用 `WorkflowWorktreeRecoveryReconciler.convergeAfterT3Failure(R.id, 'T3_ROLLED_BACK')`；
   - 在**新的** `BEGIN IMMEDIATE` 中：
     - 重读 R，要求 `status='starting'`；否则跳过（幂等）；
     - Worktree 意图 `state='ready'` → 持久化 `state='orphaned'`、`reason='T3_ROLLED_BACK'`；
     - `state='creating'`/无 Worktree → `state='abandoned'`；
     - 无法确认 → `state='needs_manual_review'`，**不终结 R**，审计 `worktree_manual_review`；
     - 可终结时：R `starting → failed`，`error_json` 写 `T3_ROLLED_BACK`，`ended_at` 落库；
     - 审计 `workflow.node.recovery.failed` + `worktree_orphaned/abandoned`。
3. **独立事务也失败（数据库不可写）**：R 保持 `starting`；记录进程日志；fail closed；不得在内存里伪造终态。下次启动由 Worktree Reconciler + `recoverOnStartup()` 收敛。
4. **R 未终态前**：
   - 活跃恢复唯一索引继续阻止同一 Work/链的新恢复；
   - 任何请求不得认领、复用或覆盖该 Worktree；
   - `plan` 返回 `NODE_RECOVERY_ACTIVE_EXISTS`。
5. **`needs_manual_review`**：R 保持 `starting`；启动/运行期进入 `recovery_locked`；必须人工核实 Git/Execution 后才能收敛。

**收敛器幂等**：`convergeAfterT3Failure` 重读 R 状态，只有 `starting` 才执行；重复调用返回同一结果，不重复写审计成功记录、不重复处置 Worktree。

**T3 失败原因分类**：

| 失败点 | R 收敛 | Worktree 处置 |
|---|---|---|
| Worktree 验证失败 | failed `T3_ROLLED_BACK` | orphaned（ready）或 manual_review |
| B 创建/迁移失败 | failed `T3_ROLLED_BACK` | orphaned |
| Session/Execution 创建失败 | failed `T3_ROLLED_BACK` | orphaned |
| R 更新失败 | failed `T3_ROLLED_BACK` | orphaned |
| 数据库不可写 | 保持 starting | 保持原状态，等待启动对账 |

### 7.5 COMMIT 后 spawn 前的最终复核与 Workdir 锁

1. **获取 Workdir 锁**：对 `realpath(worktreePath)` 获取现有 `workdir_locks` 唯一锁（与普通执行相同的锁服务）；获取失败 → 不 spawn，按启动失败收敛。
2. **spawn 前最终复核**（校验后到使用前的竞态防护）：
   - 重新执行 `realpath` 边界、`git worktree list`、`rev-parse --show-toplevel`、`symbolic-ref --short HEAD`、`rev-parse HEAD`；
   - 任一与 T2b/T3 记录不一致 → 释放锁，Execution 收敛为 failed（从未启动），B → `reconciliation_required`，R → `failed`，记录 `worktree_owner_mismatch` / `worktree_orphaned`；
   - 复核与 spawn 之间不得插入其他 await 或外部命令。
3. 调用 `ExecutionService` 现有启动路径 spawn CLI；锁保持到 Execution 终态/补偿完成。
4. spawn 抛错：
   - Execution 保持/收敛为 `failed`（表示从未启动）；
   - B `running → reconciliation_required`（不是 failed；保留再次恢复资格）；
   - 恢复 Attempt `running → failed`；
   - 审计 `workflow.node.recovery.start_failed`；
   - 该 Worktree 标记为本次恢复专用、后续 attempt 不得复用；记录 `workflow.node.recovery.worktree_orphaned`；
   - 释放 Workdir 锁；
   - 不自动重试、不自动创建下一 attempt。
5. spawn 成功 → 正常返回 RPC；R 保持 `running`；锁由 Execution 终态处理释放。

**残余竞态说明**：SQLite 事务不能锁住文件系统；`workdir_locks` 只能防止 Agentra 内的并发使用，无法阻止外部进程修改 Worktree。spawn 前最终复核把窗口缩到最小；任何复核失败一律 fail closed，不 spawn。

### 7.5.1 Workdir 锁接口契约（P1）

**归属与 key**

- 锁服务：现有 `WorkdirLockService`（`workdir_locks` 表），由 `ExecutionService.spawnRecovery` 获取/释放；Workflow 适配器不直接操作锁表。
- 锁 key：`realpathSync.native(worktreePath)` 的规范绝对路径，不是原始 `worktreePath`，也不是仅 `path.resolve`。`realpath` 失败 → 不获取锁、不 spawn。
- 数据库主键 `workdir_locks.workdir` 是规范化路径；跨进程并发由主键唯一约束兜底。
- 获取时写入 `execution_id`、`work_id`、`holder_pid`、`boot_uuid`、`acquired_at`；同一 `execution_id` 重复获取幂等。

**holder 身份与 CLI 存活**

- 预 spawn：以 Core PID + Core 进程启动标识作为 `holder_pid` / `holder_started_at`，`holder_kind='core'` 预留锁。
- spawn 成功后：立即把该锁更新为 CLI 的 `executions.process_id` + CLI 启动标识，`holder_kind='cli'`。
- **进程身份不能只看 PID**：`WorkdirLockService` 必须通过平台适配器（macOS `ps -o lstart= -p <pid>` 或 `proc_pidinfo` 等）读取进程启动时间/可验证身份；PID 相同但启动时间不同 → 视为 PID 被复用，不是原进程。
- 进程身份不可读取 → 视为“无法确认”，保留锁，不得回收。

**`purgeStale()` 判断顺序（P0，Boot UUID 不得覆盖 CLI 存活）**

对每条锁按以下顺序判定：

1. **读取关联 Execution**（`workdir_locks.execution_id`）。Execution 不存在 → **保留锁**，标记 `manual_review`，不得回收。
2. **检查 Execution 状态**。
3. **检查 CLI 进程**：优先使用 `executions.process_id`，并核对 `holder_started_at` / 进程身份；`holder_kind='core'` 时也检查 Core PID 是否存活。
4. **CLI/Core 仍存活且身份匹配** → **保留锁**（即使 Boot UUID 已变）；审计 `lock_retained_alive`。
5. **CLI 已确认退出**（PID 不存在，或 PID 复用且启动标识不匹配）：
   - Execution 已终态 → 回收锁；
   - Execution 非终态 → **先不回收**，交由 Execution 对账收敛；下次 purge 再判断。
6. **无法确认**（Execution 缺失、process_id 缺失、身份读取失败、Daemon 不可用）→ **保留锁**，标记 `manual_review`，进入 `recovery_locked`。

Boot UUID 只用于判断“原 Core 实例是否已结束”，**不能单独作为回收依据**；只有在第 5 步“CLI 已退出 + Execution 终态”成立时才参与回收。

- 该规则避免“Core 重启/Boot UUID 变化后，锁被回收但 CLI 仍在运行”导致第二个执行进入同一目录。

**进程退出判定**

- 确认退出必须满足：PID 不存在（ESRCH）**且**（有启动标识时）启动标识匹配；或 PID 被复用（启动标识不匹配）且 Execution 已被对账为终态。
- 只有 PID 消失、没有启动标识/无法核对 → `unknown`，保留锁。
- Daemon 明确报告执行已退出，可作为辅助证据；不得只凭超时推断进程已退出。

**释放与生命周期**

| 事件 | 处理 |
|---|---|
| spawn 前获取锁失败 | 不 spawn，按启动失败收敛 |
| spawn 成功 | 锁保持到 Execution 终态 |
| Execution succeeded/failed/cancelled/crashed | 先确认进程已退出/终态，再 `releaseByExecution(executionId)` |
| 取消/超时 | 只有 Execution 终态且进程确认退出后释放；未确认 → 保留锁并进入 reconciliation |
| Core 重启 | `ExecutionService.reconcile()` 之后、Recovery 收敛之前执行 `purgeStale()`；按 §7.5.1 顺序保留 CLI 仍活的锁 |
| Core 被 kill -9 | 锁行保留；下次启动由 `purgeStale` + Execution 对账处理 |
| 重复释放 | `releaseByExecution` 幂等；`DELETE … WHERE execution_id = ?`，不会释放其他执行的锁 |
| holder_pid 更新失败 | 终止 CLI 并等待退出；确认退出后释放锁；无法确认退出 → 保留锁 + `manual_review` |
| CLI 已启动但 process_id 未持久化 | 锁仍为 core holder；Execution 非终态 → 保留锁 + `manual_review`，不得回收 |
| CLI 已退出但 Execution 未终态 | 保留锁，先由 Execution 对账收敛，再下一次 purge 判断 |
| Core 重启时 reconcile 与 purge 并发 | 顺序固定：Execution reconcile 完成后再 purge；不得并行判断同一 executionId |

**接口要求**

- `acquire(realpath, executionId, workId)`：写 `holder_pid`、`holder_started_at`、`holder_kind='core'`、`boot_uuid`；返回记录；冲突抛 `WORKDIR_LOCKED`。
- `updateHolderPid(realpath, executionId, cliPid, cliStartedAt)`：仅更新同一执行的行，置 `holder_kind='cli'`；更新 0 行即失败。
- `releaseByExecution(executionId)`：幂等，返回删除行数。
- `purgeStale()`：启动时调用一次；必须读取 `executions.process_id`、Execution 状态、`holder_started_at`/进程身份；不能只凭 Boot UUID 或 PID 数字回收。
- `ProcessIdentityReader`：平台适配器读取 PID 启动时间/身份；读取失败返回 `unknown`，调用方 fail closed。
- 审计/日志：`workdir.lock_acquired`、`workdir.lock_released`、`workdir.lock_reclaimed`、`workdir.lock_retained_alive`、`workdir.lock_manual_review`，字段含 executionId、workId、canonicalPath、holderPid、holderStartedAt、processId、bootUuid。

### 7.6 T4 — 执行终态与 Checkpoint

完全复用 1B-2A，但**成功判定以 NodeRun 最终业务终态为准**，不以 Execution 成功单独授权成功：

| Execution | NodeRun B | Checkpoint | Recovery Attempt | 说明 |
|---|---|---|---|---|
| `succeeded` | `succeeded` | `valid` 且**归属本次恢复**（见 §7.6.1） | `succeeded` | 唯一成功组合；Checkpoint 必须与本次 Execution/B/R 对应 |
| `succeeded` | `failed` | absent | `failed` | 输出契约违规或 Artifact/Output 提交失败；不得误判成功 |
| `succeeded` | `succeeded` | `failed` | `failed`，并记录 Checkpoint 失败 | B 保持 `succeeded` 历史事实；高风险继续阻断 |
| `succeeded` | `succeeded` | `valid` 但归属旧 attempt A | `failed` | 不得用旧 Checkpoint 证明本次恢复；审计 `CHECKPOINT_RECOVERY_MISMATCH` |
| `failed` | `failed` | absent | `failed` | 不自动 retry、不自动创建下一 attempt |
| `cancelled` | `cancelled` | absent/created | `cancelled` | 取消语义，不创建新恢复 |
| `pending` / `running` | 未终态 | absent | 保持 `starting/running` | 等待执行/启动对账，不得提前收敛 |
| 任意 | `reconciliation_required` | 任意 | 保持 `running` | 交给启动/运行期对账；人工边界 |

**四类终态含义分开定义，不得互相替代：**

- Execution 终态 = Provider 进程结束事实；
- NodeRun 终态 = 业务节点结果（成功/失败/取消）；
- Checkpoint = 恢复基线的有效性事实；
- Recovery Attempt = 本次显式恢复请求的最终结果（只有 NodeRun 成功且 Checkpoint 有效才成功）。

**Observer 幂等要求**：`WorkflowNodeTerminalObserver` 与 `onCheckpointResult` 可能重复收到同一终态事件；每次处理必须在同一事务内先读恢复 Attempt 状态，只有 `starting/running` 才允许收敛；重复事件不得重复完成恢复账本、不得重复触发副作用、不得重复写审计成功记录。

所有 `workflow_node` 恢复 Attempt 进入终态（`succeeded` / `failed` / `cancelled`）后，必须调用 `WorkflowRunRecoveryCoordinator.reconcileRun(runId)`；不得依赖 `engine.kick` 处理 `reconciliation_required` 的 Run（`kick` 对非 `running` Run 是空操作）。

**补充观察器**：Execution 成功不等于 NodeRun 成功。Bridge 可能在输出契约校验或 Artifact 提交阶段把 B 标为 `failed`，此时不会创建 Checkpoint。设计新增一个只读/观察接缝：

```ts
type WorkflowNodeTerminalObserver = {
  onWorkflowNodeTerminal(input: {
    recoveryAttemptId: string
    nodeRunId: string
    status: 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_required'
    reasonCode?: string
    executionId: string
  }): void
}
```

- B `failed` → R `failed`（带节点终态原因），即使没有 Checkpoint。
- B `cancelled` → R `cancelled`。
- B `succeeded` → 仍等待 Checkpoint 结果（1B-2A 规则）。
- B `reconciliation_required` → R 保持 `running`，交给启动/运行期对账。
- 该接缝只对恢复创建的 attempt 生效，普通执行的现有行为不变。

### 7.6.1 Checkpoint 成功证明的归属校验

`CheckpointService.createForExecution` 可能返回 `existing`（同 base key 已有 valid Checkpoint）。恢复 Attempt 不能仅凭 `outcome='existing'` 或 `state='valid'` 判定成功，必须同时满足：

1. `checkpoint.executionId === execution.id`（本次恢复执行的 Execution）；
2. `checkpoint.nodeRunId === B.id`（本次新 NodeRun attempt）；
3. `checkpoint.workId === recoveryAttempt.workId`；
4. `checkpoint.state === 'valid'`；
5. Checkpoint 的 `content_hash` 校验通过（按现有 `CheckpointService` 校验路径重新计算/验证）；
6. `checkpoint.createdAt` 与 B.startedAt 的时间关系**仅作辅助校验**：明显早于 B.startedAt 时记录 warning，不单独作为接受或拒绝依据；时间戳精度/时钟偏差不得覆盖第 1/2/3/5/7/8 项的归属冲突。
7. 恢复 Attempt 自身的 `execution_id`、`session_id`、`node_run_id` 与 Execution/B 一致；
8. Checkpoint 不是旧 attempt A 的 Checkpoint，也不是其他 Workflow Run 的 Checkpoint。

**判定优先级**：

- **主判据**：`executionId`、`nodeRunId`、`workId`、RecoveryAttempt/Execution/B 关联、`content_hash`、`state='valid'`；
- **辅助判据**：`createdAt`（仅排除明显不可能的记录，容忍时钟偏差）；
- 任何主判据冲突 → 直接 `CHECKPOINT_RECOVERY_MISMATCH`；
- **不得**因为 `createdAt` 满足就接受属于其他 Execution 的 Checkpoint；
- **不得**仅因 `createdAt` 略有偏差就拒绝主判据全部匹配的 Checkpoint；记录 warning 供审计。

若现有 `getCheckpointForExecution` 不重新校验 `content_hash`，1B-2B 必须新增只读校验函数（复用 `hashCheckpointContent` 与 Checkpoint 不可变字段），校验失败即视为 `CHECKPOINT_RECOVERY_MISMATCH`。

任一项不满足：

- 恢复 Attempt `failed`，原因码 `CHECKPOINT_RECOVERY_MISMATCH`（或 `CHECKPOINT_NOT_CREATED`）；
- 写 `checkpoint.recovery_mismatch` / `workflow.node.recovery.failed` 审计，包含 Checkpoint 实际归属；
- **不得**用旧 Checkpoint 作为本次恢复成功证明；
- **不得**自动创建下一个 attempt；
- 后续恢复必须重新经过资格、风险和预算校验。

**数据库可验证性**：`task_checkpoints` 已包含 `id`、`work_id`、`execution_id`、`node_run_id`、`state`、`content_hash`、`created_at`。校验查询必须至少为：

```sql
SELECT * FROM task_checkpoints
 WHERE execution_id = :executionId
   AND node_run_id = :newNodeRunId
   AND work_id = :workId
   AND state = 'valid';
```

返回的 Checkpoint 再校验 `content_hash` 与不可变字段；若查询返回空或返回旧 attempt A 的记录，即 `CHECKPOINT_RECOVERY_MISMATCH`。不能只调用 `getCheckpointForExecution` 而不校验返回行的 `node_run_id/work_id`。

NodeRun 已成功但 Checkpoint 创建/归属校验失败时：NodeRun 保留真实成功事实；Recovery Attempt 失败；不自动重试。该语义与 1B-2A 的 Checkpoint 失败处理一致。

### 7.7 崩溃窗口矩阵

| 时间点 | 持久状态 | 收敛责任 | 结果 |
|---|---|---|---|
| T1 前 | 无 | — | 无影响 |
| T1 后、T2 前 | R=starting | 1B-2A 启动对账 | R=failed(START_INTERRUPTED)，无 B |
| T2a 归属意图已提交、`git worktree add` 未开始 | R=starting；context.worktree.state='creating'；无 Git Worktree | Worktree Reconciler → Recovery | Reconciler 持久化 abandoned；Recovery 收敛 R=failed(`WORKTREE_CREATION_INTERRUPTED`)；无孤儿 |
| T2a 已提交、`git worktree add` 进行中崩溃 | R=starting；state='creating'；可能部分路径或已注册 | Worktree Reconciler → Recovery | 若已注册/路径存在：持久化 orphan → R=failed(`WORKTREE_CREATED_UNCONFIRMED`)，保留 ownership；若不存在：abandoned → R=failed(`WORKTREE_CREATION_INTERRUPTED`)；均不复用/不自动删除 |
| T2b Git 创建成功、DB 更新为 ready 失败/退出 | R=starting；state='creating'；Git Worktree 存在 | Worktree Reconciler → Recovery | 确认 Git 存在 → orphan + R failed；不得由另一个恢复认领 |
| T2b ready 已提交、T3 未开始 | R=starting；state='ready' | Worktree Reconciler → Recovery | Reconciler 持久化 orphan；R=failed(`START_INTERRUPTED`)；不复用 |
| T2 Worktree 已创建、T3 前失败/退出 | R=starting/failed；Worktree active | T2/T3 失败路径 + Reconciler | R=failed；Worktree 记录 `worktree_orphaned`；不得复用或自动删除 |
| T3 事务内崩溃 | 数据库事务回滚 | SQLite + Worktree Reconciler → Recovery | A 不变，无 B，R=starting；Reconciler 持久化 orphan/abandoned；Recovery 再收敛 failed |
| T3 成功但 spawn 前崩溃 | A=failed；B=running；E=pending；R=running；Worktree ready | `classifyPendingStart` | `not_started`：E=failed，B→reconciliation_required，R=failed；Worktree 仍为该 R 的孤儿，不复用 |
| 同一目标第二个恢复请求 | 第二个 T1 被活跃唯一索引拒绝 | DB | 只能在第一个 R 终态后重新走 T1；不得复用第一个 R 的 Worktree |
| T3 COMMIT 后、spawn 前 | A=failed；B=running；E=pending；R=running | `classifyPendingStart` | `not_started`：E=failed(START_INTERRUPTED)，B→reconciliation_required，R=failed；`spawned`：等待执行对账；`unconfirmed`：保持显式待处理 |
| spawn 后、终态前 | B=running；E=running；R=running | 现有 Execution 对账 | 终态后走 §7.6 |
| Execution 终态、Bridge 回写前 | B=running；E=terminal；R=running | `WorkflowRecoveryService` 终态补记账 + RecoveryService | 先 Bridge 回写 B，再 Checkpoint，再 R 终态 |
| Checkpoint 创建失败 | B=succeeded；R=running | `onCheckpointResult` | R=failed；高风险阻断 |

**启动对账责任（P0）：**

> T3 失败时先尝试 §7.4.2 的即时独立事务收敛；只有即时收敛失败（数据库不可写）才留给启动对账。启动对账是兜底，不是第一责任人。

1. `WorkflowWorktreeRecoveryReconciler` 只处理 `kind='workflow_node'`、`status='starting'`、**没有** NodeRun/Execution、且 `context_manifest_json.worktree` 存在的 R。
2. `state='creating'`：用 T2a 记录的 `worktreePath`/`branchName`/owner token 做真实路径与 `git worktree list` 检查：
   - 确认存在且归属匹配 → 持久化 `state='orphaned'`、`orphanReason='WORKTREE_CREATED_UNCONFIRMED'`，审计 `worktree_orphaned`；
   - 确认不存在 → 持久化 `state='abandoned'`、`reason='WORKTREE_CREATION_INTERRUPTED'`，审计 `worktree_abandoned`；
   - **无法确认**（Git 错误、权限、路径/注册信息冲突、归属不匹配）→ 持久化 `state='needs_manual_review'`，R 保持 `starting`，审计 `worktree_manual_review`；启动进入 `recovery_locked`，不得开放业务入口。
3. `state='ready'` 但无 NodeRun/Execution → 持久化 `state='orphaned'`、`reason='START_INTERRUPTED'`，审计后交给 RecoveryService 收敛。
4. 对账更新使用 CAS：`WHERE id=? AND status='starting' AND json_extract(context_manifest_json,'$.worktree.state') = :expected`；`changes=0` → 跳过，不得重复认领或覆盖。
5. 对账本身幂等：`orphaned/abandoned` 为终态处置，重复启动只读检查，不再创建/修改资源。
6. 完成第 3 步后，第 4 步 `RecoveryService.recoverOnStartup()` 才允许把 R 收敛为 `failed`；收敛原因使用对账持久化的 `orphanReason/reason`。
7. 任何情况下不得复用、认领、覆盖或自动删除该 Worktree；清理必须经过受控孤儿资源核查。
8. `RecoveryService.recoverOnStartup()` 与 `reconcileInterruptedStarts()` 内部必须执行 §7.2 的筛选规则；不得只依赖调用顺序。

**启动顺序约束**（生产装配必须调整并保持）：

```text
1. ExecutionService.processTerminalBacklog() / discardQueuedOnStartup() / reconcile()
   → WorkdirLockService.purgeStale()（必须能读取 executions.process_id 做 CLI 存活复核）
2. WorkflowRecoveryService.recover()
   - Execution 终态补记账
   - NodeRun 对账
   - Bridge 回写
   - Checkpoint 处理
3. WorkflowWorktreeRecoveryReconciler.reconcile()
   - 检查 workflow_node 的 T2a/T2b 意图
   - 确认 Worktree 注册状态
   - 持久化 orphan / abandoned / needs_manual_review
4. RecoveryService.recoverOnStartup()
   - 收敛剩余 starting/running 恢复记录（跳过 needs_manual_review）
5. RecoveryService.reconcileInterruptedStarts()
6. WorkflowRunRecoveryCoordinator.reconcileAll()
7. 所有阶段成功后开放业务入口
```

顺序理由：如果第 4 步先执行，1B-2A 通用逻辑会把带 Worktree 意图的 R 提前终结为 failed，后续对账器只处理未终态 R，已创建的 Git Worktree 会丢失孤儿登记。必须先对账、持久化处置，再终态收敛。

**装配修正**：当前 `recoverOnStartup()` 在 Core 装配期间调用；1B-2B 必须把它移出构造期，放到启动编排第 4 步。构造期不得调用任何会终结 R 的逻辑。

**业务入口开放条件**：上述 7 步全部完成后，才允许开放正常业务 RPC/UI 入口。任何一步失败或出现 `needs_manual_review` → 进入既有 `recovery_locked`，不得开放业务入口。

不得让 workflow_node 的恢复 Attempt 在 Workflow 补记账 / Worktree 对账之前被判定为 `CHECKPOINT_NOT_CREATED` 或 `WORKTREE_CREATION_INTERRUPTED`。

---

## 8. Scheduler 与重复调度 / 重复副作用

### 8.1 Scheduler 代码零改动

新 attempt B 在 T3 事务中从 `ready` 直接 CAS 到 `running`，事务提交后 Scheduler 只能看到 `running`。Scheduler 的派发条件只有 `blocked → ready` 与 `ready → running`，因此：

- 不会为新 attempt 再次派发；
- 不会调用 `onNodeStarted` 第二次；
- 不会产生第二条 Execution（`executions.node_run_id` 唯一索引兜底）。

这不是“靠约定”，而是由三个硬约束共同保证：

1. B 提交时状态为 `running`；
2. `executions(node_run_id) WHERE node_run_id IS NOT NULL` 唯一；
3. `node_runs(workflow_run_id, workflow_node_key, attempt)` 唯一（v34 新增）。

### 8.2 旧 attempt 的可见性

- Scheduler / Control nodes 都通过 `latestAttempts` 取最大 attempt；B 一旦存在，A 不再参与下游依赖计算。
- A 被显式改为 `failed(recovery_superseded)`，保证终态 Run 不会因为 A 非终态而违反一致性。
- A 的失败不是“任务失败”，而是“被恢复替代”；下游不会因为 A 的状态被错误阻断，因为 B 是最新 attempt。

### 8.3 禁止恢复执行触发自动 retry

现有 `WorkflowExecutionBridge.retryOrFail` 会在执行失败时原子创建下一 attempt（`ready`）。对恢复执行，这会造成：

- 绕过人工确认与风险确认；
- 链预算被绕过；
- 重复副作用。

设计新增一个**只读接缝**：

```ts
type RecoveryExecutionLookup = {
  isRecoveryExecution(executionId: string): boolean
}
```

Bridge 在 `onExecutionFinished` 的失败分支先查询；若为恢复执行：

- 不调用 `retryOrFail`；
- 正常把 B 写为 `failed`（或由崩溃对账写为 `reconciliation_required`）；
- 交由 `RecoveryService.onExecutionTerminal` 收敛 R。

该接缝只读，不改变 Bridge 对普通执行的行为。普通执行的全部现有测试必须保持不变。

### 8.4 下游派发

- B `succeeded` 后，Bridge 回写并 `engine.kick(runId)`；Scheduler 正常计算下游。
- B `failed` 后，下游不会就绪（`failedPredecessors`），不会重复执行。
- B `reconciliation_required` 时，Run 停留在阻塞态，等待受控处理。

### 8.5 FairDispatcher 与并发

- FairDispatcher 只遍历 `running` Run；`reconciliation_required` Run 不参与。
- T3 将 Run 重入 `running` 后，下一次 tick 才可能派发其他分支；B 已是 `running`，不会被重复启动。
- 恢复期间不暂停其他分支：分支级隔离保持不变。

### 8.6 Worktree 与工作目录（D-9）

| 策略 | 处理 | 风险 |
|---|---|---|
| `worktree` | **1B-2B 唯一允许的恢复策略**；新 attempt 使用新 Worktree / 新分支 `agentra/<run>/<slug(nodeKey)>-<hash8>/<newAttempt>-r<chainAttemptNo>`；不复用旧 Worktree | 磁盘增长；旧 Worktree 不自动清理 |
| 共享工作目录 | **不可恢复**（`NODE_RECOVERY_WORKTREE_REQUIRED`）；不得降级复用 | 旧执行可能已产生副作用 |
| 无 repository | **不可恢复**；不得降级 | — |

**D-9 约束：**

1. 新 Worktree 必须与旧 attempt 隔离；**不得**复用旧 Worktree、覆盖旧输出、隐式合并旧改动。
2. Worktree 创建失败 → **阻止启动**（T2 失败，恢复 Attempt `failed`）；不得降级为复用旧 Worktree 或共享目录。
3. 记录 Worktree 身份：`worktreeId`、`worktreePath`、`branchName`、`baseCommit`、`gitCommonDir`、`registeredWorktreePath`、`worktreeOwnerToken`、workId、newNodeRunId、recoveryAttemptId、chainAttemptNo；写入恢复 Attempt 的 `context_manifest_json` 与 `workflow.node.recovery.started` 审计。
4. **真实路径边界**：对 Worktree root 与实际路径执行 `realpath`，用 `path.relative` 判断，结果不得为绝对路径、不得以 `..` 开头、不得为空；禁止只用字符串前缀判断。
5. **Git ref 安全**：`nodeKey` 先 slug + 稳定 hash 编码；完整分支名必须通过 `git check-ref-format --branch`；不得直接把 `nodeKey` 拼入 ref。
6. **baseCommit 属于目标仓库**：在 Work 的 `repository_path` 内验证 commit 对象存在，不从其他仓库解析引用。
7. **Git 注册一致**：`git worktree list --porcelain` 的路径/branch/HEAD、worktree 内的 `rev-parse --show-toplevel` / `symbolic-ref --short HEAD` / `rev-parse HEAD` 必须与数据库记录一致；不一致即阻止启动。
8. **唯一归属**：一个 Worktree 只属于一个 `recoveryAttemptId` 与一个预测的 `newNodeRunId`；`worktreeOwnerToken` 在 T2a 持久化，T3 必须精确匹配；其他恢复请求不得复用、认领或覆盖。
9. T3 必须重新验证 Worktree 归属（state='ready'、owner token、workId、branchName、真实路径、Git 注册、创建时间、无现有 Execution 使用）；验证失败回滚，不进入 spawn。
10. T2 创建 Worktree 后 T3 失败或进程退出 → 该 Worktree 不得被后续 attempt 复用；记录 `workflow.node.recovery.worktree_orphaned`，交由受控孤儿资源核查流程处理；**不得自动删除**。
11. 新 Worktree 不代表自动交付：新 attempt 的输出必须经过原有节点输出契约、Artifact 提交和 Workflow 终态验证；恢复适配器不得直接把输出标记为交付成功。

---

## 9. Run / Branch 收敛

### 9.1 Branch 规则

1. 恢复要求目标分支 `active`；`paused/blocked/completed/failed/cancelled` 一律阻断。
2. 恢复**从不**自动恢复或改写分支状态；暂停分支必须先由用户/现有 resume 流程恢复。
3. 恢复成功后，节点成功可能让 Join/End 正常收尾分支；由既有 Control Node 逻辑处理。
4. 恢复失败不改写分支；不做“分支自动 failed”级联（本阶段明确不做）。

### 9.2 Run 重入条件（六项，逐条可测试）

仅当 Run 为 `reconciliation_required` 时考虑重入 `running`。以下六项**必须同时满足**；任一不满足即保持 `reconciliation_required`，写 `workflow.node.recovery.run_reentry_blocked` 审计，并在 plan 的 `runReentry.blockers` 中返回稳定原因码。

| # | 条件 | 校验方式 | 不满足原因码 |
|---|---|---|---|
| 1 | 除“当前正在重入的恢复 Attempt”外，该 Work 不存在其他 `starting/running` 恢复尝试 | `task_recovery_attempts` 按 `work_id` 查询；T3 内排除当前 R | `RECOVERY_ACTIVE` |
| 2 | 所有最新 NodeRun attempt 均不处于 `reconciliation_required` | 按 `attempt=max` 取每个节点 | `NODE_RECONCILIATION_PENDING` |
| 3 | 不存在 `unconfirmed` 执行证据；所有 `pending/running` Execution 均已由 Daemon 确认为存活或已由对账收敛（排除当前恢复 R 绑定的新 Execution） | 复用 1B-2A 的 `classifyPendingStart` / Daemon 证据 | `EXECUTION_UNCONFIRMED` |
| 4 | 不存在 `waiting_approval` 节点 | NodeRun 最新 attempt 查询 | `WAITING_HUMAN`（状态机不允许 `reconciliation_required → waiting_human`，只能保持阻塞） |
| 5 | 不存在“未绑定有效恢复、且未收敛”的遗留 `pending` Execution；绑定到当前 R 的新 Execution 除外 | 按 `executions.status='pending'` 与 `task_recovery_attempts.execution_id` 对账 | `PHANTOM_PENDING_EXECUTION` |
| 6 | 目标节点所属 Branch 为 `active`；若所有分支均已终态，**不做重入**（状态机不允许 `reconciliation_required → completed`，留给终态/人工处理） | BranchRun 查询 | `BRANCH_NOT_ACTIVE` |

满足后：

1. `reconciliation_required → running`；
2. 审计 `workflow.node.recovery.run_reentered`；
3. 由 Coordinator 触发 `engine.kick(runId)`；
4. 重入是**状态迁移**，不是恢复启动；不得改变 NodeRun / Branch 状态。

**“有效恢复绑定”定义（条件 5）**：`pending` Execution 必须同时满足：

- `execution.node_run_id` 非空，且该 NodeRun 属于当前 Workflow Run；
- 存在 `task_recovery_attempts` 行 R，`kind='workflow_node'`，且 `R.execution_id = execution.id`、`R.node_run_id = execution.node_run_id`、`R.workflow_run_id = run.id`；
- `R.status IN ('starting','running')`（终态 R 不得继续持有 pending Execution）；
- `R.recovered_node_run_id` 属于同一恢复链，且 `R.chain_attempt_no` 在 1..3；
- Execution 状态仍为 `pending`，未被 Daemon 判定为 spawned。

不满足任一项 → 视为“未绑定有效恢复的遗留 pending Execution”，阻断重入。

任一项依赖的数据在事务中被并发改走 → CAS 失败，保持 `reconciliation_required`，不得重试覆盖。

### 9.2.1 Run 重入后的 Scheduler 幂等边界

Run 重入只解除 Run 的对账阻塞，**不是重新执行**。必须锁定：

1. **使用现有幂等入口**：Coordinator 只调用 `WorkflowEngine.kick(runId)` / Scheduler 现有 `tick`，不得调用 `runService.createRun`、`startRun` 或任何新建 Run 的入口。
2. **只处理原有执行资格**：Scheduler 仍只做 `blocked → ready → running`；不得为已 `running/succeeded/failed/cancelled/skipped` 的节点重新创建 attempt。
3. **不新建资源**：Run 重入后的 kick 不得创建 NodeRun attempt、Session、Artifact；Execution 只能由既有 `ready → running` 的正常派发创建。
4. **不重复副作用**：已 running 的节点不会被再次派发；已完成节点不会重跑；失败节点不会因 kick 自动重试。
5. **重入前一致性检查**：Coordinator 在 `reconciliation_required → running` 前执行 Run 范围一致性检查：
   - 每个节点最新 attempt 唯一；
   - `running` 节点恰有一条非终态 Execution；
   - 终态节点没有非终态 Execution；
   - 不存在 `reconciliation_required` 节点；
   - 不存在未绑定的 `pending` Execution；
   - 所有 NodeRun 的 `branch_run_id` 属于同一 Run。
   任一失败 → 不迁移、不 kick，保持 `reconciliation_required`，写 `run_reentry_blocked` 审计。
6. **重复 kick 安全**：`kick` 可重复调用；重复调用不得产生第二个 attempt/execution/artifact。
7. **kick 失败**：Run 可保持 `running`，由下一次对账/显式重试继续；不得回滚成 `reconciliation_required` 并丢弃已完成派发。
8. **无法确认即阻塞**：Coordinator 无法证明状态一致时，必须维持阻塞，不得“强制 kick”。

### 9.3 收敛矩阵

| Run 状态 | 目标节点处理结果 | 动作 |
|---|---|---|
| `running` | 恢复成功 | 不迁移 Run；B succeeded；既有 kick 推进下游 |
| `running` | 恢复失败 | Run 保持 `running`；B failed；下游不就绪；审计 |
| `reconciliation_required` | 恢复成功，且无其他待对账节点 | §9.2 重入成功 |
| `reconciliation_required` | 恢复成功，但仍有其他待对账节点 | Run 保持；等待逐个恢复 |
| `reconciliation_required` | 恢复失败 | 若 §9.2 条件满足 → 重入 `running`（B 已终态，其他分支可继续）；否则保持 |
| `reconciliation_required` | 启动中断（B→reconciliation_required） | Run 保持；R failed；允许再次恢复 |
| `paused` / `waiting_human` | 任意 | 不恢复；先走既有恢复/审批流程 |
| 终态 | 任意 | 拒绝 |

### 9.4 恢复失败后的可恢复性（决策 D-6）

- 恢复执行失败后，B 为 `failed`；这是终态，无出边。
- 若允许再次恢复，目标是 B（最新 attempt），新 attempt C = `max+1`。
- 仅当 B 由恢复创建、其 R 已 `failed`、链预算未耗尽时允许。
- 旧 attempt A 已 `failed(recovery_superseded)`，不再改写。
- 若 CTO 选择不允许再次恢复，则 §5.2 删除“条件式 failed”，链预算退化为“每次崩溃最多一次显式恢复”，需明确记录。

### 9.5 取消

- Work / Run 取消继续走既有 `syncWorkState`：取消节点、分支、Run、待审批。
- 1B-2B 增加观察：当恢复执行被取消时，R 收敛为 `cancelled`；不得在 Run 终态后创建新恢复。
- 不新增进程杀死语义；是否终止 CLI 仍由既有执行/取消路径决定。

---

## 10. RPC 契约（设计，不实施）

### 10.1 `workflow.node.recovery.plan`

请求：

```ts
{
  workflowRunId: string
  nodeRunId: string
  checkpointId?: string
}
```

响应（要点）：

```ts
{
  target: {
    workflowRunId: string
    branchRunId: string | null
    branchKey: string | null
    nodeKey: string
    nodeRunId: string
    attempt: number
    status: string
    recoveryChainId: string
  }
  eligibility: {
    status: 'eligible' | 'conditional' | 'blocked'
    planOnly: true
    reasonCodes: string[]
    riskLevel: 'low' | 'medium' | 'high' | null
    evidenceStatus: string | null
    sideEffectCompleteness: string | null
    executionEvidence: 'not_started' | 'terminal' | 'active' | 'unconfirmed'
    requiresRiskAcknowledgement: boolean
  }
  checkpoint: {
    id: string
    seq: number
    kind: string
    isLatest: boolean
    nodeRunId: string | null
  } | null
  limits: {
    maxAttempts: 3
    attemptsUsed: number
    remainingAttempts: number
    activeRecoveryAttemptId: string | null
  }
  nextAttempt: { attempt: number; branchRunId: string | null }
  worktree: {
    required: true
    policy: 'worktree' | 'shared'
    branchNamePreview: string | null
    blockers: string[]
  }
  chain: { key: string; attemptNo: number; attemptsUsed: number }
  runReentry: { required: boolean; allowed: boolean; blockers: string[] }
  contextBudget: { totalChars: number; trimmed: { p1: boolean; p2: boolean; p3: boolean } }
  sections: { p0: string; p1: string; p2: string; p3: string } | null
}
```

### 10.2 `workflow.node.recovery.start`

请求：

```ts
{
  workflowRunId: string
  nodeRunId: string
  checkpointId?: string
  confirm: true
  acknowledgeRisk?: boolean
  idempotencyKey: string   // 1..200 字符
  actorType?: 'user' | 'agent' | 'system'
  actorId?: string | null
}
```

响应：

```ts
{
  recoveryAttemptId: string
  status: 'running' | 'failed' | 'succeeded' | 'cancelled'
  newNodeRunId: string
  executionId: string
  sessionId: string
  idempotentReplay: boolean
}
```

### 10.3 错误码

| 错误码 | 含义 |
|---|---|
| `NODE_RECOVERY_CONFIRMATION_REQUIRED` | `confirm !== true` |
| `NODE_RECOVERY_NOT_FOUND` | Run / NodeRun 不存在 |
| `NODE_RECOVERY_TARGET_NOT_LATEST` | 目标不是最新 attempt |
| `NODE_RECOVERY_TARGET_NOT_RECOVERABLE` | 状态不在 §5.2 |
| `NODE_RECOVERY_TARGET_CHANGED` | T3 前状态被并发改走 |
| `NODE_RECOVERY_NODE_TYPE_UNSUPPORTED` | 非 `agent_task` |
| `NODE_RECOVERY_RUN_STATE_INVALID` | Run 状态不允许 |
| `NODE_RECOVERY_WORK_STATE_INVALID` | Work 非 active |
| `NODE_RECOVERY_BRANCH_NOT_ACTIVE` | 分支非 active |
| `NODE_RECOVERY_EXECUTION_ACTIVE` | 目标仍有非终态执行 |
| `NODE_RECOVERY_EXECUTION_UNCONFIRMED` | 执行证据不可确认 |
| `NODE_RECOVERY_DAEMON_UNAVAILABLE` | Daemon 不可用，无法启动 |
| `NODE_RECOVERY_CHECKPOINT_NOT_FOUND` | 无可用基线 Checkpoint |
| `NODE_RECOVERY_CHECKPOINT_INVALID` | 指定 Checkpoint 不合法 |
| `NODE_RECOVERY_LIMIT_REACHED` | 链预算已用尽 |
| `NODE_RECOVERY_ACTIVE_EXISTS` | 已有进行中恢复 |
| `NODE_RECOVERY_ASSIGNMENT_UNRESOLVED` | Assignment 无法解析 |
| `NODE_RECOVERY_ATTEMPT_CONFLICT` | 新 attempt 编号冲突 |
| `NODE_RECOVERY_WORKTREE_REQUIRED` | 节点策略不是 worktree / 无 repository，1B-2B 不可恢复 |
| `NODE_RECOVERY_WORKTREE_CONFLICT` | 无法生成唯一的新恢复 Worktree 分支名 |
| `NODE_RECOVERY_WORKTREE_INVALID` | T3 验证 Worktree 归属/状态/路径失败 |
| `NODE_RECOVERY_CHAIN_MISMATCH` | A0 的 Run/Work/节点与请求不一致，或跨 Run 包装链 |
| `NODE_RECOVERY_IDEMPOTENCY_CONFLICT` | 幂等键已用于其他目标 |
| `RECOVERY_REQUIRED` | 高风险 Checkpoint 失败阻断（沿用 1B-2A） |

### 10.4 协议与权限

- 两个方法为纯增量 RPC；不改变现有方法参数。是否需要提升 `PROTOCOL_VERSION` 按现有协议规则单独确认；本设计不预设。
- RPC 必须走现有权限判定（`rpc-policy`）；未授权 actor 拒绝，错误码稳定。
- `plan` 归类为只读；`start` 归类为写操作，必须 `confirm=true`，高风险额外 `acknowledgeRisk=true`。
- 不暴露 Session 的通用创建/恢复/管理方法；Session 只能由内部执行路径创建。
- `start` **不接受客户端提供的 `worktreeId` / `worktreePath` / `branchName`**；隔离 Worktree 只能由 Core 在 T2 创建并记录，客户端无法指定或复用旧 Worktree。
- 本阶段不提供 Desktop UI；入口后续批次授权。

---

## 11. ContextBuilder 与恢复 Prompt

复用 1B-2A 的 `ContextBuilder.buildRecoveryPrompt`，增加一个 Workflow 节点段，不改变普通执行 Prompt。

### 11.1 P0（必须保留）

- 恢复目标：Work / Run / 节点 key / 旧 attempt / 新 attempt / 分支。
- 原始任务 Prompt（`node.config.taskPrompt`）。
- Checkpoint 摘录：已完成事实、验收标准、风险等级、证据状态。
- 明确禁令：不得重做已完成的副作用；不得修改已完成节点的交付物；不得绕过审批；遇到不确定必须停下报告。

### 11.2 P1-P3

- P1：上游节点最新成功 attempt 的 output 摘要与 Artifact 引用（不是聊天文本）。
- P2：Checkpoint 文件/测试证据摘要、失败原因、日志摘录（截断）。
- P3：任务记忆、团队消息摘要（如适用）。

### 11.3 预算与截断

- 沿用 1B-2A 的 Context 预算与 `trimmed` 标记。
- Workflow 节点段优先于 P3；预算不足时先裁剪 P3、再 P2，P0 与节点段不可裁剪。
- 任何内容缺失都必须在 Prompt 中显式标注“未知/未提供”，不得猜测。

---

## 12. 审计与可观测性

| 审计 action | 时机 | 关键字段 |
|---|---|---|
| `workflow.node.recovery.started` | T3 COMMIT 后 | runId, branchRunId, nodeKey, recoveredNodeRunId, newNodeRunId, recoveryAttemptId, executionId, worktreeId, branchName, checkpointId, chainAttemptNo, riskLevel |
| `workflow.node.recovery.succeeded` | R 成功 + Checkpoint 归属校验通过 | 同上 + checkpointId, checkpointExecutionId, checkpointNodeRunId |
| `workflow.node.recovery.failed` | R 失败 | 同上 + reasonCode, checkpointId? |
| `workflow.node.recovery.start_failed` | T2/spawn 失败 | 同上 + stage, error message |
| `workflow.node.recovery.start_unconfirmed` | 启动证据不可确认 | 同上 + evidence |
| `workflow.node.recovery.superseded` | 旧 attempt 被替代 | 旧 attempt、新 attempt、recoveryAttemptId |
| `workflow.node.recovery.worktree_orphaned` | T2 创建后 T3/spawn 失败或进程退出 | worktreeId, branchName, path, recoveryAttemptId, chainAttemptNo, orphanReason |
| `workflow.node.recovery.worktree_abandoned` | T2a 意图存在但 Git 确认未创建 | worktreeId, path, recoveryAttemptId, reason |
| `workflow.node.recovery.worktree_manual_review` | Git 状态/归属无法确认 | worktreeId, path, recoveryAttemptId, evidence |
| `workflow.node.recovery.worktree_owner_mismatch` | T3 owner token / predicted attempt / Worktree 归属不匹配 | expected/actual recoveryAttemptId, ownerToken, predictedNewNodeRunId |
| `workdir.lock_acquired` | spawn 前获取锁 | executionId, workId, canonicalPath, holderPid, holderStartedAt, holderKind |
| `workdir.lock_released` | Execution 终态且进程确认退出后释放 | executionId, canonicalPath |
| `workdir.lock_reclaimed` | purgeStale 确认 CLI 退出 + Execution 终态后回收 | executionId, canonicalPath, holderPid, bootUuid |
| `workdir.lock_retained_alive` | CLI/Core 仍存活，锁保留（含 Boot UUID 变化） | executionId, canonicalPath, holderPid, processId |
| `workdir.lock_manual_review` | Execution 缺失/身份不可确认/CLI 状态未知 | executionId, canonicalPath, reason |
| `workflow.node.recovery.t3_failure_converged` | T3 回滚后独立事务收敛成功 | recoveryAttemptId, worktreeId, orphanReason |
| `workflow.node.recovery.t3_failure_convergence_failed` | 独立事务也无法收敛 | recoveryAttemptId, error |
| `checkpoint.recovery_mismatch` | Checkpoint 不属于本次恢复 | checkpointId, expected/actual executionId/nodeRunId |
| `workflow.node.recovery.chain_mismatch_blocked` | A0 Run/Work/节点不匹配 | recoveredNodeRunId, requestedRunId, actualRunId |
| `workflow.node.recovery.run_reentered` | Run 重入 | runId, blockers resolved |
| `workflow.node.recovery.run_reentry_blocked` | 条件不满足 | runId, blockers, consistencyIssues |
| `workflow.node.recovery.exhausted` | 链预算用尽 | chainId, attemptsUsed |

结构化日志要求：每次 start/T3/终态记录 `runId`、`nodeRunId`、`recoveryAttemptId`、`executionId`；不得记录 Prompt 全文、密钥或工具凭据。

---

## 13. 幂等与并发

### 13.1 约束

| 约束 | 层 | 作用 |
|---|---|---|
| `UNIQUE(work_id, idempotency_key)` | DB | 请求重放 |
| `UNIQUE(work_id, dedupe_key)` | DB | 同一恢复事实只落一次 |
| `UNIQUE(recovered_node_run_id, chain_attempt_no)`（workflow） | DB | 链预算 3 次，跨 Run 全局 |
| 每链一个活跃恢复 | DB 部分索引 | 防并发恢复 |
| 每个 Work 一个活跃恢复 | DB 部分索引（沿用） | 防跨链并发 |
| `node_runs(run, key, attempt)` 唯一 | DB | 防重复 attempt |
| `executions(node_run_id)` 唯一 | DB（现有） | 防重复执行 |
| `reconciliation_required → failed` CAS | DB | 防两个恢复同时收敛旧 attempt |
| `starting → running` CAS | DB | 防 T3 重复提交 |

**并发防线分三层，缺一不可：**

1. 服务层预检查只用于快速失败与友好错误，**不是**并发保障；
2. T1/T3 使用 `BEGIN IMMEDIATE`，串行化写事务；
3. 数据库部分唯一索引是最终权威。

跨进程（即使未来出现第二个 Core/第二个进程）两个 `start` 同时到达时，只有一个能插入活跃恢复行并完成 T3；另一个必须收到 `NODE_RECOVERY_ACTIVE_EXISTS` 或 `NODE_RECOVERY_TARGET_CHANGED`。禁止以“先查询再创建”作为唯一保障。数据库唯一约束冲突必须映射为稳定业务错误码，不得把 SQLite 原始错误暴露给客户端。

### 13.2 幂等语义

- 同一个 `idempotencyKey` 重放：
  - 若记录的 `workflow_run_id` / `recovered_node_run_id` 与请求一致 → 返回原结果，`idempotentReplay=true`。
  - 若不一致 → `NODE_RECOVERY_IDEMPOTENCY_CONFLICT`。
- 重放不重新创建 NodeRun/Execution，不重新 spawn。
- 相同目标但不同幂等键：
  - 若已有活跃恢复 → `NODE_RECOVERY_ACTIVE_EXISTS`；
  - 若已终态且预算未耗尽 → 允许新的链尝试（chain_attempt_no+1）。

### 13.2.1 恢复链身份与预算（D-6）

- **Chain identity = 原始目标 NodeRun ID（A0，全局唯一）**；所有后续恢复保持 `recovered_node_run_id = A0.id`。
- 恢复 B 时，从 `task_recovery_attempts.node_run_id = B.id` 的记录反查其 `recovered_node_run_id`，继续沿用 A0，不得把 B 当作新链起点。
- **跨 Run 不可重置**：`plan/start` 必须验证 `A0.workflow_run_id = input.workflowRunId` 且 `A0.workflow_node_key` 与目标节点一致；若 A0 被包装到另一个 Run 或另一个恢复请求中，直接拒绝 `NODE_RECOVERY_CHAIN_MISMATCH`。
- 数据库唯一索引为 **`(recovered_node_run_id, chain_attempt_no) WHERE kind='workflow_node'`**；它不依赖 `workflow_run_id`，因此新建 Workflow Run 或更换 Run 无法重置预算。
- **预算按链累计**：`countByRecoveredNodeRun(recoveredNodeRunId)` 统计该链所有状态（含 `starting`、`failed`、`cancelled`）的行；`chain_attempt_no` 从 1 开始，最大 3，数据库 CHECK 约束为 1..3。
- **每次 `start` 成功插入 T1 行即计数，失败不返还**；不允许通过更换 Checkpoint、幂等键、NodeRun attempt、Workflow Run 或新建 RecoveryAttempt 绕过。
- **编号分离**：`attempt_no` 为所选 Checkpoint 维度的恢复账本编号（1B-2A 语义）；`chain_attempt_no` 为链预算编号。两者不相等、不互相推导；Team/Work/generic 的 `attempt_no` 不受影响，workflow 的 `chain_attempt_no` 也不影响其 `attempt_no`。
- 预算耗尽的链：`plan` 返回 `NODE_RECOVERY_LIMIT_REACHED`；`start` 拒绝；不得自动重置。
- 服务层计数与数据库唯一索引必须一致；索引冲突映射为稳定错误码，不暴露 SQLite 原始错误。

### 13.2.2 Worktree 归属与并发（P0-2）

- **一资源一归属**：一个 Worktree 只能属于一个 `recoveryAttemptId` 与一个预测的 `newNodeRunId`。
- T1 的活跃恢复唯一索引（每 Work / 每链）保证同一目标同时只有一个 R 能进入 T2。
- T2a 在任何文件系统操作之前写入 `worktreeOwnerToken`、`recoveryAttemptId`、预测 `newNodeRunId`、`branchName`、`worktreePath`；写入使用 `BEGIN IMMEDIATE` + CAS（`status='starting'` 且 `context_manifest_json.worktree` 为空），失败即不得创建 Worktree。
- T2b 创建后验证真实路径、Git ref、baseCommit、Git 注册信息；写入 `state='ready'`。
- T3 精确匹配 owner token、predicted newNodeRunId、worktreeId、branchName/path、Git 身份；任何不匹配即回滚。
- 数据库约束：
  - `worktrees.worktree_path` 唯一（现有）；
  - `worktrees(work_id, branch_name) WHERE status='active'` 唯一（v34 新增）；
  - `task_recovery_attempts` 活跃恢复唯一索引（现有/新增）。
- T3 失败或进程退出后，Worktree 保持原 R 的孤儿身份；其他 R 不得复用、认领、覆盖。
- 创建成功但 T2b 未登记、`git worktree add` 已成功但 DB 未更新、T2b ready 后未进入 T3 等窗口，均按 §7.7 的启动对账规则处理；不得自动删除。

### 13.3 并发场景

| 场景 | 结果 |
|---|---|
| 两个 start 同时到达 | 一个 T3 成功；另一个 CAS `starting` 或旧 attempt 失败 → 回滚 + 明确错误 |
| 两个恢复请求同时进入 T2 | T1 活跃唯一索引只允许一个；另一个在 T1 失败，不能创建 Worktree |
| 两个恢复请求都持有 T2 Worktree | 不可能；若发生，T3 owner token / predicted newNodeRunId 只匹配一个，另一个回滚 |
| T2b 创建后、T3 前崩溃 | Worktree 保持原 R 的孤儿身份；新 R 不得认领，创建自己的新 Worktree |
| T3 时 Worktree 被替换/路径被改 | owner token 或 Git 身份校验失败 → 回滚 |
| start 与 Run 暂停并发 | 若 Run 在 T3 前变 paused，T3 回滚；若 T3 后暂停，恢复执行由既有 pause 策略处理，R 保持 |
| start 与 Work 取消并发 | 取消优先；不允许在终态 Work 上创建恢复 |
| start 与 Scheduler tick 并发 | B 提交即 `running`；Scheduler 不会派发；无重复执行 |
| 双 Core 进程 | 现有单实例假设不变；`BEGIN IMMEDIATE` + 部分唯一索引兜底；测试必须证明跨连接只有一个恢复成功 |

---

## 14. 测试矩阵（实施阶段必须全部覆盖）

### 14.1 资格与 Plan

1. `plan` 对 `reconciliation_required` 的 `agent_task` 返回 eligible。
2. `plan` 拒绝非最新 attempt。
3. `plan` 拒绝控制节点（start/split/join/condition/human_approval/end）。
4. `plan` 拒绝 `running` / `ready` / `blocked` / `waiting_approval` / `paused` / 终态。
5. `plan` 拒绝 paused/blocked/completed 分支。
6. `plan` 拒绝 paused/completed/cancelled Work。
7. `plan` 拒绝目标节点仍有 `pending/running` Execution。
8. `plan` 拒绝 unconfirmed 执行证据。
9. `plan` 在无有效 Checkpoint 时返回 `NODE_RECOVERY_CHECKPOINT_NOT_FOUND`。
10. `plan` 对高风险 Checkpoint 返回 `requiresRiskAcknowledgement=true`。
11. `plan` 在链预算 3 次后返回 `NODE_RECOVERY_LIMIT_REACHED`。
12. `plan` 在已有活跃恢复时返回 `NODE_RECOVERY_ACTIVE_EXISTS`。

### 14.2 Start 与事务

13. start 创建：A `reconciliation_required → failed(recovery_superseded)`；B `attempt=max+1` 且 `running`；恰好一条新 Session、一条新 Execution；R `running`。
14. B 从未以 `ready` 出现在事务外（可在 T3 内断言）。
15. T3 任一步失败：A 保持原状态；无 B、无 Session、无 Execution；R 不进入 running。
16. `confirm=false` 拒绝；高风险未 `acknowledgeRisk` 拒绝。
17. 相同幂等键重放返回同一 R/B/E，不新增行。
18. 不同目标复用幂等键返回 `NODE_RECOVERY_IDEMPOTENCY_CONFLICT`。
19. 两个并发 start 只有一个成功。
20. 旧 attempt 永不被写为 succeeded。

### 14.3 Scheduler 与重复副作用

21. T3 后立即 `scheduler.tick` 不会启动 B，也不会创建第二条 Execution。
22. B 成功后下游只派发一次。
23. B 失败后下游不就绪。
24. 恢复执行失败不创建 `attempt+1` 的 `ready` 行（验证 Bridge 接缝）。
25. 普通执行失败仍按原 `retryPolicy` 创建下一 attempt（回归）。
26. 并行分支的活跃 Execution 不会阻断目标节点恢复。
27. worktree 策略为新 attempt 创建新分支，不复用旧 Worktree。

### 14.4 崩溃与对账

28. T1 后崩溃 → R failed(START_INTERRUPTED)，无 B。
29. T3 提交后、spawn 前崩溃且确认未启动 → E failed，B `reconciliation_required`，R failed；可再次恢复 B。
30. T3 提交后、spawn 前证据不可确认 → 保持显式待处理，不重复执行。
31. spawn 后、终态前崩溃 → 既有 Execution 对账；B 终态；R 终态；无自动 retry。
32. Execution 成功、Bridge 回写前崩溃 → 启动后先补记账 B succeeded，再收敛 R succeeded。
33. Execution 成功、Checkpoint 失败 → R failed；B 保持 succeeded；高风险继续阻断。
34. 启动顺序（Execution → Workflow → Worktree Reconciler → Recovery → Coordinator）有集成测试。
35. workflow_node 的 R 在 Execution 成功、Checkpoint 尚未创建时，启动对账不会误判 `CHECKPOINT_NOT_CREATED`。
36. `recoverOnStartup()` 对**没有 Worktree 意图**的无 Execution `starting` workflow_node R 可收敛为 `START_INTERRUPTED`；有 Worktree 意图时跳过（见 102）。

### 14.5 Run / Branch 收敛

37. Run `reconciliation_required`，唯一待对账节点恢复成功 → Run 重入 `running` 并 kick。
38. 仍有其他待对账节点 → Run 保持。
39. Run `reconciliation_required`，恢复失败且无其他待对账节点 → Run 重入 `running`，B failed。
40. Run `waiting_human` / `paused` → 恢复拒绝。
41. 分支暂停 → 恢复拒绝，且不自动 resume。
42. 恢复过程中 Work/Run 取消 → R cancelled，不创建新恢复。

### 14.6 一致性与迁移

43. 每个场景结束后 `checkWorkflowConsistency` 无 issue。
44. v34 迁移：0 行表迁移成功；有数据表逐行复制一致；重复 `(run,key,attempt)` 时迁移失败。
45. `PRAGMA foreign_key_check` 为空。
46. 1B-2A 全部既有测试通过（Team / Work / generic、崩溃、幂等、Checkpoint）。

### 14.7 节点终态与 Checkpoint 分离

47. Execution 成功但 B 因输出契约违规 `failed`：R failed，无 Checkpoint，不误判成功。
48. Execution 成功但 B 因 Artifact/Output 提交失败 `failed`：R failed，审计原因正确。
49. B `cancelled`：R cancelled，不创建新恢复。
50. B `failed` 且无 Checkpoint 时，Run 收敛协调器仍能执行重入判断。

### 14.8 CTO 条件批准项回归

51. 旧执行仍 `active` → 拒绝 supersede，不创建 B。
52. 旧执行 `unconfirmed` → 拒绝 supersede，不创建 B。
53. T3 任一步失败：旧 attempt 状态、B、Session、Execution、RecoveryAttempt 全部回滚，无部分提交。
54. 两个独立数据库连接同时 start 同一目标：只有一个成功，另一个收到稳定并发错误；活跃恢复行只有一条。
55. 链预算不可绕过：更换 Checkpoint、幂等键或 NodeRun attempt 后第 4 次仍返回 `NODE_RECOVERY_LIMIT_REACHED`。
56. Worktree 创建失败 → 不创建 Session/Execution，R failed，不降级复用旧 Worktree。
57. Worktree 身份与 recovery chain 关联写入 `context_manifest_json` 与审计。
58. 恢复输出仍走节点输出契约 / Artifact 提交；契约失败 → B failed、R failed，不自动交付。
59. plan 与 start 之间状态被改走 → start 重新校验并拒绝，不信任客户端计划。
60. `WorkflowNodeTerminalObserver` 重复终态事件不会重复完成 R、不会重复触发副作用。
61. 进程在“Execution 成功、Workflow 未补记账”阶段退出 → 重启后先补记账，R 不误判 `CHECKPOINT_NOT_CREATED`。
62. 进程在“Workflow 已补记账、Checkpoint 未创建”阶段退出 → 重启后收敛到一致状态。
63. 进程在“Checkpoint 已创建、R 未收敛”阶段退出 → 重启后 R succeeded。
64. RPC 权限：未授权 actor 不能 plan/start；不暴露 Session 通用管理接口。
65. v34 迁移：v33 数据逐行保留到 v34；迁移前一致性备份存在；模拟失败可回滚；迁移后不残留带外键的库内备份表。

### 14.9 CTO 复审补充项回归

66. `startRecoveryForNode` 的 `worktreeId` 为必填；缺失、空串或非字符串 → 拒绝，且不进入 T3。
67. T3 拒绝旧 attempt 的 Worktree、其他 Work 的 Worktree、非 active Worktree、branchName/path 不匹配的 Worktree。
68. T3 验证 Worktree 时不信任客户端字段，只信任 T2 持久化的 `context_manifest_json.worktree`。
69. Worktree 创建失败 → R failed，无 NodeRun/Execution，不降级复用。
70. T3/spawn 失败后的 Worktree 记录 `worktree_orphaned`，不被后续 attempt 复用，不自动删除。
71. Run 重入后 `engine.kick` 不创建新 NodeRun/Session/Execution/Artifact；重复 kick 安全。
72. Run 重入前一致性检查失败 → 不迁移、不 kick，保持 `reconciliation_required`。
73. 重入后已 running/succeeded/failed 节点不被重新派发或自动重试。
74. Checkpoint `existing` 但 `execution_id/nodeRunId/createdAt` 不属于本次恢复 → R failed `CHECKPOINT_RECOVERY_MISMATCH`。
75. 旧 attempt A 的 valid Checkpoint 不得作为 B 的成功证明。
76. Checkpoint content_hash 校验失败 → R failed，不自动创建下一 attempt。
77. A0 的 Run/Work/节点与请求不一致 → `NODE_RECOVERY_CHAIN_MISMATCH`，不创建链。
78. 尝试用另一个 Workflow Run 包装同一 A0 → 仍被链唯一索引/身份校验拒绝，预算不重置。
79. `attempt_no` 与 `chain_attempt_no` 独立：更换 Checkpoint 不改变链预算；更换 NodeRun attempt 不改变 `attempt_no` 语义。
80. v34 迁移：有触发器时完整重建；全字段逐列比较（含 NULL/默认值/JSON 原文）；外部备份存在；真实 SQLite 版本下 RENAME/索引/外键/回滚测试通过。

### 14.10 第三轮 CTO 复核补充项

81. Worktree 路径位于 root 内但通过符号链接逃逸 → `realpath` 后 `path.relative` 拒绝。
82. 字符串前缀相同但并非子目录（如 root `/a/wt`、路径 `/a/wt-evil`）→ 拒绝。
83. `nodeKey` 含 Git ref 非法字符 → slug+hash 编码后通过 `git check-ref-format --branch`；未编码直接拼接的路径不存在。
84. `baseCommit` 只在其他仓库可解析、在目标 Work 仓库不存在 → 拒绝。
85. `git worktree list --porcelain` 的路径/branch/HEAD 与数据库记录不一致 → 拒绝。
86. Worktree 内 `rev-parse --show-toplevel`、`symbolic-ref --short HEAD`、`rev-parse HEAD` 任一不匹配 → 拒绝。
87. 同一 Work 的 active Worktree 分支唯一索引阻止重复创建；迁移前重复数据导致迁移失败。
88. 两个并发恢复请求：只有第一个 T1 成功；第二个在 T1 被活跃唯一索引拒绝，不能进入 T2。
89. 即使两个请求都进入 T2，owner token / predicted newNodeRunId 只允许一个进入 T3；另一个回滚。
90. 归属令牌不匹配、predicted newNodeRunId 不一致、worktreeId 被替换 → T3 拒绝。
91. T2a 后、`git worktree add` 前崩溃 → R failed `WORKTREE_CREATION_INTERRUPTED`，无孤儿，不复用。
92. `git worktree add` 成功后、T2b 记录前崩溃 → R failed `WORKTREE_CREATED_UNCONFIRMED`，Worktree 保留为原 R 的孤儿，不自动删除、不被新 R 认领。
93. T2b ready 后、T3 前崩溃 → R failed `START_INTERRUPTED`，Worktree 孤儿；新恢复创建新 Worktree。
94. Checkpoint 身份字段全部匹配、`createdAt` 仅有轻微时钟偏差 → 接受并记录 warning，不误拒。
95. Checkpoint `createdAt` 满足但 `executionId/nodeRunId` 属于旧 attempt → 仍拒绝 `CHECKPOINT_RECOVERY_MISMATCH`。
96. T2a CAS：两个并发写入只有一个 `changes=1`；另一个回滚，不生成第二个 owner。
97. 同一 `idempotencyKey` 重放不创建第二个 Worktree、不重跑 T2b/T3，返回原 R 状态。
98. T2b CAS：state/owner token 不匹配时不得写入 ready，不得认领孤儿。
99. spawn 前 Workdir 锁获取失败 → 不 spawn，按启动失败收敛，锁不泄漏。
100. spawn 前最终复核发现 realpath/Git/HEAD 变化 → 不 spawn，R failed，锁释放。
101. Workdir 锁在 Execution 终态前保持；成功/失败/取消均正确释放。

### 14.11 第四轮 CTO 复核补充项

102. `RecoveryService.recoverOnStartup()` 遇到 `kind='workflow_node'` 且存在 Worktree 意图的 R → 跳过，不提前终态。
103. `reconcileInterruptedStarts()` 同样跳过 Worktree 意图未处置的 R。
104. Worktree Reconciler 在 recoverOnStartup 之前执行：state='creating' + Git 已注册 → 持久化 orphan 后再由 Recovery 收敛 failed。
105. state='creating' + Git 确认不存在 → 持久化 abandoned 后再收敛 failed。
106. Git 状态无法确认 → state='needs_manual_review'，R 保持 starting，启动进入 recovery_locked，不开放业务入口。
107. Worktree 对账重复启动幂等：orphan/abandoned 不被重复认领、覆盖或重复审计成功。
108. T3 在 Session 插入后抛错 → A 原状态、B/Session/Execution 不存在、R 仍 starting。
109. T3 在 Execution 插入后抛错 → 同上。
110. T3 在 R starting→running 后抛错 → 同上。
111. `startRecoveryForNode` 收到非事务上下文 → 拒绝；T3 内无 spawn/git/fs/网络调用。
112. T3 COMMIT 后 spawn 才执行；spawn 不属于 T3 事务。
113. Workdir 锁 key 使用 realpath；符号链接路径与原始 path 不一致时拒绝。
114. spawn 后 holder_pid 更新为 CLI PID；Core 已死但 CLI 存活 → 锁保留，不回收。
115. `releaseByExecution` 幂等且只删除该 executionId 的锁；取消/超时未确认进程退出时保留锁并进入 reconciliation。
116. `purgeStale()` 在 Execution reconcile 之后运行，能识别终态/非终态 Execution 的 process_id。

### 14.12 第五轮 CTO 复核补充项

117. Boot UUID 不同但 CLI 仍存活 → `purgeStale` 保留锁，不得回收。
118. 锁关联 Execution 不存在 → 保留锁 + `manual_review`，不回收。
119. Execution 非终态、CLI 已退出 → 先不回收，等 Execution 对账收敛后再 purge。
120. Execution 终态、CLI 已确认退出 → 回收锁。
121. Execution 终态、CLI 仍存活 → 保留锁并告警。
122. PID 相同但启动标识不同（PID 复用）→ 仅在 Execution 终态且确认原进程退出后回收；否则保留。
123. 进程身份读取失败 → 保留锁 + `manual_review`。
124. T3 失败且数据库可写 → 独立事务立即将 R failed、Worktree orphaned/abandoned；活跃索引释放。
125. T3 失败且数据库不可写 → R 保持 starting；新恢复请求被活跃索引拒绝；重启后 Reconciler 收敛。
126. `convergeAfterT3Failure` 重复调用幂等，不重复处置/审计。
127. T3 失败后 Worktree 无法确认 → `needs_manual_review`，R 保持 starting，阻止业务入口。
128. CLI 已启动但 `executions.process_id` 未持久化 → 锁保留，不得回收；按启动失败收敛或 manual review。
129. holder_pid 更新失败、终止 CLI 后未确认退出 → 保留锁 + manual review。
130. CLI 已退出但 Execution 未终态 → 锁保留，Execution reconcile 后再 purge。
131. Core 重启时 Execution reconcile 与 purge 不得并行判断同一 executionId；顺序固定。
132. 旧 `workdir_locks` 行 holder 字段为 NULL → `manual_review`，不自动回收。

---

## 15. 风险与缓解

| 风险 | 等级 | 缓解 | 残余风险 |
|---|---|---|---|
| 共享工作目录下旧执行已产生副作用，恢复重复执行 | 高 | Checkpoint 风险等级；高风险必须 `acknowledgeRisk`；Prompt 明确禁止重做；审计 | 无法完全证明无重复副作用；需 1D SideEffect Ledger |
| unconfirmed 执行被误判为已终止 | 高 | 一律阻断，保持人工边界；不自动 spawn | 需要人工核实 Daemon/Execution |
| 旧 attempt 被标 failed 但实际已成功 | 中 | unconfirmed 阻断；只有确认终态/未启动才允许；审计保留证据 | 证据错误时需人工处理 |
| v34 表重建失败 | 中 | 事务 + 备份 + foreign_key_check + 行数校验；正式库 0 行 | 迁移失败需回滚 |
| Checkpoint 来自并行分支，上下文不完整 | 中 | 增加 Workflow 节点段与上游输出摘要；显式标注未知 | 复杂图仍需人工判断 |
| 一个 Work 仅允许一个活跃恢复，降低并行恢复效率 | 低 | 明确为安全边界；后续可评估按链放宽 | 多分支故障需串行处理 |
| 恢复失败后 Run 仍非终态 | 中 | 明确审计与 plan 阻断；允许再次恢复（D-6）或人工取消 | 不会自动收敛为 failed |
| 控制节点无法恢复 | 中 | 明确范围外；控制节点对账另案设计 | daemon 不可用场景可能仍需人工 |
| Worktree 增长 | 低 | 新 attempt 新分支；不自动删除 | 需后续清理策略 |
| 启动时通用 recoverOnStartup 提前终结带 Worktree 意图的 R | 高 | Worktree Reconciler 先执行；recoverOnStartup/reconcileInterruptedStarts 硬编码跳过；启动顺序测试 | 若装配顺序被改，测试必须失败 |
| ExecutionService 在 T3 内自行开事务/提交 | 高 | 强制 `RecoveryTxContext`；服务内禁止 transaction()/COMMIT；失败注入测试 | 需要代码审查与测试双重保证 |
| Core 死但 CLI 仍活，Workdir 锁被误回收 | 高 | purgeStale 先查 Execution 状态与 CLI 身份；Boot UUID 仅辅助；holder 记录启动标识防 PID 复用 | 外部进程仍可能篡改目录；无法完全防止 |
| T3 回滚后 R 长期停留在 starting | 高 | 独立事务即时收敛 R/Worktree；数据库不可写才保留 starting；活跃索引阻止新恢复 | 数据库长时间不可用需人工 |
| PID 复用导致锁被误判为原 CLI | 高 | 记录 holder_started_at/进程身份；身份不匹配视为已退出；身份不可读则保留 manual_review | 平台身份读取失败时需人工 |

---

## 16. CTO 决策与本稿落实

> 本节记录 2026-11-10 CTO 第四轮完整正文复核后的最新决策。**设计复核中，尚未最终验收。**

| 编号 | CTO 结论 | 必须满足的约束 | 本稿落实 |
|---|---|---|---|
| D-1 | 有条件通过 | 保留数据迁移；禁止直接 DROP 后重建；完整字段/NULL/默认值/CHECK/触发器/索引/外键重建；外部备份；迁移后检查失败阻止业务入口；真实结构 SQLite 测试 | §6.1、§6.5、§6.6 |
| D-2 | 通过 | 恢复入口校验 Node 类型；控制节点和其他类型不得伪造参数进入 | §5.2、§5.3、§1.2 |
| D-3 | 通过 | `recovery_superseded` 明确可审计；旧 attempt 永不改 succeeded；旧输出不作交付物 | §4.3、§7.4 |
| D-4 | 通过 | 数据库级并发约束 + 事务内 CAS；跨进程只允许一个恢复启动成功 | §13.1 |
| D-5 | 通过 | 六项条件通过；重入只解除阻塞，不重复启动/不重复副作用；无法确认一致性时保持阻塞 | §9.2、§9.2.1 |
| D-6 | 通过 | 稳定 chain identity；跨 Run 全局唯一；预算按链累计；启动即计数不返还；编号分离 | §6.3、§13.2.1 |
| D-7 | 通过 | 恢复失败只收敛当前恢复对象及关联记录；Branch 由原状态机规则决定 | §9.1、§9.4 |
| D-8 | 通过 | 控制节点不得走本次 agent_task 恢复接口 | §1.2、§5.2 |
| D-9 | 主体通过，启动对账缺口待闭合 | 真实路径/Git 身份/owner token 通过；启动时 workflow_node 的 Worktree 对账必须先于通用终态收敛 | §7.2、§7.3、§7.7、§8.6、§13.2.2 |
| D-10 | 通过 | RPC 权限、服务端重算、确认/风险确认、幂等、稳定错误码；不暴露 Session 管理接口 | §10、§7.2、§13 |
| P0 启动对账顺序 | 本轮新增 | Worktree Reconciler 在 recoverOnStartup 之前；通用逻辑硬编码跳过 Worktree 意图 R | §7.2、§7.7、§14.11 |
| P0 T3 事务边界 | 本轮新增 | 统一事务上下文；服务不得自行开事务/提交；T3 内无 spawn/git/fs | §7.4.1、§14.11 |
| P1 Workdir 锁契约 | 本轮新增 | 服务归属、realpath key、holder 身份、CLI 存活、释放与核验 | §7.5.1、§14.11 |
| P0 purgeStale 顺序 | 本轮新增 | Execution 状态 → CLI 存活/身份 → Boot UUID 仅辅助；不得直接回收 CLI 仍用的锁 | §7.5.1、§14.12 |
| P0 T3 回滚收敛 | 本轮新增 | 独立事务即时收敛 R/Worktree；数据库不可写才保留 starting；未终态前新恢复被拒 | §7.4.2、§14.12 |
| P1 spawn 竞态 | 本轮新增 | process_id 未落库、holder 转移失败、CLI 退出但 Execution 未终态、reconcile/purge 并发 | §7.5.1、§14.12 |

### 16.1 尚未关闭的设计事项

- **最终设计验收**：等待 CTO 对第五轮修订后的完整正文复核。
- **启动对账顺序**：Execution → Workflow → Worktree Reconciler → recoverOnStartup → reconcileInterruptedStarts → Coordinator；通用逻辑硬编码跳过 Worktree 意图 R。
- **T3 原子事务**：§7.4.1 统一事务上下文、禁止内部事务/副作用、失败注入测试；§7.4.2 T3 回滚后即时独立事务收敛。
- **Workdir 锁**：§7.5.1 服务归属、realpath key、CLI PID + 启动标识 holder、purgeStale 顺序（Execution → CLI → Boot UUID 辅助）、幂等释放；§6.2.2 新增 holder 身份列。
- **spawn 竞态**：process_id 未持久化、holder 更新失败、CLI 已退出但 Execution 未终态、Core 重启 reconcile/purge 并发，均已列明处理与测试。
- **D-1 迁移**：触发器重建、全字段逐列比较、外部备份、真实结构 SQLite 测试已补入 §6.5/§6.6，等待确认。
- 在 CTO 最终设计验收前，**不实施代码、不执行 v34、不运行真实恢复**。

---

## 17. 建议实施批次（未授权）

| 批次 | 内容 | 门禁 |
|---|---|---|
| 2B-0 | CTO 批准本设计与 §16 决策；冻结 v34 设计 | 设计批准 |
| 2B-1 | v34 迁移 + 仓储扩展 + plan 只读路径 + 测试 | 迁移测试、一致性、1B-2A 回归 |
| 2B-2 | start T1-T3 + 崩溃补偿 + Bridge 只读接缝 + 测试 | 全部场景测试、无重复执行 |
| 2B-3 | 终态收敛 + Run 重入 + RPC + 审计 + 全量门禁 | 全量测试、类型、lint、build |
| 验收 | 报告级验收；正式库不做真实恢复 | CTO 验收 |

任何批次开始前都必须由 CTO 单独授权；本设计不构成代码实施授权。

---

## 18. 设计验收标准

本设计满足以下条件才可进入实施：

1. 七个 CTO 问题均有明确、可测试的答案。
2. 不新增第二套恢复引擎或第二套恢复账本。
3. Scheduler 零改动；重复调度/副作用有数据库级约束。
4. 旧 attempt 不被伪造成功；新 attempt 与 Session/Execution 原子关联。
5. 崩溃窗口全部有明确收敛责任。
6. Run/Branch 收敛条件明确，不绕过审批与暂停。
7. v34 迁移范围最小，不触碰 `agent_sessions` / `executions` 列结构。
8. 1B-2A 行为与测试不受影响。
9. §0.2 十五项 P0 安全不变量全部进入正式约束。
10. D-1：v34 保留数据迁移、字段映射、索引/外键重建、失败回滚、迁移前后检查完整。
11. D-4：并发保障为 `BEGIN IMMEDIATE` + 数据库唯一约束 + CAS，不依赖服务层先查后插。
12. D-6：chain identity 稳定，预算按链累计，启动即计数、失败不返还，无法通过更换字段绕过。
13. D-9：新 Worktree 隔离、创建失败阻止启动、身份与恢复链关联可审计。
14. D-5：§9.2 六项 Run 重入条件经 CTO 逐条审核批准，且 §9.2.1 Scheduler 幂等边界有测试覆盖。
15. 启动顺序统一为 Execution → Workflow → Recovery → Coordinator，且每个阶段退出后有重启收敛测试。
16. 终态矩阵与 `WorkflowNodeTerminalObserver` 幂等性有测试覆盖。
17. D-9：`worktreeId` 在 T3 必填；T2 创建/验证/记录，T3 归属校验；孤儿 Worktree 不自动删除。
18. D-5：Run 重入后 Scheduler 幂等边界（§9.2.1）有测试覆盖。
19. Checkpoint 成功证明必须绑定本次 Execution、NodeRun B、RecoveryAttempt；旧 Checkpoint 不得复用。
20. D-6：链身份跨 Run 全局唯一，`attempt_no` 与 `chain_attempt_no` 分离且互不重置。
21. D-1：触发器重建、全字段逐列比较、外部备份、真实结构 SQLite 迁移测试全部覆盖。
22. P0-1：Worktree 真实路径、Git ref、baseCommit 仓库归属、Git 注册信息一致校验全部可测试。
23. P0-2：T2a owner token 先行、T3 精确归属、创建后未登记崩溃窗口、另一恢复不可认领，全部有测试。
24. P1-3：Checkpoint 归属以身份字段与 content_hash 为主，时间戳仅辅助且不得覆盖冲突。
25. Worktree 校验后到 spawn 前的竞态：使用现有 Workdir 锁并在 spawn 前最终复核；复核失败不 spawn。
26. 启动对账顺序：Worktree Reconciler 先于 recoverOnStartup；通用逻辑硬编码跳过带 Worktree 意图的 R。
27. T3 统一事务上下文：所有数据库写入共享同一连接；失败注入后全部回滚，R 保持 starting。
28. Workdir 锁契约：realpath key、CLI PID holder、Core 死/CLI 活保留、幂等释放，全部有测试。
29. purgeStale 顺序：Execution → CLI 存活/身份 → Boot UUID 仅辅助；Boot UUID 变化不得回收 CLI 仍用的锁。
30. T3 回滚后即时独立事务收敛；数据库不可写才保留 starting；R 未终态前新恢复被拒。
31. spawn/process_id/holder 转移失败/Core 重启竞态全部有测试。

---

## 19. 当前保护状态（设计提交时）

- 正式库：`user_version=33`；`task_recovery_attempts=0`；`task_checkpoints=3`；活跃/待对账 NodeRun=0；活跃/待对账 WorkflowRun=0。
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；工作区 109 项未提交变更（52 modified + 57 untracked）。
- 本设计只新增/修改一个文档；未改代码、数据库、迁移或 Git。
- Phase 1B-2A 保持关闭状态；Phase 1B-2B 未实施；Phase 1C/1D 未启动。
