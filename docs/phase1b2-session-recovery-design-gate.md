# Phase 1B-2 设计门禁：从 Checkpoint 创建新 Session 继续执行

- 状态：**CTO 已批准设计方向；1B-2A 代码实施完成，等待验收；1B-2B 未启动**
- 详细设计：`docs/phase1b2a-session-recovery-detailed-design.md`
- 实施报告：`docs/phase1b2a-implementation-report.md`
- 基线：Phase 1A 已关闭；Phase 1B-1 已验收关闭；本机正式库 `user_version=33`
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；工作区保持未提交
- 关系：本文继承 `docs/phase1b-checkpoint-context-builder-design-gate.md` 的 Checkpoint / Evidence / Risk 契约
- 范围：1B-2A 已实施；1B-2B/1C/1D 未启动

---

## 0. 门禁结论摘要

Phase 1B-2 的核心不是“发现 eligible 就自动继续”，而是把 1B-1 的只读恢复计划升级为一条**显式、可审计、可拒绝的恢复执行链**：

```text
有效 Checkpoint
  → 重新计算恢复资格（evidence / risk / side effects）
  → 显式恢复请求与确认
  → 创建 recovery attempt
  → ContextBuilder 重建 P0/P1/P2/P3
  → 新 Session + 新 Execution（不复用旧 Session）
  → 执行终态 → 新 Checkpoint
  → 失败则停止，不自动循环
```

本设计建议：

1. 新增 `task_recovery_attempts`（v33）记录恢复请求、资格、风险、关联的新 Execution/Session/TeamRun/NodeRun 和终态；不修改 `agent_sessions` 生命周期。
2. 恢复执行必须显式确认；`recoveryEligibility=eligible` 只是“可恢复”，不是“自动执行”。
3. 所有恢复都创建**全新 Session**；不使用 Provider Resume、不传 `resumeSessionId`、不改变 Provider 能力声明。
4. 恢复必须继承 1B-1 的证据、风险和副作用限制；`blocked` 一律不创建 Session；高风险 + `not_tracked` 继续阻断。
5. 建议把实施拆成 **1B-2A（Team + Work 最终交付/重开 + 通用 Work 执行）** 与 **1B-2B（Workflow NodeRun 恢复）**；Workflow 节点恢复涉及新 attempt 与调度器语义，风险明显更高，建议单独授权。
6. 当前只做设计；代码实施需 CTO 对本文决策点逐项批准后另行授权。

---

## 1. 当前代码事实核对

### 1.1 Phase 1B-1 已具备

| 能力 | 现状 |
|---|---|
| `task_checkpoints` | v32 已建；valid/failed、不可变、证据 JSON、verification JSON、content hash |
| `CheckpointService.getRecoveryPlan` | 只读恢复计划；重新校验文件/Artifact/测试证据；返回 eligibility/reasonCodes |
| `CheckpointService.assertCanStart` | 高风险失败 Checkpoint 阻断新执行 |
| `ContextBuilder` | P0/P1/P2/P3、固定预算、P0 fail-closed、manifest |
| Checkpoint 创建 | Execution 终态、Workflow 节点、Team run、Work 最终交付 |
| 风险/证据 | 高风险清单、`not_tracked`、路径安全、Artifact/Test 校验 |
| 审计 | checkpoint.created/failed/deduplicated/recovery_blocked/context.built/budget_exceeded |

### 1.2 当前缺口

1. `ExecutionService.startInternal` 每次创建新 Session/Execution，但没有“恢复执行”语义，也没有 Checkpoint 关联字段。
2. `ExecutionStartParams` 没有 recovery/checkpoint 参数；普通 `execution.start` 不能携带恢复意图。
3. 没有 recovery attempt 表；无法幂等记录“从哪个 Checkpoint 恢复了哪次执行”。
4. `TeamCollaborationService` 的 run 创建没有 recovery attempt 关联；`startRunInternal` 只组装普通 Team Prompt。
5. `WorkflowExecutionBridge` / Scheduler 的 `reconciliation_required` 节点没有“新 attempt + Checkpoint 上下文”的恢复路径。
6. `WorkService` 的 completed Work 只允许归档；Team 任务可以在 completed Work 上继续响应，但没有最终 Checkpoint 恢复语义。
7. 没有 recovery RPC/UI；没有业务级“继续任务”入口。
8. 没有 SessionLifecycleManager（Phase 1C）、没有 Provider Resume（Phase 2）、没有 SideEffect Ledger（Phase 1D）。

---

## 2. 定义与边界

### 2.1 三个不同概念

| 概念 | 定义 | 是否创建 Session |
|---|---|---|
| 恢复计划（Recovery Plan） | 1B-1 的只读结果：Checkpoint、证据、风险、eligibility、P0-P3 | 否 |
| 恢复执行（Recovery Execution） | 显式确认后，从 Checkpoint 重建上下文并新建 Session 继续任务 | 是 |
| 普通新执行（Normal Execution） | 用户正常发起的新任务/新消息，不声明恢复 | 是，但不由 1B-2 自动绑定 Checkpoint |

**硬规则：恢复计划不能直接触发恢复执行。** 必须有独立的显式恢复请求、确认和 recovery attempt。

### 2.2 新 Session 语义

- 每次恢复创建新的 `agent_sessions` 行、新的 `executions` 行。
- 旧 Session 保持 `ended`，不复用、不修改、不“复活”。
- 不使用 Provider Resume；不增加 `resumeSessionId`；Provider 能力声明保持现状。
- 新 Session 的上下文完全由 ContextBuilder + Checkpoint/Task Memory 重建。
- 不提供手动“新建/选择/切换 Session”的 UI；恢复入口是业务级“继续任务”，不是 Session 控制。

### 2.3 明确非目标

- 不实现 SessionLifecycleManager、Session 复用、压缩、70%/85% 阈值（Phase 1C）。
- 不实现 Provider Resume、`resumeSessionId`、Claude Code `--resume`（Phase 2）。
- 不实现 SideEffect Ledger、自动对账、外部副作用重试（Phase 1D）。
- 不实现文件恢复、覆盖、回滚、删除；恢复只重建上下文，不修复工作区。
- 不实现自动循环恢复；失败必须停止并等待新的显式请求。
- 不实现 Workflow 节点恢复的自动调度（建议单独 1B-2B 授权）。
- 不把普通新执行自动改造成恢复执行。

---

## 3. 建议数据模型：`task_recovery_attempts`（v33）

### 3.1 表结构

```sql
CREATE TABLE task_recovery_attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'workflow', 'work', 'generic')),
  base_dedupe_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')
  ),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  eligibility_status TEXT NOT NULL CHECK (
    eligibility_status IN ('eligible', 'conditional', 'blocked')
  ),
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  team_run_id TEXT REFERENCES team_task_runs(id) ON DELETE RESTRICT,
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE RESTRICT,
  plan_json TEXT NOT NULL,
  prompt_manifest_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (work_id, checkpoint_id, attempt_no),
  UNIQUE (work_id, dedupe_key)
);

CREATE UNIQUE INDEX idx_task_recovery_attempts_active
  ON task_recovery_attempts(work_id)
  WHERE status IN ('planned', 'starting', 'running');

CREATE INDEX idx_task_recovery_attempts_work
  ON task_recovery_attempts(work_id, created_at);
CREATE INDEX idx_task_recovery_attempts_checkpoint
  ON task_recovery_attempts(checkpoint_id);
CREATE INDEX idx_task_recovery_attempts_execution
  ON task_recovery_attempts(execution_id);
```

### 3.2 语义

| 字段 | 语义 |
|---|---|
| `checkpoint_id` | 恢复来源；必须是 `state='valid'` 且属于同一 Work |
| `kind` | 恢复适配器：team / workflow / work / generic |
| `base_dedupe_key` | `recovery:<workId>:<checkpointId>` |
| `dedupe_key` | 具体尝试键：`base#attempt-N` |
| `attempt_no` | 恢复尝试编号；建议上限 3 |
| `status` | planned → starting → running → succeeded/failed/cancelled/blocked |
| `risk_level` | 恢复计划计算出的风险，不由模型自报 |
| `eligibility_status` | 恢复计划结果；blocked 不得进入 starting |
| `execution_id/session_id` | 新 Session/Execution；启动成功后写入 |
| `team_run_id/node_run_id` | Team/Workflow 适配器关联 |
| `plan_json` | 恢复计划快照（P0-P3、manifest、原因码） |
| `prompt_manifest_json` | 实际恢复 Prompt 的来源/字节/裁剪摘要 |
| `error_json` | 启动失败、执行失败、崩溃对账原因 |
| `updated_at` | 可变状态；Checkpoint 仍不可变 |

### 3.3 为什么需要独立表

- 需要跨重启幂等：同一 Checkpoint 的恢复不能因重启重复创建 Session。
- 需要“一个 Work 同时最多一个 active recovery”约束。
- 需要记录新 Session/Execution 与 Checkpoint 的审计链。
- 仅靠 `executions.recovery_state_json` 无法提供唯一约束和可查询的恢复历史。
- 不建议给 `executions` 加 `checkpoint_id` 列：恢复是独立业务事件，且 Workflow/Team 适配器还需要 team_run/node_run 关联。

### 3.4 状态机

```text
planned → starting → running → succeeded
                   ↘ failed
                   ↘ cancelled
planned/starting → blocked（资格/风险/启动前失败）
starting → failed（启动中断/无 execution）
```

规则：

- `blocked` 不允许创建 Session。
- `starting` 持久化后，如果崩溃，启动对账只能标记 `failed`（`START_INTERRUPTED`），不得自动重试。
- `failed`/`cancelled`/`succeeded` 为终态；新的恢复必须创建新的 attempt。
- 每次恢复最多 3 次；超过后停止并审计 `RECOVERY_RETRY_LIMIT_REACHED`。
- `task_recovery_attempts` 可更新状态，但 Checkpoint 不可变；恢复尝试的审计事件追加到 `audit_logs`。

---

## 4. 恢复生命周期

### 4.1 阶段 1：只读计划

```text
用户/系统请求恢复计划
  → CheckpointService.getRecoveryPlan(workId, checkpointId?)
  → 重新校验文件/Artifact/Test 证据
  → 计算 risk / sideEffectCompleteness / eligibility
  → 返回 plan + reasonCodes + manifest
```

- 不创建 recovery attempt，不创建 Session，不写工作区。
- 允许写入 `context.built` 审计（1B-1 已实现）。
- `blocked` 直接返回原因，不进入 4.2。

### 4.2 阶段 2：显式恢复请求

```text
recovery.start(workId, checkpointId, confirm=true, acknowledgeRisk?)
  → 校验 Work 状态、active execution、active recovery
  → 重新读取 Checkpoint 与恢复计划（不能信任旧计划快照）
  → 校验 eligibility != blocked
  → 校验风险确认
  → 创建 recovery attempt（planned）
  → 构建 ContextBuilder Prompt
  → 创建新 Session + 新 Execution
  → attempt: starting → running
```

关键规则：

- **必须显式 `confirm=true`**；没有默认自动恢复。
- `blocked` 一律拒绝，不创建 attempt/Session。
- 高风险必须额外 `acknowledgeRisk=true`；Phase 1B-2 无 Ledger 时高风险通常已被 1B-1 判 blocked，不能绕过。
- `medium` 需要显式确认；`low` 也需要显式确认（只是不额外要求风险确认）。
- 恢复请求不得接受“忽略证据错误”“强制覆盖文件”“跳过检查”等参数。
- 恢复请求不能指定 Session ID、Provider Session、`resumeSessionId`。

### 4.3 阶段 3：创建新 Session 与执行

- 由适配器创建：
  - Team：新的 `team_task_run` + Execution（leader/member）。
  - Work：新的 Execution（Work-bound，assignment 必须 active）。
  - Workflow：新的 NodeRun attempt + Execution（建议 1B-2B）。
- `ExecutionService` 仍按现有逻辑创建新的 `agent_sessions` 和 `executions`。
- 恢复 Prompt 由 ContextBuilder 生成，并附加恢复约束前缀。
- 新 Execution 的 `recovery_state_json` 记录 `recoveryAttemptId`、`checkpointId`（可选），但不替代 `task_recovery_attempts`。
- 不允许复用旧 Session；旧 Session 保持 ended。

### 4.4 阶段 4：终态与后续

- 新 Execution 终态后：
  - 现有 CheckpointService 创建新 Checkpoint（可能失败；继承 1B-1 风险策略）。
  - 更新 recovery attempt：`succeeded` / `failed` / `cancelled`。
  - 审计 `recovery.completed` / `recovery.failed`。
- 失败不自动重试；用户/系统必须显式发起新 attempt。
- 恢复执行失败产生的 Checkpoint 可能使高风险任务进入 blocked；`assertCanStart` 继续阻断后续自动执行。

### 4.5 启动崩溃对账

启动时扫描 `task_recovery_attempts.status IN ('starting','running')`：

- 有 `execution_id`：
  - Execution 终态 → 按状态更新 attempt。
  - Execution running → 留给 ExecutionService reconciliation。
  - Execution 不存在 → attempt failed `EXECUTION_MISSING`。
- 无 `execution_id` 且状态 `starting`：
  - attempt failed `START_INTERRUPTED`。
- 不自动重试；不自动创建新 Session。
- `running` 的 attempt 如果执行已终态但 attempt 未更新，补记终态。

---

## 5. 授权、风险与恢复资格

### 5.1 恢复资格继承

必须直接复用 1B-1 的 `getRecoveryPlan` / `evaluateCheckpointRecovery`，不得在 1B-2 重新实现一套宽松判断。

| eligibility | 1B-2 行为 |
|---|---|
| `eligible` | 允许显式确认后恢复；仍创建新 Session |
| `conditional` | 允许显式确认；高风险需额外 `acknowledgeRisk`；原因写入 attempt |
| `blocked` | 拒绝；不创建 attempt/Session；返回原因码 |

### 5.2 风险门槛

- `high` + `sideEffectCompleteness != complete`：拒绝（1B-1 已 blocked）。
- `high` + `complete`（未来 Ledger 实现后）：允许但必须人工确认。
- `medium`：允许但必须显式确认，不能自动。
- `low`：允许但必须显式确认，不能自动。
- 模型不能自行声明风险或覆盖风险等级。

### 5.3 Work 状态规则

| Work 状态 | 恢复 |
|---|---|
| `active` | 允许（显式确认） |
| `paused` | 允许（显式确认；不得自动恢复） |
| `completed` | 仅允许 `final_delivery` Checkpoint 的显式“重开任务”；不改变 Work 历史状态，除非用户明确重开 |
| `cancelled` | 拒绝 |
| `archived` | 拒绝 |

补充：

- 有 active Execution 或 active recovery attempt：拒绝新恢复。
- 有 queued Team run：拒绝或要求先处理；不得并发恢复。
- Work 状态与 Checkpoint 归属必须一致；跨 Work 拒绝。

### 5.4 Checkpoint 选择

- 默认选择该 Work 最新 `valid` Checkpoint。
- 允许显式指定历史 Checkpoint，但必须：
  - 属于同一 Work；
  - `state='valid'`；
  - 重新计算证据与风险；
  - 在恢复计划中明确显示“不是最新 Checkpoint”；
  - 高风险仍按风险门槛处理。
- 不允许选择 `failed` 或损坏 Checkpoint。

---

## 6. ContextBuilder 与恢复 Prompt

### 6.1 输入

- Work 当前目标与验收标准（当前 Work 版本）。
- 当前 Task Memory。
- 选定 Checkpoint 的不可变快照、证据摘要、风险、sideEffectCompleteness。
- 当前 Work/Team 线程的有界消息（仅 P2）。
- Artifact/File 摘要。
- 恢复安全约束。

### 6.2 Prompt 结构

```text
[P0] Agent identity / permissions
[P0] Work goal + current acceptance criteria (Work vN)
[P0] Recovery source: checkpoint <id> (kind, seq, createdAt)
[P0] Completed / in-progress / blockers / next actions from checkpoint
[P0] Side effects: not_tracked / complete / partial
[P0] Recovery safety constraints:
     - Do not repeat completed work
     - Do not repeat in_progress/unknown side effects
     - Do not overwrite/rollback/delete workspace files
     - If evidence is insufficient, stop and report
[P1] Current Task Memory
[P2] Recent task thread (continuity only, not verified facts)
[P3] Artifact/file summaries
```

- P0 超预算：`CONTEXT_BUDGET_EXCEEDED`，不创建 Session。
- 不重放全部聊天；旧全局 Planner 消息不进入事实。
- 不把 Agent 自报 `test_result` 升级为 verified。
- 恢复 Prompt 的 manifest 写入 recovery attempt 的 `prompt_manifest_json` 和审计；不保存完整 Prompt（避免密钥/大日志）。

### 6.3 普通执行与恢复执行

- 1B-2 只对**恢复执行**使用 ContextBuilder 恢复 Prompt。
- 普通新执行保持现有 Prompt 组装路径，避免把所有执行都变成“恢复”。
- 未来 Phase 1C/2 可以统一 ContextBuilder，但不在本次范围。

---

## 7. 适配器范围建议

### 7.1 1B-2A（建议先实施）

#### Team 任务

- 恢复对象：Team Leader 或 Member 的新 run。
- 新 `team_task_run`，`role`/`subtaskId` 继承原任务；`execution_id` 指向新执行。
- `startRunInternal` 使用恢复 Prompt；Leader 获得完整任务上下文，Member 获得自己的子任务切片。
- 不重复已完成子任务；不自动把 review 子任务改为 running，除非恢复请求明确指定。
- 有 active/queued run 时拒绝。
- 完成后按现有 Team 逻辑进入 review/下一子任务；恢复 attempt 标记 succeeded。

#### Work 最终交付 / 重开

- 只允许 `final_delivery` Checkpoint。
- completed Work 的“重开”是显式业务动作；不把 Work 状态自动改回 active，除非产品定义明确。
- 新执行仍使用 Team 路径（当前 completed Work 允许 Team run）或明确的 Work-bound 执行。
- 不覆盖 final Checkpoint；恢复后产生新 Checkpoint。

#### 通用 Work 执行

- Work 有 active Assignment；新 Execution 绑定 Work；新 Session；恢复 Prompt。
- 不用于 Workflow 节点（由 1B-2B 处理）。
- 没有 Assignment 时拒绝，不自动创建 Assignment。

### 7.2 1B-2B（建议单独授权）

#### Workflow NodeRun

- 仅恢复 `reconciliation_required` 的 AgentTask 节点。
- 创建新的 NodeRun attempt（`attempt+1`），新 Execution；旧 attempt 保持 `reconciliation_required` 或明确标记失败/取消，不能伪造成功。
- 新 attempt 进入 ready/running，由调度器按依赖派发。
- 不自动恢复 HumanApproval、Join、Condition、Start/End 节点。
- 恢复前后必须校验 branch/run 状态；不重复已成功下游。
- 这是高风险变更，建议独立设计/授权，不与 Team/Work 恢复混在同一批。

### 7.3 不建议在 1B-2 做的事

- 自动恢复所有中断执行。
- 自动重试失败恢复。
- 复用旧 Session。
- 恢复 HumanApproval 的审批状态。
- 恢复文件内容或回滚 Git。
- 恢复 SideEffect（无 Ledger）。

---

## 8. 失败、幂等与安全

### 8.1 幂等

- `base_dedupe_key = recovery:<workId>:<checkpointId>`。
- `dedupe_key = base#attempt-N`；同一 attempt 重复请求返回已有 attempt。
- `UNIQUE(work_id, checkpoint_id, attempt_no)`。
- 同一 Work 同时最多一个 `planned/starting/running` recovery attempt。
- 恢复请求重复提交不得创建第二个 Session。

### 8.2 失败

- 启动前失败：`blocked`，不创建 Session。
- 启动中断：`failed`，不自动重试。
- 执行失败：`failed`；现有 Checkpoint 创建失败按 1B-1 风险策略处理；不自动恢复。
- 执行取消：`cancelled`；不自动恢复。
- 超过 3 次：停止，审计 `RECOVERY_RETRY_LIMIT_REACHED`。
- 恢复失败不得删除/覆盖工作区文件。

### 8.3 副作用

- 继承 1B-1 `not_tracked`：高风险 blocked；medium 显式确认；low 显式确认。
- 不因“没有发现副作用”标记 complete。
- 不重试 `in_progress`/`unknown` 副作用（Phase 1D 前没有 Ledger，保守阻断高风险）。
- 恢复 Prompt 明确告知模型副作用信息不完整。

### 8.4 审计

建议事件：

| 事件 | 关键字段 |
|---|---|
| `recovery.plan_viewed` | workId、checkpointId、eligibility、reasonCodes |
| `recovery.started` | recoveryAttemptId、workId、checkpointId、riskLevel、kind |
| `recovery.blocked` | workId、checkpointId、reasonCodes |
| `recovery.start_failed` | recoveryAttemptId、errorCode、blocked |
| `recovery.execution_linked` | recoveryAttemptId、executionId、sessionId、teamRunId/nodeRunId |
| `recovery.completed` | recoveryAttemptId、executionId、status |
| `recovery.failed` | recoveryAttemptId、executionId、errorCode |
| `recovery.crash_reconciled` | recoveryAttemptId、fromStatus、toStatus、reason |

审计不含密钥、完整 Prompt、完整文件内容。

---

## 9. Session / Provider 边界

- 恢复总是新 Session；旧 Session 保持 ended。
- 不调用 Provider Resume；不传 `resumeSessionId`；Provider 能力声明不变。
- 不修改 `agent_sessions` 生命周期；不引入 SessionLifecycleManager。
- Phase 1C 才做 Session 复用/压缩/阈值；Phase 2 才做 Provider Resume。
- 不提供手动 Session 控制 UI；恢复入口是业务级“继续任务/恢复任务”。
- 如果 Provider 启动失败，恢复 attempt failed；不自动切换 Provider/Session。

---

## 10. API / UI 边界（需 CTO 决策）

### 10.1 方案 A：Core 内部触发（无新 RPC/UI）

- 由现有 Work resume/Team comment 触发恢复。
- 优点：不新增协议/UI。
- 缺点：用户可能不知道这是恢复；难以表达风险确认；不符合“显式恢复”原则。
- 不推荐作为 1B-2 的唯一入口。

### 10.2 方案 B：显式业务级恢复入口（推荐）

- 新增只读 `work.recovery.plan` 和显式 `work.recovery.start`。
- Desktop 只在任务详情显示“继续任务/恢复任务”，展示 eligibility、risk、原因；不显示 Session ID。
- `recovery.start` 必须 `confirm=true`；高风险额外 `acknowledgeRisk=true`。
- 协议新增方法需要版本化与 Zod；不改变现有 execution.start 语义。
- UI 不提供“新建/选择/切换 Session”控制。

### 10.3 方案 C：仅 Core 内部 API，RPC/UI 后置

- 1B-2 先实现 `RecoveryService` 与内部测试，不暴露 RPC/UI。
- 优点：核心安全先落地；缺点：没有真实用户入口，验收只能靠内部调用。
- 可作为 1B-2A 的第一小步，但最终仍需业务入口。

**建议：1B-2A 采用方案 B 的最小版本（plan + start + 任务详情按钮）；如果 CTO 希望先不碰协议/UI，则采用方案 C，并在 1B-2B 前补入口。**

---

## 11. 测试验收矩阵（建议）

| # | 场景 | 预期 |
|---|---|---|
| 1 | v32 → v33 迁移 | `task_recovery_attempts` 存在；旧 Checkpoint/Work/Execution 数据完整；integrity/fk 通过 |
| 2 | blocked 计划 | 不创建 attempt/Session；返回原因码 |
| 3 | eligible 低风险显式确认 | 创建 attempt + 新 Session/Execution；旧 Session 保持 ended |
| 4 | 未确认/缺少 confirm | 拒绝，不创建 Session |
| 5 | high + not_tracked | 拒绝；不创建 Session |
| 6 | medium 显式确认 | 创建新 Session；审计记录风险 |
| 7 | 证据 invalid/missing | 拒绝；不覆盖/回滚/删除文件 |
| 8 | 跨 Work Checkpoint | 拒绝 |
| 9 | 有 active Execution/Recovery | 拒绝或幂等返回现有 attempt |
| 10 | 重复 start | 同一 attempt 幂等；不重复创建 Session |
| 11 | 启动中断（无 execution） | attempt failed `START_INTERRUPTED`；不自动重试 |
| 12 | 执行失败 | attempt failed；生成失败 Checkpoint；不自动重试 |
| 13 | 执行成功 | attempt succeeded；生成新 Checkpoint；不重复完成项 |
| 14 | 超过 3 次 | 停止并审计 `RECOVERY_RETRY_LIMIT_REACHED` |
| 15 | Team Leader 恢复 | 新 run + 新 Session；完整任务上下文；不重复已完成子任务 |
| 16 | Team Member 恢复 | 只读自己子任务切片；不读其他成员私有历史 |
| 17 | Work 最终交付重开 | 只接受 final_delivery；新执行；旧 final Checkpoint 不变 |
| 18 | Workflow NodeRun 恢复（1B-2B） | 新 attempt；旧 attempt 不伪造成功；不重复下游 |
| 19 | 普通新执行 | 不被自动改造成恢复执行 |
| 20 | Provider Resume 边界 | 无 resumeSessionId；Provider 能力不变 |
| 21 | UI 边界 | 只有业务级“继续任务”，无 Session 控制 |
| 22 | 崩溃后对账 | running/starting attempt 正确收敛；不自动循环 |
| 23 | 全量回归 | 现有 931 用例通过；无 Phase 1C/1D 变化 |

---

## 12. 需要 CTO 批准的决策

### D-1：数据模型

- 建议：v33 只新增 `task_recovery_attempts`；不修改 `agent_sessions`、`executions` 结构；不建 SideEffect Ledger。
- 备选：只用 `executions.recovery_state_json`；不建议，缺唯一约束与可查询历史。

### D-2：恢复必须显式

- 建议：所有恢复都需要显式 `confirm=true`；`eligible` 不等于自动执行；`blocked` 一律拒绝。
- 高风险额外 `acknowledgeRisk=true`；Phase 1B-2 无 Ledger 时高风险通常已被 blocked。

### D-3：实施范围

- 建议：1B-2A 先做 Team + Work 最终交付/重开 + 通用 Work 执行；Workflow NodeRun 恢复放 1B-2B 单独授权。
- 备选：1B-2 一次包含 Workflow NodeRun；范围更大，需单独设计新 attempt/调度语义。

### D-4：恢复入口

- 建议：最小业务级 RPC `work.recovery.plan` + `work.recovery.start`，Desktop 任务详情“继续任务”；不暴露 Session ID。
- 备选：仅 Core 内部 API，RPC/UI 后置；验收只能内部调用。
- 备选：现有 Team comment/Work resume 自动触发；不推荐，违反显式恢复原则。

### D-5：重试策略

- 建议：每个 Checkpoint 最多 3 次恢复尝试；失败不自动重试；每次新 attempt 必须显式请求。
- 超限审计 `RECOVERY_RETRY_LIMIT_REACHED`。

### D-6：Work 状态

- 建议：active/paused 允许显式恢复；completed 仅 final_delivery 显式重开；cancelled/archived 拒绝。
- 有 active Execution/Recovery/queued Team run 时拒绝。

### D-7：Checkpoint 选择

- 建议：默认最新 valid；允许显式历史 valid，但必须重新校验并显示“非最新”；failed/损坏拒绝。
- 备选：只允许最新；更简单但不利于审计/回滚场景。

### D-8：ContextBuilder 使用范围

- 建议：1B-2 只用于恢复执行；普通新执行保持现有 Prompt 组装，避免把所有执行变成恢复。
- 备选：所有执行统一 ContextBuilder；范围更大，留到 Phase 1C/2。

### D-9：Workflow NodeRun 恢复语义

- 建议：1B-2B 单独设计；创建新 NodeRun attempt，不复用旧 attempt/Session；不自动恢复审批/Join/Condition 节点。
- 若 CTO 要求 1B-2 一次完成，需要明确新 attempt、branch/run 状态和调度器 kick 规则。

### D-10：Provider/Session 边界

- 建议：新 Session only；无 Provider Resume；无 `resumeSessionId`；不修改 Provider 能力声明；Phase 2 再评估 Resume。

---

## 13. 门禁结论

- Phase 1B-2 的设计核心是“显式恢复执行”，不是自动恢复；只读恢复计划不能直接触发执行。
- CTO 已批准 1B-2 设计方向及 §12 十项决策（含 D-4/D-6/D-7 修订）；1B-2A 已按授权完成代码实施，等待 CTO 验收。
- 1B-2A 详细设计见 `docs/phase1b2a-session-recovery-detailed-design.md`；实施报告见 `docs/phase1b2a-implementation-report.md`。
- 恢复必须继承 1B-1 的证据、风险和副作用限制；blocked 不创建 Session；失败不自动循环。
- 所有恢复创建新 Session，不使用 Provider Resume，不提供手动 Session 控制。
- Phase 1B-2B、Phase 1C/1D 继续未启动；Git 保持未提交，不 commit/reset/clean/checkout/stash。
