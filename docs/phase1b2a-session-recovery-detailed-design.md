# Phase 1B-2A 详细设计：显式 Session 恢复

- 状态：**代码实施完成（2026-11-09），等待 CTO 验收；Phase 1B-2B 未启动**
- 实施报告：`docs/phase1b2a-implementation-report.md`
- 基线：Phase 1A 已关闭；Phase 1B-1 已验收关闭；本机正式库 `user_version=33`
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；工作区保持未提交
- 上游设计：`docs/phase1b2-session-recovery-design-gate.md`（CTO 已批准设计方向）
- 范围：Phase 1B-2A 详细设计与实施；Phase 1B-2B/1C/1D 未启动
- 保护：正式库 v33；不修改 `agent_sessions` / `executions` 表结构；不触碰 Workflow NodeRun 恢复；不执行 commit/reset/clean/checkout/stash

---

## 0. CTO 决策落实摘要

| 决策 | CTO 结论 | 本设计落实 |
|---|---|---|
| D-1 | 批准 | v33 只新增 `task_recovery_attempts`；不改 Session/Execution 表 |
| D-2 | 批准 | `confirm=true` 必须；高风险额外 `acknowledgeRisk=true`；blocked 不建 Session |
| D-3 | 批准 | 先做 1B-2A；Workflow NodeRun 留 1B-2B |
| D-4 | 修改后批准 | 只暴露 `work.recovery.plan` / `work.recovery.start` 两个业务 RPC |
| D-5 | 批准 | 每个 Checkpoint 最多 3 次显式恢复；失败不自动重试；与 Checkpoint 创建重试分开计数 |
| D-6 | 修改后批准 | active/paused 可恢复；completed 仅 final_delivery 显式重开；cancelled/archived 拒绝 |
| D-7 | 修改后批准 | 默认最新 valid；允许历史 valid，但必须重新计算资格并明确标记 |
| D-8 | 批准 | ContextBuilder 只用于恢复执行，不改变普通执行 Prompt |
| D-9 | 批准方向 | 1B-2B 使用新 NodeRun attempt，不复用旧 attempt/Session |
| D-10 | 批准 | 永远新 Session；无 Provider Resume、无 `resumeSessionId` |

**唯一仍需 CTO 确认的补充决策：D-6a。** completed Work 的“显式重开”是采用 `completed → active` 专用状态转换，还是保持 `completed` 仅记录重开 attempt。本文推荐前者，理由见 §8.2；在批准前不得实施。

---

## 1. 范围与非目标

### 1.1 1B-2A 范围

1. Team 任务恢复。
2. Work 最终交付后的显式重开。
3. 通用 Work 执行恢复。
4. `task_recovery_attempts` 持久化与并发约束。
5. 新 Session / 新 Execution 创建。
6. ContextBuilder 接入恢复 Prompt。
7. 恢复失败停止、崩溃对账与审计。

### 1.2 明确非目标

- Workflow NodeRun 恢复（1B-2B）。
- 自动恢复、后台自动继续、自动重试。
- Provider Resume、`resumeSessionId`、旧 Session 复用。
- SessionLifecycleManager、Session 压缩、70%/85% 阈值（1C）。
- SideEffect Ledger、自动副作用对账（1D）。
- 文件恢复、覆盖、回滚、删除。
- 手动 Session 管理 UI。
- 修改 `agent_sessions` / `executions` 结构。
- 修改 Workflow Scheduler / NodeRun 状态机。

---

## 2. 当前代码基线

### 2.1 可复用

| 能力 | 位置 | 用法 |
|---|---|---|
| Checkpoint 只读计划 | `CheckpointService.getRecoveryPlan` | 1B-2A 唯一资格来源；start 时重新调用 |
| 高风险启动阻断 | `CheckpointService.assertCanStart` | 恢复启动前再次检查 |
| ContextBuilder | `services/context-builder.ts` | 恢复 Prompt 的 P0-P3 组装 |
| 新 Session/Execution | `ExecutionService.startInternal` | 每次执行新建 `agent_sessions` + `executions` |
| Team run 启动 | `TeamCollaborationService.startRunInternal` | 新 run + Execution |
| Work 状态机 | `WorkService` | active/paused/completed/cancelled/archived |
| 审计 | `AuditRepository` | recovery.* 事件 |

### 2.2 需要新增

- `RecoveryAttemptRepository` / `RecoveryService`。
- `work.recovery.plan` / `work.recovery.start` RPC。
- `ExecutionService.startRecovery` 内部入口（不暴露 `execution.start` 恢复参数）。
- Team / Work / Generic 三个 `RecoveryTarget` 适配器。
- completed Work 显式重开机制（D-6a）。
- 启动对账与测试。

### 2.3 不得改动

- `ExecutionStartParams` 不增加 recovery 字段；恢复只走内部 `startRecovery`。
- `agent_sessions` / `executions` 不加列。
- Provider 能力声明不变。
- Workflow Bridge/Scheduler 不在 1B-2A 修改。

---

## 3. 架构

```text
work.recovery.plan
  → RecoveryService.plan
  → CheckpointService.getRecoveryPlan
  → 返回 eligibility/risk/limits/context budget

work.recovery.start
  → RecoveryService.start
  → 重新计算 plan（不信任客户端）
  → 预检 Work/Checkpoint/active/attempt count/idempotency
  → T1: 插入 recovery attempt(starting) [+ completed reopen 转换]
  → ContextBuilder.buildRecoveryPrompt
  → RecoveryTarget.prepare (Team run / assignment / target)
  → ExecutionService.startRecovery
      → 新 Session + 新 Execution + attempt=running 原子关联
  → 返回 attemptId / executionId / sessionId

Execution 终态
  → 现有 CheckpointService 创建 Checkpoint
  → RecoveryService.onExecutionTerminal
  → attempt=succeeded/failed/cancelled + audit
```

### 3.1 核心服务

```ts
type RecoveryServiceDeps = {
  db: Database
  attempts: RecoveryAttemptRepository
  works: WorkRepository
  workService: WorkService
  checkpoints: CheckpointService
  contexts: ContextBuilder
  executions: ExecutionService
  teams: TeamRepository
  teamRuns: TeamTaskRunRepository
  teamMessages: TeamTaskMessageRepository
  taskMemories: TaskMemoryService
  audit: AuditRepository
  now: () => string
}
```

`RecoveryTarget` 接口：

```ts
type RecoveryTarget = {
  kind: 'team' | 'work' | 'generic'
  prepare(input: {
    work: WorkRecord
    checkpoint: CheckpointRecord
    plan: RecoveryPlanResult
    prompt: RecoveryPrompt
  }): Promise<{
    start: (recoveryAttemptId: string) => Promise<{
      executionId: string
      sessionId: string
      teamRunId?: string
    }>
  }>
}
```

1B-2B 可新增 `WorkflowRecoveryTarget`，不需要改 1B-2A 的 RPC/表/服务契约；`task_recovery_attempts.node_run_id` 预留。

---

## 4. v33 数据模型

### 4.1 表结构

```sql
CREATE TABLE task_recovery_attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'work', 'generic')),
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
  execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  team_run_id TEXT REFERENCES team_task_runs(id) ON DELETE RESTRICT,
  node_run_id TEXT REFERENCES node_runs(id) ON DELETE RESTRICT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (work_id, checkpoint_id, attempt_no),
  UNIQUE (work_id, idempotency_key),
  UNIQUE (work_id, dedupe_key)
);

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
```

### 4.2 字段语义

| 字段 | 语义 |
|---|---|
| `work_id` / `checkpoint_id` | 恢复来源；Checkpoint 必须属于同一 Work 且 `state='valid'` |
| `kind` | 1B-2A：team / work / generic；1B-2B 再扩展 workflow |
| `base_dedupe_key` | `recovery:<workId>:<checkpointId>` |
| `dedupe_key` | `base#attempt-N` |
| `idempotency_key` | 客户端提供；同一 Work 内唯一；重放返回原 attempt |
| `attempt_no` | 1..3；在 `BEGIN IMMEDIATE` 内按 `MAX(attempt_no)+1` 分配 |
| `status` | 状态机见 §5；`starting` 已计入次数 |
| `risk_level` / `eligibility_status` | start 时重新计算的结果快照 |
| `original_work_status` | 重开时原 Work 状态；非重开为 NULL |
| `reopen_reason` | completed 重开必填；非重开为 NULL |
| `operator_confirmation_json` | `{confirm, acknowledgeRisk, actorType, actorId, at}`；不存敏感信息 |
| `plan_hash` | 规范化 plan 摘要；start 重新计算并比对，防止计划漂移 |
| `context_manifest_json` | ContextBuilder 实际使用的来源/字节/裁剪摘要 |
| `execution_id/session_id` | 新 Session/Execution；启动成功后写入 |
| `team_run_id` | Team 恢复的新 run；1B-2A |
| `node_run_id` | 预留给 1B-2B；1B-2A 必须 NULL |
| `error_json` | 启动/执行/崩溃对账错误 |

### 4.3 约束语义

- `UNIQUE(work_id, idempotency_key)`：同一请求重放返回原 attempt。
- `UNIQUE(work_id, checkpoint_id, attempt_no)`：每个 Checkpoint 的尝试编号唯一。
- 部分唯一索引 `WHERE status IN ('starting','running')`：同一 Work 最多一个 active recovery。
- `blocked` 预检请求**不插入 attempt**，因此不消耗次数。
- `starting` 一旦插入即计入次数；即使随后启动失败，也不能当作未执行。
- `failed/succeeded/cancelled/blocked` 为终态；终态行不再改变状态，只追加审计。
- 外键全部 `ON DELETE RESTRICT`；不修改/删除历史 attempt。
- 不修改 `agent_sessions` / `executions` 结构。

---

## 5. Recovery Attempt 状态机

```text
[preflight blocked] → 不建 attempt，仅审计 recovery.blocked

[start 事务]
  → starting
      → running（新 Session/Execution 创建并关联）
      → failed（context build/启动失败）
      → blocked（并发/资格失效；已计入次数）
  → running
      → succeeded（执行终态成功）
      → failed（执行终态失败/崩溃）
      → cancelled（执行取消）
```

规则：

1. `starting` 是持久化意图；插入即计入 3 次上限。
2. `starting` 崩溃：启动对账只能转为 `failed`（`START_INTERRUPTED`），禁止自动再启动。
3. `running` 崩溃：
   - Execution 终态 → 按终态更新 attempt。
   - Execution 仍运行 → 留给 ExecutionService reconciliation。
   - Execution 不存在 → `failed`（`EXECUTION_MISSING`）。
4. 终态不可回退；新的恢复必须新 attempt。
5. `blocked` 预检不创建行；`blocked` 终态仅用于“已 starting 后并发失效”的 fail-closed。
6. 每次状态转换写审计；`updated_at` 更新，Checkpoint 不变。

---

## 6. RPC 契约

### 6.1 `work.recovery.plan`

只读；不创建 attempt/Session。

请求：

```ts
type WorkRecoveryPlanParams = {
  workId: string
  checkpointId?: string // 缺省最新 valid
}
```

响应：

```ts
type WorkRecoveryPlanResult = {
  workId: string
  checkpointId: string
  checkpointSeq: number
  checkpointKind: string
  isLatest: boolean
  workStatus: string
  workIssueStatus: string
  eligibility: {
    status: 'eligible' | 'conditional' | 'blocked'
    planOnly: true
    reasonCodes: string[]
    riskLevel: 'low' | 'medium' | 'high' | null
    evidenceStatus: string | null
    sideEffectCompleteness: string | null
  }
  limits: {
    maxAttempts: 3
    attemptsUsed: number
    remainingAttempts: number
    activeAttemptId: string | null
  }
  contextBudget: {
    totalChars: number
    p0Chars: number
    p0Bytes: number
    p1Bytes: number
    p2Bytes: number
    p3Bytes: number
    trimmed: { p1: boolean; p2: boolean; p3: boolean }
  }
  reopen: {
    required: boolean
    originalWorkStatus: 'completed' | null
    reasonRequired: boolean
  }
  sections?: { p0: string; p1: string; p2: string; p3: string } // 只读预览；可裁剪
}
```

- `plan` 不返回 Session 控制字段。
- `plan` 不是授权凭证；`start` 必须重新计算。
- `blocked` 时仍返回 checkpoint/eligibility/reason，不抛“成功”。
- 历史 Checkpoint 必须 `isLatest=false` 并显示。

### 6.2 `work.recovery.start`

请求：

```ts
type WorkRecoveryStartParams = {
  workId: string
  checkpointId: string
  confirm: true
  acknowledgeRisk?: true
  idempotencyKey: string // 必填，1..200
  reopenReason?: string // completed 重开必填
}
```

响应：

```ts
type WorkRecoveryStartResult = {
  recoveryAttemptId: string
  status: 'starting' | 'running' | 'failed' | 'blocked'
  executionId: string | null
  sessionId: string | null
  teamRunId: string | null
  idempotentReplay: boolean
}
```

Core 校验顺序（全部在 Core，不信任客户端）：

1. `confirm === true`，否则 `RECOVERY_CONFIRMATION_REQUIRED`。
2. Work 存在、状态允许、Checkpoint 属于该 Work、`state='valid'`、content hash 通过。
3. 重新调用 `CheckpointService.getRecoveryPlan`，重新校验证据/风险/资格。
4. `eligibility=blocked` → 拒绝，不建 attempt/Session。
5. 高风险：`sideEffectCompleteness=not_tracked` → 拒绝，`acknowledgeRisk` 不能绕过；其他高风险需 `acknowledgeRisk=true`。
6. 无 active Execution / active Recovery / 冲突 queued run。
7. 未超过 3 次。
8. completed 重开必须 `final_delivery` + `reopenReason` 非空。
9. `idempotencyKey` 已存在 → 返回原 attempt（`idempotentReplay=true`），不重复创建。
10. 同一 Work 已有 active attempt → `RECOVERY_ACTIVE_EXISTS`。
11. 所有通过后进入 §7 事务。

### 6.3 错误码

建议业务错误码（若 CTO 不希望扩展 `RpcErrorCode`，则使用 `INVALID_PARAMS` + `detail.code`）：

| code | 含义 |
|---|---|
| `RECOVERY_CONFIRMATION_REQUIRED` | 缺少 `confirm=true` |
| `RECOVERY_RISK_ACK_REQUIRED` | 高风险缺少 `acknowledgeRisk=true` |
| `RECOVERY_PLAN_BLOCKED` | 资格 blocked |
| `RECOVERY_CHECKPOINT_NOT_FOUND` | Checkpoint 不存在/非 valid |
| `RECOVERY_WORK_MISMATCH` | Checkpoint 不属于 Work |
| `RECOVERY_WORK_STATUS_INVALID` | Work 状态不允许 |
| `RECOVERY_REOPEN_REASON_REQUIRED` | completed 重开缺少原因 |
| `RECOVERY_ACTIVE_EXISTS` | 已有 active attempt/execution |
| `RECOVERY_RETRY_LIMIT_REACHED` | 已达到 3 次 |
| `RECOVERY_CONTEXT_BUDGET_EXCEEDED` | P0/总预算 fail-closed |
| `RECOVERY_START_FAILED` | 启动失败（无 Session 或已 failed） |
| `RECOVERY_IDEMPOTENCY_CONFLICT` | 同 key 不同参数（若需要严格冲突检测） |

---

## 7. 恢复生命周期与事务边界

### 7.1 预检（无写）

```text
RecoveryService.start
  → 读取 Work/Checkpoint
  → CheckpointService.getRecoveryPlan（重新计算证据/风险）
  → 校验 confirm/risk/Work status/active/attempt count/idempotency
  → blocked：audit recovery.blocked；返回错误；不建 attempt
```

### 7.2 T1：持久化启动意图

`BEGIN IMMEDIATE`：

1. 再次检查 active attempt、attempt count、idempotency key。
2. 分配 `attempt_no = MAX(attempt_no)+1`（同一 checkpoint）。
3. 插入 `task_recovery_attempts`：
   - `status='starting'`
   - `risk_level`/`eligibility_status`
   - `plan_hash`
   - `operator_confirmation_json`
   - `original_work_status` / `reopen_reason`（completed 重开）
4. completed 重开：执行 `WorkService.reopenCompletedInTransaction`（D-6a）：
   - `completed → active`
   - 清除 `completedAt`（保留旧值到审计）
   - `issueStatus='in_progress'`
   - 审计 `work.reopened`，记录 checkpoint/attempt/reason/actor
5. 审计 `recovery.started`。
6. 提交。

失败：事务回滚，无 attempt；返回错误。

### 7.3 T2：构建恢复上下文

- `ContextBuilder.buildRecoveryPrompt`（见 §9）。
- 失败：
  - 更新 attempt `failed` 或 `blocked`（已 starting，计入次数）。
  - 写 `error_json`/审计 `recovery.start_failed`。
  - 不创建 Session。
- 成功：保存 `context_manifest_json`，继续。

### 7.4 T3：创建新 Session/Execution

- 适配器 `prepare` 创建 Team run（如有）并确定 agent/assignment。
- 调用内部 `ExecutionService.startRecovery`：
  - 复用现有 agent/provider/tool/assignment/锁/并发校验。
  - 在现有 session/execution 创建事务内：
    - 创建新 `agent_sessions`（新 ID、新 externalSessionId）。
    - 创建新 `executions`（新 ID）。
    - 更新 attempt `status='running'`、`execution_id`、`session_id`、`team_run_id`。
    - 设置 execution `recovery_state_json.recovery = { recoveryAttemptId, checkpointId }`。
  - 不修改 `agent_sessions`/`executions` 表结构。
- 如果 Execution 排队：attempt 仍为 `running`（已关联 pending/queued Execution），由现有队列语义处理。
- 启动失败：
  - attempt `failed`；Team run 标记 failed；审计；不自动重试。
  - 如果 Session/Execution 已创建但 attempt 更新失败，启动对账按 execution 状态收敛；不重复创建。

### 7.5 T4：终态

- Execution 终态后，现有 CheckpointService 创建新 Checkpoint。
- `RecoveryService.onExecutionTerminal(executionId)`：
  - 找到 attempt by execution_id。
  - succeeded → `succeeded`；failed/crashed → `failed`；cancelled → `cancelled`。
  - 审计 `recovery.completed` / `recovery.failed` / `recovery.cancelled`。
- 不自动创建新 attempt。

### 7.6 启动对账

`RecoveryService.recoverOnStartup()`：

- `starting` 且无 execution：`failed` `START_INTERRUPTED`。
- `starting` 有 execution：按 execution 状态收敛。
- `running`：
  - execution 终态 → 收敛。
  - execution running → 留给 ExecutionService reconciliation。
  - execution 缺失 → `failed` `EXECUTION_MISSING`。
- 不自动重试、不自动创建 Session。

---

## 8. 适配器

### 8.1 Team 任务

恢复目标：

- Checkpoint 必须来自 Team run（`team_run_id` 非空）或 Team Work。
- 新 `team_task_run`：
  - `role` 继承原 run（leader/member）
  - `agent_id` 继承
  - `subtask_id` 继承（member）
  - `status='queued'` 或 `running`
  - `trigger_message_id=null`
- `startRunInternal` 使用恢复 Prompt：
  - Leader：完整任务 + Checkpoint + 全队子任务。
  - Member：自己的子任务 + 相关验收标准 + 允许的 Task Memory 切片。
- 不重复已完成子任务；不把 `done` 子任务重新打开。
- 有 active/queued team run 时拒绝。
- 完成后按现有 Team 逻辑进入 review/下一子任务。

### 8.2 Work 最终交付与显式重开

- 仅 `checkpoint.kind='final_delivery'`。
- Work 必须 `completed`。
- `reopenReason` 必填；记录 `original_work_status='completed'`、checkpoint、operator confirmation、attempt。
- **D-6a 推荐方案**：新增专用 `WorkService.reopenCompleted`（仅由 recovery.start 调用）：
  - 状态机新增 `completed → active`（只允许此专用动作）。
  - 清除 `completedAt`，保留旧值到审计。
  - `issueStatus='in_progress'`。
  - 审计 `work.reopened`，包含 from/to、reason、checkpointId、recoveryAttemptId、actor。
  - 不静默修改；没有 recovery.start 不得调用。
- 备选方案（若 CTO 拒绝改 Work 状态机）：
  - Work.status 保持 completed；使用 Team 路径 `allowInactiveWork`；issueStatus 改 in_progress；记录 recovery attempt。
  - 缺点：状态语义弱，通用 Work 执行路径不可用。
- 重开后的新执行仍创建新 Session；旧 final Checkpoint 不变；完成后产生新 Checkpoint。

### 8.3 通用 Work 执行

- Work 状态 active 或 paused（paused 通过显式 recovery 允许，`allowInactiveWork=true`）。
- 必须有 active Assignment；不自动创建 Assignment。
- 新 Execution 绑定 Work；新 Session；恢复 Prompt。
- 不用于 Workflow 节点；`node_run_id` 必须 NULL。
- 完成后按现有 Work/Assignment 逻辑；不自动改 Work 状态。

---

## 9. ContextBuilder 恢复 Prompt

### 9.1 输入

- Work 当前目标/验收标准。
- 当前 Task Memory。
- 选定 Checkpoint 的快照/证据/风险/sideEffectCompleteness。
- 当前 Team/Work 线程有界消息（仅 P2）。
- Artifact/File 摘要。
- Recovery 约束。

### 9.2 Prompt 模板

```text
[P0] Identity and permissions
Agent: ...
Access mode: ...
(系统 Prompt)

[P0] Work
Task: ...
Objective: ...
Acceptance criteria (Work vN):
...

[P0] Recovery source
Checkpoint: <id> (seq, kind, createdAt)
This is an explicit recovery, not a fresh task.
Completed:
- ...
In progress:
- ...
Blockers:
- ...
Next actions:
- ...

[P0] Side effects
Completeness: not_tracked / complete / partial
- ...
Do not repeat succeeded or unknown side effects.

[P0] Recovery safety constraints
- Do not repeat completed work.
- Do not overwrite, rollback, or delete workspace files.
- If evidence is insufficient, stop and report.
- Recovery planning is read-only; this execution is the only recovery action.

[P1] Current Task Memory
...

[P2] Recent task thread (continuity only, not verified facts)
...

[P3] Artifacts and files
...
```

### 9.3 预算

- 默认总 60,000 chars；P0 30,000 chars。
- P0 超限：`RECOVERY_CONTEXT_BUDGET_EXCEEDED`，不创建 Session。
- P1/P2/P3 按优先级裁剪；manifest 写入 attempt。
- 不保存完整 Prompt 到数据库；只存 manifest/来源/字节。
- 不重放全部聊天；旧全局 Planner 消息不作为事实。

### 9.4 Team 差异

- Leader：完整任务 + Checkpoint + 全队子任务。
- Member：自己的子任务 + 相关验收标准 + Task Memory 切片；不读其他成员私有历史。
- 所有角色不读取其他 Work 的 Checkpoint/Task Memory。

---

## 10. 风险、证据与副作用

- 直接复用 `CheckpointService.getRecoveryPlan`；不实现第二套宽松判断。
- `blocked`：不创建 attempt/Session；返回原因码。
- `high + not_tracked`：blocked；`acknowledgeRisk=true` 不能绕过。
- `high + complete`（未来 Ledger）：允许但必须 `confirm + acknowledgeRisk`，并展示潜在重复副作用。
- `medium`：允许但必须 `confirm`；展示风险。
- `low`：允许但必须 `confirm`；不自动。
- 证据 invalid/missing：拒绝；不覆盖/回滚/删除。
- 历史 Checkpoint：必须重新校验 content_hash、Work 归属、证据、风险；明确标记 `isLatest=false`。
- 模型不能声明/覆盖风险等级。

---

## 11. 并发与幂等

### 11.1 数据库约束

- `UNIQUE(work_id, idempotency_key)`。
- `UNIQUE(work_id, checkpoint_id, attempt_no)`。
- 部分唯一索引 active（starting/running）。
- `attempt_no` 在 `BEGIN IMMEDIATE` 内分配。
- 终态转换 CAS：`UPDATE ... WHERE id=? AND status=?`，失败则重新读取，不覆盖。

### 11.2 请求语义

- 同 `idempotencyKey` 重放：返回原 attempt，`idempotentReplay=true`；若原 attempt 已 failed，仍返回 failed，不自动新建。
- 不同 key 且已有 active attempt：`RECOVERY_ACTIVE_EXISTS`。
- 预检 blocked：不建 attempt，不消耗次数。
- `starting` 后失败：计入次数。
- 每个 Checkpoint 最多 3 次；`failed/succeeded/cancelled/blocked` 都计数（blocked 预检除外）。
- Checkpoint 创建重试计数与 Recovery attempt 计数完全分开，不共用字段/计数器。

### 11.3 崩溃

- `starting` 无 execution → `failed START_INTERRUPTED`；不自动重试。
- `running` execution 终态 → 收敛；execution 缺失 → failed；execution running → 留给 reconciliation。
- 不自动启动第二份执行。

---

## 12. 审计

| 事件 | 关键字段 |
|---|---|
| `recovery.plan_viewed` | workId、checkpointId、eligibility、reasonCodes |
| `recovery.blocked` | workId、checkpointId、reasonCodes、risk |
| `recovery.started` | recoveryAttemptId、workId、checkpointId、kind、risk、attemptNo |
| `recovery.start_failed` | recoveryAttemptId、errorCode、blocked |
| `recovery.execution_linked` | recoveryAttemptId、executionId、sessionId、teamRunId |
| `recovery.completed` | recoveryAttemptId、executionId、status |
| `recovery.failed` | recoveryAttemptId、executionId、errorCode |
| `recovery.crash_reconciled` | recoveryAttemptId、fromStatus、toStatus、reason |
| `work.reopened` | workId、fromStatus、toStatus、reason、checkpointId、recoveryAttemptId、actor |

审计不含密钥、完整 Prompt、完整文件内容。

---

## 13. 1B-2A / 1B-2B 接口隔离

- 1B-2A `task_recovery_attempts.kind` 只允许 `team` / `work` / `generic`；`node_run_id` 预留但必须 NULL。
- `RecoveryTarget` 是适配器接口；1B-2B 新增 `workflow` target，不改 1B-2A RPC 参数/表核心字段。
- 1B-2A 不修改 Workflow Bridge/Scheduler/NodeRun 状态机。
- 1B-2B 必须单独设计新 NodeRun attempt、branch/run 状态、Join/下游调度和旧 attempt 关联；不得复用 1B-2A 的 `node_run_id` 语义绕过。
- 1B-2A 测试不得依赖 Workflow recovery 行为。

---

## 14. 测试矩阵

| # | 场景 | 预期 |
|---|---|---|
| 1 | v32 → v33 迁移 | 新表/索引/约束存在；旧 Checkpoint/Work/Execution 完整；integrity/fk 通过 |
| 2 | plan blocked | 不建 attempt/Session；返回原因 |
| 3 | plan eligible | 返回 checkpoint/risk/budget/limits；不写 attempt |
| 4 | 历史 checkpoint plan | `isLatest=false`；重新计算资格 |
| 5 | start 缺 confirm | 拒绝，无 Session |
| 6 | start 高风险缺 acknowledgeRisk | 拒绝 |
| 7 | high + not_tracked + acknowledgeRisk | 仍拒绝；不可绕过 |
| 8 | start blocked | 不建 attempt；不消耗次数 |
| 9 | start eligible 低风险 | 新 Session/Execution；旧 Session ended |
| 10 | start medium | 新 Session；风险审计 |
| 11 | 同 idempotencyKey 重放 | 返回原 attempt；无新 Session |
| 12 | 不同 key 并发 active | `RECOVERY_ACTIVE_EXISTS` |
| 13 | attempt_no 并发 | 事务化分配；唯一约束 |
| 14 | 3 次上限 | 第 4 次拒绝；审计 |
| 15 | starting 崩溃无 execution | failed START_INTERRUPTED；不自动重试 |
| 16 | running execution 终态 | attempt 收敛；不重复 |
| 17 | execution 失败 | attempt failed；Checkpoint 失败策略；不自动重试 |
| 18 | execution 取消 | attempt cancelled |
| 19 | Team leader 恢复 | 新 run/Session；完整上下文；不重复完成子任务 |
| 20 | Team member 恢复 | 子任务切片；不读其他成员 |
| 21 | completed final_delivery 重开 | 记录原状态/原因/checkpoint/actor/attempt；状态转换按 D-6a |
| 22 | completed 非 final checkpoint | 拒绝 |
| 23 | generic Work active/paused | 新 Session；assignment 必须 active |
| 24 | generic Work 无 assignment | 拒绝 |
| 25 | ContextBuilder P0 超预算 | 拒绝；无 Session |
| 26 | 普通新执行 | 不被自动改造成恢复 |
| 27 | Provider/Session 边界 | 无 resumeSessionId；新 session；Provider 能力不变 |
| 28 | UI/RPC 边界 | 只有 plan/start；无 Session 管理 |
| 29 | 全量回归 | 现有 931 用例通过；无 1B-2B/1C/1D 变化 |

---

## 15. 已落实的补充决策

### D-6a：completed Work 的状态语义

CTO 一次性授权后采用推荐 A 实施：

- 新增专用 `completed → active` 重开转换，仅由 `work.recovery.start` 调用；
- 记录原完成状态、原因、Checkpoint、操作者确认、Recovery Attempt；
- 清除 `completedAt`，保留旧值到审计；
- 写 `work.reopened` 审计。

### D-4a：RPC 错误码形式

采用新增业务错误码：

- `RECOVERY_CONFIRMATION_REQUIRED`、`RECOVERY_RISK_ACK_REQUIRED`、`RECOVERY_PLAN_BLOCKED`
- `RECOVERY_CHECKPOINT_NOT_FOUND`、`RECOVERY_WORK_MISMATCH`、`RECOVERY_WORK_STATUS_INVALID`
- `RECOVERY_REOPEN_REASON_REQUIRED`、`RECOVERY_ACTIVE_EXISTS`、`RECOVERY_RETRY_LIMIT_REACHED`
- `RECOVERY_CONTEXT_BUDGET_EXCEEDED`、`RECOVERY_START_FAILED`、`RECOVERY_IDEMPOTENCY_CONFLICT`

---

## 16. 门禁结论

- 1B-2A 详细设计与代码实施完成，覆盖 v33 表、状态机、RPC、三种恢复路径、completed 重开、ContextBuilder、事务边界、并发/幂等/崩溃测试和 1B-2B 隔离。
- 实施报告见 `docs/phase1b2a-implementation-report.md`；等待 CTO 验收。
- 正式库 `user_version=33`；不修改 Session/Execution 表；不触碰 Workflow NodeRun 恢复；不执行 Git 提交/重置/清理/切换分支；不启动 1C/1D。
