# Agentra 团队队长与派工 Assignment 实施就绪设计

- 版本：1.0（设计基线 + 实施核验）
- 日期：2026-11-07
- 审查对象：`docs/agentra-assistant-team-leader-architecture.md`
- 审查范围：阶段 1（团队队长基础）+ 阶段 2（PlanTask.teamId、队长派工、老板改派、StartRun 一致性）
- 不在范围：Assistant 聊天/动作、Provider 凭据管理、执行引擎重写
- 实施状态：阶段 1/2 已实现；Assistant 与 Provider 凭据管理仍未实现
- 后续方向：团队任务已按 B 路线改为 Multica 式线程协作，见
  `docs/agentra-planner-team-collaboration.md`

### 实施核验（2026-11-07）

- 数据库迁移：新增 v27 `team_leader`、v28 `plan_dispatch`；当前最高版本 28。
- 新增 Core 服务：`PlanAssignmentService`、`TeamDispatchService`、`PlanStartService`；
  `ExecutionService.startSystem` 作为队长/后 Assistant 的内部无工具执行入口。
- StartRun：active `plan_start_attempts` 唯一占用 + assignment snapshot + 单事务
  workflow version/Run/Plan 写入 + 事务外 kick；启动恢复回收遗留 attempt/dispatch。
- UI：团队页支持设置/更换队长；规划页支持队长状态、显式派工、派工失败重试、
  启动前指定成员、启动就绪门禁。
- 验证：`pnpm test` **98 文件 / 869 用例通过**；`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- 未执行：真实用户数据目录迁移、真实桌面端人工点击验收、真实队长 Provider 的无工具 E2E。
  迁移只在临时测试库验证，正式数据目录升级前仍需按 §J 备份。

> 标注约定：
> - **【已确认】**：已从当前代码或数据库结构读到的事实。
> - **【推荐设计】**：可以交给开发实现的方案。
> - **【待决策】**：需要老板确认的产品/架构选择。
> - **【待核实】**：当前代码无法完全证明、实施前需要专项验证的假设。

---

## A. 审查范围和 Git 基线

### A.1 审查前环境

| 项 | 值 |
|---|---|
| 工作目录 | `/Volumes/MacExt SSD/Self Work/Agentra` |
| Git 根 | 同工作目录 |
| 分支 | `main` |
| HEAD | `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f` |
| HEAD subject | `feat: agent governance, skills, multi-provider and architecture plan` |
| `git status --porcelain=v1` | 0 项 |
| `git status --short --ignored` | 35 条 ignored（dist、node_modules、.DS_Store、.claude 等），无业务文件 |
| staged / unstaged / deleted / untracked | 0 / 0 / 0 / 0 |
| worktrees | 仅 `/Volumes/MacExt SSD/Self Work/Agentra`（`main`） |
| merge / rebase / cherry-pick / bisect | 均不存在 |
| 运行中的 Agentra 进程 | Electron 实例（CDP 9228，数据目录 `~/agt-agents-clean4`）；无测试/构建/安装进程 |

### A.2 本轮新增文件

- `docs/agentra-assistant-team-leader-implementation-readiness.md`（本文件）
- 不修改 `docs/agentra-assistant-team-leader-architecture.md`

### A.3 结论口径

本文把「当前代码事实」和「目标设计」严格分开。所有关键结论都带文件/方法定位；无法确认的地方标成【待核实】。

---

## B. 真实现有架构与代码调用链

### B.1 Plan 生成

```text
PlanPage / TaskChatPanel
  → api.generatePlan
  → RPC plan.generate
  → PlanService.generate                 apps/core/src/services/plan-service.ts:126
  → PlannerService.generate              apps/core/src/services/planner-service.ts:97
  → ensurePlannerAgent                   planner-service.ts:464
  → ExecutionService.start               apps/core/src/services/execution-service.ts:375
  → Daemon / Provider CLI
  → extractOutput → PlanDraft.safeParse
  → PlannerService.validate              planner-service.ts:359
  → PlanService.persist                  plan-service.ts:152
```

【已确认】

- `PlanTask` 当前字段：`key, title, description, responsibilityRole, requiredAccessMode, suggestedAgentId, inputs, outputs, acceptanceCriteria, dependsOn, parallelGroup, approvalRequired, verification`；**没有 `teamId`**（`packages/protocol/src/methods/plan.ts:29-50`）。
- `PlanAssignment` 当前只有 `taskKey / agentId / agentName`（`plan.ts:80-85`）。
- `PlannerService.validate()` 当前直接产生最终 `PlanAssignment`：`suggestedAgentId` 存在则用它；否则 `findMatchingAgents(active, requiredAccessMode)` + `leastLoaded` 选一个（`planner-service.ts:413-459`）。
- Planner 的 Registry 只有 Agent，没有 Team（`planner-service.ts:523-550`、`:565-602`）。
- `PlanDraft` 是 `agentraPlanVersion:1`，没有 `teamId`。

### B.2 Plan 持久化、审批、启动

【已确认】

- `PlanService.persist()` 创建 `PlanRecord` + `PlanVersion(version=1)`，把 `draft.validation.assignments` 写入 `plan_versions.assignments_json`，并为每个任务创建 `plan_threads`（`plan-service.ts:152-221`）。
- `approve()` 要求 `pending_approval` 且 `validation.valid`，CAS 更新 Plan/PlanVersion 为 `approved`（`plan-service.ts:243-274`）。
- `startRun()` 当前流程（`plan-service.ts:300-380`）：
  1. 如果 Plan 已经是 `running` 且有 `workflowRunId`，返回现有 Run；
  2. 要求 `plan.status === 'approved'`；
  3. 要求 Plan 已绑定 Work，且 Work 为 `active`；
  4. `ensureAssignments(plan.workId, version.assignments)` 创建/恢复 Assignment；
  5. `compilePlanDefinition()` 生成 DAG；
  6. `workflows.createTemplate()` → `createDraft()` → `publish()`；
  7. `engine.startRun({ workId, workflowVersionId, requestId: requestId ?? randomUUID() })`；
  8. `plans.setRun()`、`versions.updateStatus('running')`、系统评论。
- `ensureAssignments()` 按 `version.assignments` 里的 Agent 建 Assignment，`workRole = plan-<agentId 后 8 位>`（`plan-service.ts:889-921`）。
- `assignments` 表 `UNIQUE(work_id, agent_id)`（`migrations.ts:170-185`）：同一 Agent 在一个 Work 只能有一个 workRole。
- `plan.reassignTask()` 只允许 `plan.status === 'running'`，要求目标 Agent 在同一 Work 有 **active 且同 workRole** 的 Assignment，然后写 `node_assignment_overrides`（`plan-service.ts:625-700`；`assignment-resolver.ts:35-77`）。
- `node_assignment_overrides` 只有 `assigned_by`，没有 reason（`migrations.ts:762-775`）。
- `PlanService` 没有 `revise` / `updatePlan` / `addVersion`；`PlanVersionRepository.create` 只在 `persist()` 调用一次（`plan-repository.ts:221-251`）。重新规划会生成新的 Plan ID，不是同一 Plan 的新版本。
- `PlanStatus` 枚举只有 `pending_approval / approved / rejected / running / completed / failed / cancelled`（`plan.ts:120-130`）；没有 dispatch/starting/ready。
- `syncRunStatus()` 只做只读派生，不把 Run 终态写回 `plans.status`（`plan-service.ts:951-963`）。因此 Plan 的终态在 DB 中可能仍是 `running`，读取时按 Run 派生。这是现有行为，设计不能假设 Plan 状态总是持久为 completed。

### B.3 Workflow Version 与 Run

【已确认】

- `workflow_versions` 有 published/deprecated 不可变触发器与 checksum（`migrations.ts:317-357`；`published-definition-provider.ts:45-104`）。
- `WorkflowRunService.createRun()`：
  - 校验 Work active；
  - 只接受 `published` version；
  - 重新校验定义；
  - `resolver.precheck(workId, definition)` 对所有 `agent_task` 做 Assignment 预检；
  - 在**一个事务**里创建 `workflow_runs`、`branch_runs`、每个节点的 `node_runs`，并把 Run 从 pending 推到 running（`run-service.ts:48-103`）。
- `WorkflowEngine.startRun()` 先 `runService.createRun`，再 `kick(runId, true)`（`engine.ts:99-110`）；`kick` 会触发 Scheduler/FairDispatcher，可能启动 Execution 进程。
- `PlannerService` 的 `ExecutionService.start` 是独立能力；`WorkflowEngine` 不用于规划执行。
- `workflow_runs.workflow_version_id` 是 Run 的唯一计划快照；`plan_versions.plan_json` 是计划内容快照；`plan_versions.assignments_json` 是 Planner 建议快照。

### B.4 Scheduler / FairDispatcher / ExecutionBridge

【已确认】

- `WorkflowScheduler.tick()` 处理同一 Run 的 blocked→ready→running，过 `DispatchGate`，用 CAS 把 ready 推 running（`scheduler.ts:186-363`）。
- `WorkflowFairDispatcher.tickAll()` 跨 Run 公平轮转，每个 Agent 每 Run 每轮最多启动 1 个节点（`fair-dispatcher.ts:46-95`）。
- `WorkflowExecutionBridge.onNodeStarted()` 用 `AssignmentResolver.resolveForNode()` 找 Assignment；用 `overrideAgentId` 查找 run/node override；然后 `executions.startForNode()`（`execution-bridge.ts:145-222`）。
- `ExecutionService.startForNode()` 与普通 `start()` 共用 `startInternal`，后者要求：Work active、Agent active、`toolPermissions.allow` 非空、Provider 可用、带 workId 时必须有 active Assignment、workdir 可锁；并发超限会进入队列（`execution-service.ts:437-500`、`:575` 附近）。
- `ExecutionService` 当前构造函数没有「system prompt override / tool permissions override」参数；`start(params)` 只有协议参数（`execution-service.ts:375-386`）。

### B.5 Team / Team Leader

【已确认】

- `teams` 当前字段：`id, name, description, instructions, settings_json, status, timestamps`；**没有 leader_agent_id**（`migrations.ts:125-134`、`:929-937`）。
- `team_members`：`id, team_id, agent_id, permissions_json, joined_at`，`UNIQUE(team_id, agent_id)`（`migrations.ts:136-144`）。
- `TeamService` 当前只有 create/update/archive + member add/remove/list（`team-service.ts:33-153`）；`update` 支持 name/description/instructions，没有 leader。
- `AssignmentService.create` 只校验 `teamId` 存在且 active，不校验 Agent 是否团队成员（`assignment-service.ts:82-90`）。
- 团队指引（`teams.instructions`）已在 `ExecutionService.composeSystemPrompt` 中注入：仅当 Work 关联团队且 Agent 是成员（`execution-service.ts:403-425`）。
- 团队页已有 Multica 风格 tabs：成员 / 指引 / 近期任务（`TeamsPage.tsx:55-470`），但没有队长。

### B.6 Agent 权限与工具授权

【已确认】

- `AgentAccessMode = analyze | edit`（`dto.ts:92-104`）。
- `ACCESS_MODE_TOOL_POLICY`：
  - analyze：`Read/Grep/Glob/WebFetch/WebSearch/Bash`，拒绝 `Write/Edit/MultiEdit/NotebookEdit`；
  - edit：允许读写 + Bash/Grep/Glob/WebFetch/WebSearch（`agent-service.ts:20-36`）。
- `ExecutionService.startInternal` 对 `toolPermissions.allow.length === 0` 直接拒绝 `AGENT_TOOLS_NOT_CONFIGURED`（`execution-service.ts:455-463`）。
- **结论：现有 `analyze` 仍允许 Bash；现有空 allow 仍无法表达真正的无工具 Agent。** 这是队长/助手的必须解决项（见 I）。

### B.7 Rework

【已确认】

- `ReworkService.onTestResult` 从 `test_result.pass=false` 的 `relatedTasks` 找可到达 Condition 的目标，创建 `rework_requests`（`rework-service.ts:329-352`）。
- 轮次上限来自 `definition.settings.reworkPolicy.maxRounds` 与已有请求，`continueExhausted`/`takeOverExhausted` 保留（`rework-service.ts:480-541`）。
- 返工为 target 创建新 attempt，下游用现有 DAG 调度；不新增 Retry/Loop 节点（`rework-service.ts:369-460`）。
- 执行时优先 `node_assignment_overrides`，否则原 Assignment；没有「队长重新分配」步骤（`execution-bridge.ts:157-160`）。
- `plan.reassignTask` 运行中改派要求目标 Agent 有同 workRole 的 active Assignment（`plan-service.ts:647-667`）。

### B.8 迁移系统

【已确认】

- 当前最高迁移 **v26**（`team_instructions`，`migrations.ts:1119-1125`）。
- `Migration` 类型只有 `up`，**没有 down**（`migrations.ts:8-18`）；每个迁移在 runner 中单独事务执行（`migrations.ts:1183-1213`）。
- rebuild 迁移通过 `rebuildsTables` 在事务外关闭外键、事务内执行 + `foreign_key_check`。
- `transaction()` 不支持嵌套：`BEGIN IMMEDIATE → fn → COMMIT`（`database.ts:21-38`）。
- 这是 StartRun 设计的关键约束：不能把现有 `WorkflowDefinitionService`（自带事务）和 `WorkflowRunService`（自带事务）简单包进外层 `transaction()`。

### B.9 UI 现状

【已确认】

- 导航（`App.tsx:36-64`）：总览/规划/项目/任务、审批中心/交付物/Agents/技能/团队、备份中心。
- PlanPage 生成计划、批准/拒绝、启动、转任务/项目、任务线程、运行中改派（`PlanPage.tsx:66-110`、`:320-335`、`:444-700`）。
- PlanPage 启动调用 `api.startPlanRun({ planId })`，**没有传 requestId**（`PlanPage.tsx:320-335`）。
- 任务详情：群聊 + 右侧概览/交付物/团队/设置（`WorksPage.tsx:54`、`:384-415`）。
- 团队页：成员/指引/近期任务 tabs（`TeamsPage.tsx:55-470`）。
- 没有队长 UI、没有 dispatch 状态、没有启动前改派。

### B.10 测试现状

- 93 个测试文件；上一轮最后验证 842 用例通过（本次审查按要求未重新运行测试）。
- 已覆盖：Planner 生成/复用/权限匹配、Plan 生成/审批/启动、PlanCompiler、AssignmentResolver、RunService、Scheduler/FairDispatcher、ExecutionBridge、Rework A-G、团队/Assignment 状态机。
- 未覆盖：Team leader、PlanTask.teamId、PlanTaskAssignment、PlanDispatch、PlanStartAttempt、启动前改派、队长无工具、TeamDispatchService。

---

## C. 最终职责边界（阶段 1/2）

### C.1 单一权威

| 数据/决策 | 唯一权威 | 写入者 |
|---|---|---|
| 计划任务内容、依赖、验收标准 | `plan_versions.plan_json`（不可变） | PlanService / PlanGenerator |
| 团队任务最终成员（启动前） | `plan_task_assignments` 的 active 行 | TeamDispatchService（队长结果）或 PlanAssignmentService（老板改派） |
| 已启动 Run 的成员 | published `workflow_versions.definition_json` + `node_assignment_overrides` | PlanStartService（编译）/ 老板运行中改派 |
| 派工执行状态 | `plan_dispatches` | TeamDispatchService |
| 启动请求/并发控制 | `plan_start_attempts` | PlanStartService |
| Work Assignment | `assignments` | PlanStartService（启动时）/ 运行中改派扩展 |

### C.2 Planner（PlanGenerator）

**可以**：

- 任务内容、依赖、并行、输入输出、验收标准、风险；
- 给每个任务选择 `teamId` 或（个人任务）`suggestedAgentId`；
- 给出非权威 Agent 建议（`suggestedAgentId` 只要不是团队任务的最终成员即可）。

**不可以**：

- 为 `teamId != null` 的任务决定最终执行 Agent；
- 写 `PlanTaskAssignment` / `Assignment`；
- 将 `plan_dispatches` 标记完成；
- 决定 Run 的最终分配。

### C.3 Team Leader

**可以**：

- 仅对 `teamId` 等于自己团队的任务，输出成员分配 + 理由；
- 读取团队指引、成员能力、权限、Provider、负载、任务要求。

**不可以**：

- 改 PlanTask 内容/依赖/团队归属/验收标准；
- 审批计划；
- 执行团队成员的任务；
- 直接写数据库/Assignment；
- 给其他团队派工；
- 分配团队外 Agent 或自己。

### C.4 老板

**可以**：

- 审批计划；
- 查看派工结果；
- 启动前改派（`plan.assignTask`）；
- 启动 Run；
- 按现有规则暂停/恢复/终止；
- 运行中改派（`plan.reassignTask`）；
- 返工超限继续/接管。

### C.5 校验落点

| 规则 | Core 校验位置 |
|---|---|
| Planner 不改团队最终成员 | `PlannerService.validate` + `PlanService.persist`（Team 任务禁止写权威 assignment） |
| 队长只派自己团队 | `TeamDispatchService.validateOutput` + `PlanAssignmentService` |
| Agent 是团队成员/active/权限匹配 | `PlanAssignmentService`（队长/老板共用） |
| 只有老板能审批 | `PlanService.approve` 的调用者身份 / RPC 层；Assistant 不暴露 approve 动作 |
| 只有老板能启动 | `PlanStartService.start` 的调用入口；Assistant 启动需确认动作（后续阶段） |
| 启动前改派 | `PlanAssignmentService.assignTask`（检查无 active start attempt） |
| 运行中改派 | `PlanService.reassignTask`（现有 + 扩展） |

> Prompt 只做提示，不能作为权限边界；所有规则必须在 Core 再校验。

---

## D. 完整状态机

### D.1 分层状态

**不要把全部状态塞进 PlanStatus。** 现有 `PlanStatus` 保持不变，新增两类状态：

```text
Plan.status（现有）
  pending_approval → approved → running → completed/failed/cancelled
                    ↘ rejected
  （completed/failed/cancelled 可能只从 Run 只读派生，见 B.2）

PlanDispatch.status（每 plan_version + team）
  pending → running → succeeded
     ↑        ↓
     └──── failed ←（可重试）
  pending/failed/running → cancelled（计划修订/拒绝/取消）

PlanTaskAssignment.status
  active → superseded（改派/修订）
  （没有 pending；队长原始输出不落库）

PlanStartAttempt.status（每 plan_version）
  preparing → starting → running
      ↓          ↓
    failed     failed（kick 前失败）
  preparing/starting → cancelled（计划取消/修订）
```

**Work Assignment（`assignments`）** 继续使用现有 `active/paused/completed/removed`，不新增 dispatch 状态。
**WorkflowRun** 继续使用现有状态机，不新增 dispatch 状态。

### D.2 用户可见阶段映射

| 用户阶段 | 派生条件 |
|---|---|
| 待审批 | `Plan.status = pending_approval` |
| 待派工 | `Plan.status = approved` 且至少一个 team task 无 active assignment，且无 dispatch running |
| 派工中 | 任一 `PlanDispatch.status = running` |
| 派工失败 | 任一 `PlanDispatch.status = failed` 且存在团队任务无 active assignment |
| 待启动 / 已就绪 | 所有 task 有 active `PlanTaskAssignment`；无 active `PlanStartAttempt`；`Plan.status = approved` |
| 启动中 | `PlanStartAttempt.status ∈ {preparing, starting}` |
| 运行中 | `Plan.status = running`（或 Run running） |
| 已完成 / 已取消 | `Plan.status` 经 Run 派生的 completed/cancelled |

### D.3 Plan 状态转换（保持现有）

| From | To | 触发 | 条件 |
|---|---|---|---|
| pending_approval | approved | 老板 approve | validation.valid |
| pending_approval | rejected | 老板 reject | comment 可选 |
| approved | running | PlanStartService 最终事务 | 全部 assignment active + no active start attempt |
| running | completed/failed/cancelled | Run 终态（只读派生） | 现有 syncRunStatus |
| 其他 | 其他 | 拒绝 | 现有 CAS |

> PlanStartService 不在 `approved` 之前启动；Plan `running` 后不允许 revise/dispatch/assign。

### D.4 PlanDispatch 状态机

| From | To | 触发者 | 条件 | 失败/重试 |
|---|---|---|---|---|
| pending | running | TeamDispatchService.dispatch | plan approved；无 start attempt；leader 存在 | — |
| failed | running | retry | 同上；attempt++ | 允许 |
| running | succeeded | TeamDispatchService | 队长输出全部校验通过；团队所有待派工 task 都有 active assignment | — |
| running | failed | TeamDispatchService | 执行失败/超时/JSON 非法/漏任务/成员/权限/容量错误 | 允许 retry |
| pending/failed/running | cancelled | PlanService.revise/reject/cancel | 计划版本失效 | 不再重试 |
| 其他 | 其他 | 拒绝 | CAS 失败 | — |

**部分提交规则（推荐）**：

- **单个团队内原子**：队长输出先全量校验，再在同一事务写该团队全部 `plan_task_assignments` + `plan_dispatch.succeeded`；任一任务失败则整队不写。
- **跨团队允许部分成功**：团队 A succeeded、团队 B failed 是合法的；`PlanStartService` 要求所有团队任务有 active assignment，否则拒绝启动。老板可以只重试失败的团队。
- **不允许一个团队内部分任务写入**。

### D.5 PlanTaskAssignment 状态

| From | To | 触发 | 条件 |
|---|---|---|---|
| （无） | active | 队长成功 / 老板 assign / legacy seed / personal seed | 满足团队/权限/容量校验 |
| active | superseded | 老板改派 / 计划修订 | 同一事务插入新 active |
| superseded | — | 终态 | 不回到 active |

- 同一 `(plan_version_id, task_key)` 最多一个 active（partial unique index）。
- 历史行永远保留；`source`/`assigned_by`/`reason` 可追溯。

### D.6 PlanStartAttempt 状态机

| From | To | 触发者 | 条件 |
|---|---|---|---|
| （无） | preparing | PlanStartService.start | plan approved；全部 assignment active；无 active attempt |
| preparing | starting | PlanStartService 最终事务 | 编译成功；workflow version + run 在同一事务创建并提交 |
| preparing | failed | PlanStartService | 编译/校验/事务失败；无 workflow/run 写入 |
| starting | running | PlanStartService.kick 后 | Run 已提交；kick 成功/已排队 |
| starting | failed | 仅当计划/运行被外部取消 | plan/run 不可继续 |
| preparing/starting | cancelled | 计划取消/修订 | 不再启动 |

- **active attempt 唯一**：`UNIQUE(plan_version_id) WHERE status IN ('preparing','starting')`。
- 失败后可重试；旧 attempt 保留历史，新的 attempt 重新快照。
- 启动成功后 attempt 保留 `workflow_version_id`/`run_id` 供审计。

### D.7 触发与非法转换

- 只有 `PlanService.approve` 能把 Plan 置 approved。
- 只有 `TeamDispatchService` 能改 dispatch 状态（除 PlanService 取消）。
- 只有 `PlanAssignmentService` 能写 active PlanTaskAssignment（队长结果和老板改派都走它）。
- 只有 `PlanStartService` 能创建 start attempt / 编译 workflow / 创建 Run 映射。
- 任何 CAS 失败都返回 `INVALID_PARAMS`/领域错误，不写任何后续行。
- 已 running 的 Plan 拒绝 `assignTask`、`dispatch`、`revise`。
- 有 active start attempt 的 Plan 拒绝 `assignTask`、`dispatch`、`revise`。

### D.8 并发规则

| 竞争 | 控制 |
|---|---|
| 两个 dispatch 请求 | `plan_dispatches` 单行 + `status='running'` CAS；第二个返回当前状态 |
| 两个老板改派 | 同一 active 行 partial unique；事务 supersede+insert；第二个 CAS 失败/重试 |
| 两个 StartRun | active `plan_start_attempts` partial unique + `BEGIN IMMEDIATE`；第二个返回 `PLAN_START_IN_PROGRESS` |
| StartRun 与老板改派 | Start attempt claim 后，`assignTask` 检查 active attempt 并拒绝 |
| StartRun 与 dispatch | StartRun 要求无 running dispatch；dispatch 拒绝 active start attempt |
| 计划修订与 dispatch/start | revise 要求无 active start attempt；取消所有旧 dispatch；旧队长输出按 plan_version_id 写不进新版本 |

### D.9 队长失败安全恢复

1. `plan_dispatches.status='failed'`，记录 `error_code/error_message/execution_id`；
2. 不写任何 active assignment；
3. Plan 保持 `approved`；不自动回退到 Planner 选人；
4. UI/Assistant 显示失败团队/队长/原因；
5. 可执行：重试该团队派工、更换队长、更换团队、老板手动 assign；
6. 若老板手动补齐该团队所有 task assignment，start readiness 可通过（dispatch 仍可显示 failed，UI 标注“队长失败，老板已手动分配”；或由 PlanAssignmentService 在全部补齐时把 dispatch 标为 manual-succeeded —— 这是【待决策】）。

推荐：**dispatch 状态保持失败历史，不伪装成功；start readiness 只看 active assignment**。UI 可以显示两行：派工失败 + 已手动补齐。

---

## E. 数据模型和约束

### E.1 PlanTask.teamId（协议 JSON，不是 DB 列）

【推荐设计】

```ts
teamId: z.string().min(1).nullable().default(null)
```

- `teamId != null`：团队任务；`suggestedAgentId` 只能是非权威建议。
- `teamId == null`：个人任务；`suggestedAgentId` 是最终分配依据。
- 旧 Plan JSON 没有该字段 → Zod default null，按个人任务/legacy 处理。
- 不新增 `plan_tasks` 表；计划内容仍在 `plan_versions.plan_json`（不可变）。
- 不修改 `PlanAssignment` 的权威语义：它继续是 Planner 建议快照；最终分配写入 `plan_task_assignments`。
- UI/API 需要新增 `PlanTaskAssignment` DTO（或 PlanGetResult 增加 `taskAssignments`）。

**校验（PlannerService/PlanService）**：

1. `teamId` 必须存在且 `status='active'`；
2. `teamId != null` 时不得把 `suggestedAgentId` 当作最终成员；若填写，必须是该团队 active 成员（建议不直接拒绝外部 Agent，而是标记非权威/忽略；推荐拒绝，保持计划干净）；
3. `teamId == null` 时 `suggestedAgentId` 必须存在、active、`accessMode` 匹配；
4. 团队没有 leader **不使计划内容非法**，但会让 dispatch 失败（见 D.9）；UI 提示先设置队长。

### E.2 plan_task_assignments

```sql
CREATE TABLE plan_task_assignments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('planner','leader','user','legacy')),
  assigned_by TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_plan_task_assignments_active
  ON plan_task_assignments(plan_version_id, task_key)
  WHERE status = 'active';
CREATE INDEX idx_plan_task_assignments_plan
  ON plan_task_assignments(plan_id, plan_version_id);
CREATE INDEX idx_plan_task_assignments_agent
  ON plan_task_assignments(agent_id);
```

| 字段 | 类型 | 可空 | 默认 | 约束/说明 |
|---|---|---|---|---|
| id | TEXT | 否 | — | 主键 |
| plan_id | TEXT | 否 | — | FK plans，删计划级联 |
| plan_version_id | TEXT | 否 | — | FK plan_versions，删版本级联 |
| task_key | TEXT | 否 | — | 与 PlanVersion.plan.tasks.key 对应 |
| team_id | TEXT | 是 | NULL | 团队任务；FK teams SET NULL |
| agent_id | TEXT | 否 | — | FK agent_profiles RESTRICT（保留历史） |
| source | TEXT | 否 | — | planner/leader/user/legacy |
| assigned_by | TEXT | 否 | — | leader agentId / user id / system |
| reason | TEXT | 是 | NULL | 队长或老板理由 |
| status | TEXT | 否 | — | active/superseded |
| created_at | TEXT | 否 | — | 创建时间 |
| updated_at | TEXT | 否 | — | 状态变更时间 |

**回答设计问题**：

1. 一个 PlanTask 是否只能有一个 active Assignment？**是**；partial unique index 保证。
2. 重新派工更新还是新增？**新增**；旧行 `superseded`，保留审计。
3. 原队长派工记录是否保留？**保留**；`source='leader'` 行被 superseded，不删除。
4. 避免两个 Agent 同时认领？partial unique + Core 事务 + 全量校验。
5. 如何绑定 PlanVersion？`plan_version_id` 外键；新版本新行，旧版本行保留。
6. 已启动 Run 如何固定？start attempt 的 `assignment_snapshot_json` + 编译后的 published workflow version；Run 引用不可变 version。

### E.3 plan_dispatches

```sql
CREATE TABLE plan_dispatches (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  leader_agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  execution_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_version_id, team_id)
);

CREATE INDEX idx_plan_dispatches_plan_status
  ON plan_dispatches(plan_id, status);
```

- 一个 PlanVersion + Team 只有一行；重试递增 attempt，不新增行。
- `leader_agent_id` 记录本次派工使用的队长；更换队长后重试更新该字段并审计。
- `execution_id` 关联队长执行，便于查看日志。
- `status` 只在 TeamDispatchService 内部变更；PlanService 修订时置 cancelled。

### E.4 plan_start_attempts

```sql
CREATE TABLE plan_start_attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('preparing','starting','running','failed','cancelled')),
  assignment_snapshot_json TEXT NOT NULL,
  plan_checksum TEXT NOT NULL,
  workflow_version_id TEXT,
  workflow_run_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_plan_start_attempts_active
  ON plan_start_attempts(plan_version_id)
  WHERE status IN ('preparing','starting');
```

- `assignment_snapshot_json`：claim 时从 active `plan_task_assignments` 读取并固化的数组；包含 taskKey/teamId/agentId/workRole/source/assignedBy/reason。
- `request_id`：客户端 requestId 或服务端生成的 UUID；唯一，用于网络重试。
- active 唯一索引阻止同一 PlanVersion 两个并发的 StartRun。
- `workflow_version_id`/`workflow_run_id` 在最终事务写入，用于审计与重试。
- 失败/取消行保留。

### E.5 teams.leader_agent_id（v27）

```sql
ALTER TABLE teams ADD COLUMN leader_agent_id TEXT
  REFERENCES agent_profiles(id) ON DELETE SET NULL;
CREATE INDEX idx_teams_leader ON teams(leader_agent_id);
```

- 允许 NULL；旧团队不猜测。
- 不新增唯一约束（一个 team 一个列）。
- Core 保证：leader active、团队 active、leader 是团队成员、建议 analyze。
- 团队归档时字段保留；dispatch 因 team 非 active 失败。
- Agent 归档/停用不自动清空 leader；dispatch 失败并提示老板换队长。

### E.6 是否需要修改 assignments 表

**不新增列**。理由：

- `assignments` 仍然是 Work 级执行岗位，由 StartRun 从 PlanTaskAssignment 生成；
- `assignments.team_id` 可填入团队任务的 teamId（可选，便于展示）；
- 现有 `UNIQUE(work_id, agent_id)` 保留；
- 运行中改派仍用 `node_assignment_overrides`。

运行中改派到团队新成员时，若目标没有 Assignment，设计见 G.3。

### E.7 权威时序

```text
PlanVersion.plan_json（任务内容/teamId，不可变）
  + plan_task_assignments active（启动前权威）
  → PlanStartAttempt.assignment_snapshot_json（冻结）
  → workflow_versions.definition_json（published，不可变）
  → workflow_runs.workflow_version_id（Run 快照）
  → node_assignment_overrides（运行中改派，未来 attempt）
```

---

## F. TeamDispatchService 接口设计

### F.1 职责

- 读取 PlanVersion 中 `teamId` 的任务，按团队分组；
- 确保每个团队有 active leader；构造队长 prompt；
- 通过 `ExecutionService` 的 **系统执行入口** 跑队长（无工具）；
- 解析/校验结构化输出；
- 在事务内写 `plan_task_assignments` + `plan_dispatches`；
- 失败时只更新 dispatch failed，不写 assignment；
- 不修改 Plan 内容、不审批、不启动 Run、不调度节点。

### F.2 类型

```ts
type TeamDispatchErrorCode =
  | 'PLAN_NOT_APPROVED'
  | 'PLAN_CHANGED'
  | 'DISPATCH_IN_PROGRESS'
  | 'LEADER_NOT_SET'
  | 'LEADER_INACTIVE'
  | 'LEADER_NOT_MEMBER'
  | 'LEADER_TOOL_CONTROL_UNSUPPORTED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'UNKNOWN_TASK'
  | 'MISSING_TASK'
  | 'DUPLICATE_TASK'
  | 'AGENT_NOT_MEMBER'
  | 'AGENT_INACTIVE'
  | 'ACCESS_MODE_MISMATCH'
  | 'CAPACITY_EXCEEDED'
  | 'DISPATCH_CANCELLED'

type LeaderAssignment = { taskKey: string; agentId: string; reason: string }

type TeamDispatchResult = {
  planId: string
  planVersionId: string
  teamId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  assignments: LeaderAssignment[]
  executionId: string | null
  error: { code: TeamDispatchErrorCode; message: string } | null
}
```

### F.3 方法

```ts
class TeamDispatchService {
  /** 计划批准后为每个含团队任务的 team 建 pending dispatch 行（可与 approve 同事务） */
  ensureDispatches(planId: string, planVersion: PlanVersion): PlanDispatchRecord[]

  /** 派工所有 pending/failed 团队；顺序或有限并发（推荐顺序） */
  dispatch(planId: string): Promise<TeamDispatchResult[]>

  /** 只重试一个团队 */
  retry(planId: string, teamId: string): Promise<TeamDispatchResult>

  /** 计划修订/拒绝/取消：标记 cancelled；尽力取消正在运行的队长 execution */
  cancelForVersion(planVersionId: string, reason: string): Promise<void>

  /** 纯函数，供测试 */
  validateLeaderOutput(input: {
    planVersion: PlanVersion
    team: Team
    members: TeamMember[]
    leader: AgentProfile
    tasks: PlanTask[]
    output: unknown
    activeAssignments: PlanTaskAssignment[]
  }): { ok: true; assignments: LeaderAssignment[] } | { ok: false; code: TeamDispatchErrorCode; message: string }
}
```

### F.4 队长 prompt

必须包含：

- 团队名称、描述、团队指引；
- 队长自己的擅长的工作/工作指令（只作为自己的角色说明）；
- 成员花名册（排除队长）：
  - id/name/description/accessMode/skillNames/providerName/maxConcurrency/currentActiveExecutions；
- 待派工任务（只含未 active 的任务）：
  - taskKey/title/description/requiredAccessMode/acceptanceCriteria/dependsOn/parallelGroup；
- 硬规则：
  - 只选本团队 active 成员；
  - 不选队长；
  - 权限必须匹配 requiredAccessMode；
  - 不得遗漏/重复；
  - 输出 JSON；不执行任务；不使用工具。

输出 Shape：

```json
{"assignments":[{"taskKey":"frontend","agentId":"agt-...","reason":"..."}]}
```

### F.5 校验顺序

1. Plan/Version 仍 approved，无 running/failed attempt；
2. 团队 active；leader set/active/member；leader toolControl 允许无工具执行；
3. 任务集合来自 plan version；过滤已被老板 active 分配的 task（队长只派未分配）；
4. 输出 JSON 结构；
5. task 完整集合（无多、无漏、无未知）；
6. agent 是团队 active 成员、不是 leader；
7. agent accessMode 匹配；
8. 同一 wave 内 agent 分配数 ≤ maxConcurrency + 当前 active executions；
9. 全部通过后，事务写 assignments + dispatch succeeded；
10. 任一失败 → dispatch failed（不写 assignments）。

### F.6 触发方式

推荐：**老板批准后，UI/Assistant 显式触发 `plan.dispatch`**；`approve` 只创建 pending dispatch 行并返回。原因：

- 不把模型执行塞进 approve RPC；
- 派工失败/重试在 UI 可见；
- 老板可以在派工前换队长/团队成员；
- Assistant 后续可发 `dispatch` 动作（需确认）。

【待决策】是否在 approve 后自动触发 dispatch（异步事件），还是保留显式按钮。推荐显式；若需要自动化，可后续加“批准并派工”按钮。

---

## G. 老板改派接口设计

### G.1 启动前 `plan.assignTask`

```ts
PlanAssignTaskParams = {
  planId: string
  taskKey: string
  agentId: string
  reason: string          // 必填，审计
  decidedBy: string
  requestId?: string       // 可选幂等
}
```

校验：

- Plan 存在、`status in ('pending_approval','approved')`（推荐只允许 approved 后、pending 前？见下）；
- 使用 latest PlanVersion；task 存在；
- 无 active `plan_start_attempt`；拒绝 `PLAN_START_IN_PROGRESS`；
- 团队任务：agent 是该 team active 成员、非 leader、accessMode 匹配、容量满足；
- 个人任务：agent active、accessMode 匹配；
- 如果该 team dispatch 正在 running，拒绝 `DISPATCH_IN_PROGRESS`（避免与队长结果竞争）；
- 事务：旧 active 行 superseded → 插入新 active → audit + plan 系统评论；
- 返回 `PlanTaskAssignment` DTO。

【推荐】允许 Plan `pending_approval` 和 `approved` 都可改派；但 Plan `pending_approval` 未批准时改派不会启动，意义有限。建议只允许 `approved` 且未 start；待决策。

### G.2 手动补齐与 dispatch 状态

- 如果 dispatch failed，老板可以逐个 task 手动 assign；
- `PlanStartService` readiness 只看 active assignments，不看 dispatch status；
- UI 显示「队长派工失败」+「老板已手动分配 N/M」；当 N=M 时可启动；
- 不自动把 dispatch 改成 succeeded，避免伪造队长成功。若产品希望“已手动完成”的单一状态，可增加 `resolution_source='user'` 或 `manual` 状态（待决策）。

### G.3 运行中 `plan.reassignTask`（现有扩展）

现有实现（`plan-service.ts:625-700`）要求目标 Agent 在同一 workRole 有 active Assignment。团队任务运行中改派到另一个团队成员时，新成员可能没有该 workRole 的 Assignment。

【推荐最小扩展】

- 保留 `plan.reassignTask` 的 API 和语义；
- 对团队任务，目标 Agent 必须是该团队 active 成员；
- 如果目标 Agent 已有同 workRole 的 active Assignment → 直接写 override；
- 如果目标 Agent 没有 Assignment → **在同一事务创建** `workRole = currentAssignment.workRole` 的 Assignment（`AssignmentService.create`），再写 override；
- 如果目标已有不同 workRole 的 Assignment → 拒绝 `ASSIGNMENT_ROLE_CONFLICT`，提示老板选择其他成员或先调整岗位；
- 写 audit + 系统评论，reason 必填（扩展 Params）。
- 该扩展只影响运行中改派；不改变 StartRun 快照。

风险：运行中创建 Assignment 会改变 Work 的岗位集合，但只用于目标节点未来 attempt；不自动改其他节点。需要测试与审计。

### G.4 不可改派的状态

- Plan 未 approved / 已 running 的启动前 assign → 拒绝；
- 有 active start attempt → 拒绝；
- 目标 Agent 不是团队成员/非 active/权限不匹配 → 拒绝；
- 同一 task 已有 active assignment 且新 agent 相同 → 幂等返回/拒绝重复；
- 队长正在派工该 team → 拒绝。

---

## H. StartRun 原子性与一致性设计

### H.1 现有实现的真实问题

【已确认】

1. `PlanPage` 调用 `api.startPlanRun({ planId })`，**没有 requestId**（`PlanPage.tsx:320-335`）。
2. `PlanService.startRun` 没有 in-process 锁，也没有 DB 级「启动占用」；两个并发请求可以同时通过 `plan.status === approved` 检查。
3. `ensureAssignments` 先于 workflow version 创建；如果后续失败，已创建的 Assignment 会残留。
4. `workflows.createTemplate/createDraft/publish` 各自独立事务；如果 Run 创建失败，会留下 orphan template/version。
5. `engine.startRun` 内含 `runService.createRun`（事务）和 `kick`（会启动进程）；两者不在同一事务。
6. `plans.setRun` 在 Run 已创建之后；如果 setRun CAS 失败，代码会抛「run was started anyway」，但不会取消 Run。
7. `versions.updateStatus` 与系统评论在 setRun 之后，另一个事务。
8. `PlanService.startRun` 忽略 `engine.startRun` 返回的 `schedulingError`，可能返回成功但未调度。
9. `transaction()` 不支持嵌套，不能简单地把现有 service 调用包进一个大事务。

### H.2 推荐设计：StartAttempt + 单事务写入 + 事务外 kick

【推荐设计】把 StartRun 分成「claim / compile / commit / kick」四段：

#### 1) Claim（DB 事务）

```sql
BEGIN IMMEDIATE;
-- 读 plan/version/assignments/agents/teams
-- 校验 plan approved、latest version、work active、所有 task 有 active assignment
-- 校验 agent active/团队/权限/容量
-- 插入 plan_start_attempts(status='preparing', assignment_snapshot_json, request_id, plan_checksum)
-- partial unique 保证只有一个 active attempt
COMMIT;
```

- 在 claim 事务内读取 active `plan_task_assignments` 并写入 `assignment_snapshot_json`（不可变）；
- 校验全部通过才插入；失败不写 attempt；
- 并发启动：第二个请求的 partial unique 插入失败 → 返回 `PLAN_START_IN_PROGRESS`（附现有 attempt 状态）；
- 客户端 requestId 或服务端 UUID 作为 `request_id`；网络重试返回同一 attempt。

#### 2) Compile（纯 CPU，事务外）

- 从 `version.plan` + `assignment_snapshot_json` 编译 DAG；
- 计算 workRole（建议沿用 `plan-<agentId 后 8 位>`；一个 Agent 一个 Work 一个 role）；
- 计算 checksum；失败 → attempt failed（无 Run/Version 写入）。

#### 3) Commit（单 DB 事务）

```sql
BEGIN IMMEDIATE;
-- 重新确认 plan.status='approved'，attempt 仍为 preparing
-- 创建 workflow_template + workflow_version(draft) + publish（事务内）
-- 创建 workflow_run + branch_runs + node_runs（事务内，precheck 用 snapshot，不重新读可变的 assignments）
-- UPDATE plans SET status='running', workflow_version_id, workflow_run_id WHERE id=? AND status='approved'
-- UPDATE plan_versions SET status='running'
-- UPDATE plan_start_attempts SET status='starting', workflow_version_id, workflow_run_id
-- INSERT plan_comments（执行已启动）
COMMIT;
```

- 所有 DB 写入在同一事务；任何一步失败全部回滚，不留 orphan workflow version/Run，Plan 仍 approved，attempt 标记 failed（另一个小事务）。
- WorkflowDefinitionService / WorkflowRunService 需要新增 **transaction-aware** 方法：
  - `createPublishedVersionInTransaction(...)`（不再 BEGIN/COMMIT）；
  - `createRunInTransaction(...)`（不再 BEGIN/COMMIT，不 kick）；
  - 或 `WorkflowEngine.startRunAfterCommit` 只负责 kick。
- **不要**把 `kick` 放进事务：`kick` 会启动进程、写 Execution，属于长操作。

#### 4) Kick（事务外）

```ts
await engine.kick(runId, true)
```

- 成功：attempt → running；plan 已 running；Run 已 running。
- 失败：Run/Plan 已提交，不能回滚；attempt 标记 `scheduling_error`（新增字段或 error_code），UI 显示“已启动但调度失败，点击重试调度”；`plan.startRun` 重试时看到 running + attempt starting，只调用 kick，不新建 Run。
- 这是「schedulingError」的可恢复路径，不是数据不一致。

### H.3 事务边界总结

| 操作 | 是否在事务内 | 原因 |
|---|---|---|
| claim attempt + snapshot | 是 | 并发唯一 + 一致读 |
| 编译 DAG | 否 | 纯 CPU，无 DB |
| workflow version 创建/发布 | 是（最终事务） | 与 Run/Plan 原子 |
| Run/Branch/Node 创建 | 是（最终事务） | 与 Plan 状态原子 |
| `plans.setRun` | 是（同一最终事务） | CAS + 原子 |
| `plan_versions.updateStatus` | 是（同一最终事务） | 状态一致 |
| system comment | 是（同一最终事务） | 审计一致 |
| `engine.kick` | 否 | 启动进程/异步调度，长操作 |
| dispatch leader execution | 否（在 StartRun 之前，单独业务） | 模型执行，不应占用 DB 长事务 |

### H.4 失败窗口与补偿

| 失败点 | 结果 | 补偿 |
|---|---|---|
| claim 校验失败 | 无 attempt/无写入 | 返回错误 |
| claim 后编译失败 | attempt preparing → failed | 无 workflow/run |
| 最终事务前崩溃 | attempt preparing 残留 | Core 启动扫描 stale attempt，标记 failed；无 Run/Version |
| 最终事务中失败 | 全回滚 | attempt failed；Plan approved |
| 最终事务提交后 kick 失败 | Plan running + Run exists + attempt starting | 重试 kick；不新建 Run |
| 最终事务提交后进程崩溃 | Plan running + Run exists + attempt starting | Core 启动恢复：tick/kick Run；attempt 标记 running |
| 老板改派与 claim 竞争 | claim BEGIN IMMEDIATE 先执行或 assignTask 先；后者被 active attempt 拒绝 | 返回冲突 |
| 两个 StartRun | partial unique 只有一个 claim | 第二个返回 `PLAN_START_IN_PROGRESS` |
| WorkflowVersion 已建、Run 失败 | 单事务下不会发生 | 若采用 saga 替代方案，记录 attempt.workflow_version_id 并清理/复用 |

### H.5 并发与读一致性

- **读一致性**：claim 事务 `BEGIN IMMEDIATE` + active assignment snapshot；之后老板改派被 active attempt 检查拒绝；dispatch 也被拒；因此 compile 期间 assignment 不会变化。
- **写一致性**：最终事务 CAS `plans.status='approved'`；如果 Plan 被并发改为 rejected/cancelled，事务失败，不创建 Run。
- **Run 快照**：workflow_versions 不可变 + checksum；Run 只引用 versionId；PlanTaskAssignment 后续变化不影响已启动 Run。
- **老板改派期间启动**：claim 事务会等待写锁；若 assignTask 先提交，claim 读到新 assignment；若 claim 先，assignTask 检测 active attempt 拒绝。两者线性化。

### H.6 实施结论

【推荐设计】采用 `plan_start_attempts` + 单事务版本/Run/Plan 写入 + 事务外 kick。

【待决策】如果老板不接受对 WorkflowDefinitionService/WorkflowRunService 的事务化重构，则 StartRun 无法闭环；此时阶段 2 应判 NOT READY，或退回到「先锁定 plan_start_attempts + orphan 记录 + 清理 job」的较弱方案（仍可能有 orphan workflow version，但不会重复 Run）。

---

## I. 队长权限设计

### I.1 当前问题（已确认）

- `analyze` 工具策略允许 `Bash`（`agent-service.ts:20-25`）。
- `ExecutionService` 拒绝空 allow（`execution-service.ts:455-463`）。
- 因此不能简单把队长设为 `analyze` 就认为“无工具”；队长仍可能执行 Bash。
- `ProviderCapabilities.toolControl` 对 Claude Code 是 native，对部分 one-shot Provider 是 emulated/unsupported；不同 Provider 的实际工具限制不同。

### I.2 推荐最小改动

1. **新增 Core 内部执行入口**（不暴露 RPC）：

```ts
type SystemExecutionPurpose = 'team_dispatch' | 'assistant_chat' | 'assistant_plan'

ExecutionService.startSystem(
  params: ExecutionStartParams,
  options: {
    purpose: SystemExecutionPurpose
    systemPromptOverride: string
    toolPermissionsOverride: ToolPermissions
  },
): Promise<Execution>
```

- 仅 TeamDispatchService/后续 AssistantService 调用；
- RPC handler 不传递该 options；
- 审计记录 `purpose` + 实际 tool policy；
- 不改变普通 `start()` 的 U3 空 allow 拦截。

2. **队长固定工具策略**：

```ts
const TEAM_LEADER_TOOL_POLICY: ToolPermissions = {
  version: 1,
  allow: [],                       // 或严格只读 Read（见下）
  deny: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
}
```

- 推荐 `allow: []` + `deny` 全部执行/写工具；如果 Provider 无法表达空 allow，则 `allow: ['Read']` 且 deny Bash/Write/Edit/NotebookEdit；
- 队长 prompt 不依赖工具；它只需要 Core 注入的花名册/任务数据；
- 如果 Provider `toolControl` 不是 `native`，TeamDispatchService 拒绝派工并报 `LEADER_TOOL_CONTROL_UNSUPPORTED`，而不是假装安全。
- Claude Code 的 `--allowedTools/--disallowedTools` 是 native；CodeBuddy 兼容 Claude 参数；Codex/Gemini/Grok/Antigravity 的 headless 工具控制是 emulated/unsupported，不能作为第一阶段队长 Provider，除非实现专用只读模式。
- 这是【待决策】产品约束：第一阶段队长是否只允许 Claude Code/CodeBuddy Provider？推荐是；否则无法保证“队长不能 Bash/写文件”。

3. **队长 Agent 校验**：

- `teams.leader_agent_id` 指向 active Agent；
- 必须是团队成员；
- `systemKind` 可为 null（普通 Agent），但 TeamDispatchService 使用系统执行入口，覆盖其工具策略；
- 建议 accessMode analyze，避免用户误把它当编辑 Agent；
- 队长排除在团队任务候选之外；
- 队长不自动成为任何 PlanTaskAssignment 的 agent。

4. **禁止绕过**：

- TeamDispatchService 不调用公开 `ExecutionService.start`；
- 队长的输出只作为 JSON，不执行任何工具；
- 派工结果由 Core 再验证，不直接写 Assignment；
- Assistant 不审批计划；审批仍 `PlanService.approve`（老板）。

### I.3 测试要求

- 队长执行时 `allowedTools` 不包含 Bash/Write/Edit；
- 队长 Provider 无 native toolControl → 派工失败；
- 队长尝试输出 shell/工具指令不会被执行（模型输出只解析 assignments）；
- 队长 Agent 被停用/非成员 → 派工失败；
- 队长被分配为任务候选 → 拒绝；
- 队长 Agent 的普通（非系统）执行仍受现有 U3 策略约束，不被内部入口绕过。

---

## J. v27 / v28 迁移方案

### J.1 v27：team leader

**Up**

```sql
ALTER TABLE teams ADD COLUMN leader_agent_id TEXT
  REFERENCES agent_profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_teams_leader ON teams(leader_agent_id);
```

- 不重建 teams；
- 不 backfill；旧团队 leader 为 NULL；
- 外键 SET NULL：Agent 被删除时清空，但 Agent 归档不是删除；
- 迁移 runner 单事务；失败回滚，user_version 不变。

**Down（手动，当前迁移系统无 down）**

```sql
DROP INDEX IF EXISTS idx_teams_leader;
ALTER TABLE teams DROP COLUMN leader_agent_id;
```

- 先备份；Down 会丢失 leader 配置；
- SQLite DROP COLUMN 需要确认当前 SQLite 版本；迁移测试验证。

**旧团队**

- leader null：允许查看/编辑/指引；团队任务 dispatch 失败 `LEADER_NOT_SET`；
- 不自动把第一个成员/创建者设为 leader；
- UI 显示「设置队长后才能派工」。

**队长变更**

- 设置/转让：事务内确保 Agent active、团队成员（缺则加入）、更新 leader；旧 leader 保留成员；
- 移除成员：若 agent == leader，拒绝 `LEADER_MUST_BE_REPLACED`；
- 禁用/归档 Agent：不自动清空 leader；dispatch 失败 `LEADER_INACTIVE`；老板换队长；
- 归档团队：leader 保留；dispatch 先检查 team active。

**迁移后验证 SQL**

```sql
SELECT COUNT(*) FROM teams
WHERE leader_agent_id IS NOT NULL
  AND leader_agent_id NOT IN (
    SELECT agent_id FROM team_members WHERE team_id = teams.id
  ); -- 期望 0

SELECT t.id, t.name, t.leader_agent_id, a.status
FROM teams t JOIN agent_profiles a ON a.id = t.leader_agent_id
WHERE a.status != 'active'; -- 报告，不阻止迁移；UI 提示更换

PRAGMA foreign_key_check; -- 期望空
```

### J.2 v28：PlanTaskAssignment / PlanDispatch / PlanStartAttempt

**Up** 建三张表 + 索引（DDL 见 E.2/E.3/E.4）：

```sql
CREATE TABLE plan_task_assignments (...);
CREATE UNIQUE INDEX idx_plan_task_assignments_active
  ON plan_task_assignments(plan_version_id, task_key)
  WHERE status='active';
CREATE INDEX ...;

CREATE TABLE plan_dispatches (...);
CREATE UNIQUE INDEX ... (plan_version_id, team_id);

CREATE TABLE plan_start_attempts (...);
CREATE UNIQUE INDEX idx_plan_start_attempts_active
  ON plan_start_attempts(plan_version_id)
  WHERE status IN ('preparing','starting');
CREATE INDEX ...;
```

- **PlanTask.teamId 不需要 DB ALTER**：它存在 `plan_versions.plan_json`；新 Zod schema default null，旧 JSON 自动兼容。
- 所有 FK 在表创建时声明；不重建旧表。
- 事务：迁移 runner 自动 `BEGIN IMMEDIATE`；失败整体回滚，user_version 不变。
- 迁移失败后：旧表/旧数据不变；可重试（如果 DDL 未部分提交）；若 DDL 部分提交，runner 回滚会撤销。

**Down（手动，需备份）**

```sql
DROP TABLE plan_start_attempts;
DROP TABLE plan_dispatches;
DROP TABLE plan_task_assignments;
```

- 先备份；Down 会丢失派工/启动历史；
- 迁移系统没有 down，必须通过恢复备份或手工 SQL 执行。

**旧数据**

- 旧 PlanVersion 无 teamId、无 PlanTaskAssignment：legacy 路径（K）；
- 旧 Team 无 leader：不 backfill；
- 旧 Assignment/WorkflowRun 不变；
- 不修改 `plan_versions.assignments_json`（历史建议快照）。

**迁移前备份**

- 使用现有备份中心创建 manual 备份（VACUUM INTO + Manifest SHA-256）；或至少复制数据库；
- 迁移前确认备份完整性；迁移失败不得继续启动（现有 restore/backup 约束）。

**迁移后验证**

```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name IN
 ('plan_task_assignments','plan_dispatches','plan_start_attempts'); -- 3

PRAGMA foreign_key_check; -- 空

SELECT plan_version_id, task_key, COUNT(*) FROM plan_task_assignments
WHERE status='active' GROUP BY plan_version_id, task_key HAVING COUNT(*) > 1; -- 空

SELECT plan_id, current_version FROM plans
WHERE status='running' AND workflow_run_id IS NULL; -- 旧数据/异常报告
```

### J.3 迁移独立评审条件

【结论】**v27 可以独立评审**；v28 建议与 StartRun 事务化改造一起评审，因为：
- `plan_start_attempts` 的 unique 语义直接决定并发启动；
- legacy 路径和迁移回滚需要与 StartRun 代码同批测试；
- 如果先上 v28 但 StartRun 未改，会出现表存在但语义未接入的半成品。

---

## K. Legacy 兼容方案

### K.1 识别条件

【推荐设计】在 PlanStartService 中：

```text
legacy 条件：
  plan_version.plan.tasks 全部 teamId === null
  且 plan_task_assignments 中没有该 plan_version_id 的 active 行
```

- 旧 PlanVersion 的 `teamId` 通过 Zod default null；
- 旧 PlanVersion 没有 `plan_task_assignments` 行；
- 新 personal-only plan 也可能满足前两条；可以走同一 legacy seed 路径，不要求队长。
- 不做时间戳判断（不可靠）。

### K.2 Legacy 启动

- 从 `plan_versions.assignments_json` 生成 `plan_task_assignments`（`source='legacy'`），同一事务：
  - 每个 assignment 有 agentId；task 必须存在；agent 必须 active；
  - 如果 assignment 缺失/agent 无效/权限不匹配 → 启动失败（保持现有行为，不静默改派）。
- 然后使用同一个 StartAttempt/StartRun 流程；
- 不创建 dispatch 行，不调用队长；
- 旧 Plan 的 `workRole` 仍按 `plan-<agentId>` 生成。

### K.3 退出策略

- 新 Plan（v28 之后创建）：
  - team task：必须有 leader dispatch 或老板 assign；
  - personal task：在审批/启动时 seed `source='planner'` 行；
  - 不再走 legacy。
- Legacy 行保留历史；可在未来一次迁移中把旧计划归档后删除 legacy 分支。
- 不自动把旧计划转换为团队任务；不补 teamId。

### K.4 旧 Team / 旧 Planner

- 旧 Team 无 leader：不猜；团队任务派工失败；老板手动 assign 或设置队长后重试；
- 旧 Planner Agent（systemKind planner）：本阶段不重命名；Assistant 后续处理；团队派工不依赖 Planner Agent；
- 旧 Assignment/NodeRun/WorkflowVersion/Run：不改；已运行 Run 不受新表影响。

---

## L. ReworkPolicy 兼容方案

### L.1 现有行为（已确认）

- 测试失败 → `relatedTasks` → 目标 NodeRun → ReworkRequest；
- 目标及必要下游创建新 attempt；
- 执行时 resolver 先看 node override，再看原 Assignment；
- 不新增 Retry/Loop 节点；
- 轮次上限/继续/接管已有测试。

### L.2 本阶段要求

1. 返工 attempt 继续使用**原 Assignment**；如果存在 node override，用 override；
2. 不调用 TeamDispatchService，不重新随机派工；
3. 不改变 maxRounds、continueExhausted、takeOverExhausted；
4. 不改变 Artifact/NodeRun 历史；
5. 只重新执行 target 及下游；
6. 原 Agent 失效时 fail closed，不自动换人。

### L.3 Agent 失效处理

- `AssignmentResolver` 找不到 active assignment / target agent 不是 active → `WorkflowAssignmentError`，节点 failed；ExecutionBridge 写结构化失败，Plan 线程可见；
- 老板入口：
  - 运行中 `plan.reassignTask`（扩展团队任务：目标团队成员无 Assignment 时，在同一事务创建同 workRole Assignment，再写 override；见 G.3）；
  - 如果目标已有不同 workRole Assignment → 拒绝，提示换人；
  - 不自动选择替代 Agent。
- ReworkRequest 本身不记录 teamId；不修改 rework 表；靠 task/node 的 assignment 解析。
- 返工轮次仍按 `target_node_run_id + round` 幂等；重启不重复计数（现有测试 `rework-restart.test.ts`）。

### L.4 测试

- 返工 attempt 的 agent 与首次 Assignment 相同；
- node override 存在时使用 override；
- 原 Agent 禁用 → 节点 failed，不自动换人；
- 老板改派团队新成员 → 创建 Assignment + override，下一 attempt 生效；
- 返工不调用队长（teams/executions 不应出现 dispatch 执行）；
- 轮次上限/继续/接管/重启恢复不回归。

---

## M. 测试与 QA 验收矩阵

> 以下为**设计验收矩阵**。每条都必须有对应测试；不允许 skip。数据一致性要求指：DB 中 plan/dispatch/assignment/run 的关系必须与预期一致，不能只看 UI。

### M.1 团队与派工

| ID | 前置条件 | 操作 | 预期结果 | 数据一致性 |
|---|---|---|---|---|
| T01 | 团队有 leader、成员 A/B；Plan 有 team task；已批准 | dispatch | dispatch succeeded；task active assignment 指向 A/B；reason 保存 | dispatch=1 succeeded；assignment active=1/task；无 Run |
| T02 | 队长执行失败/超时 | dispatch | dispatch failed；无 active assignment；Plan 仍 approved | 无 active assignment；dispatch error 非空；无 Run |
| T03 | 队长输出漏一个 task | dispatch | failed `MISSING_TASK`；该团队所有 task 均无 assignment（原子） | assignment 0；dispatch failed |
| T04 | 一个 Plan 两个团队，A 成功 B 失败 | dispatch | A succeeded；B failed；Plan 不可启动 | A assignment 有；B 无；start 拒绝 |
| T05 | dispatch failed；老板手动补齐 B 全部 task | assignTask ×N | B assignment active；Plan ready | dispatch 仍 failed 但 UI 显示手动补齐；start 可启动 |
| T06 | 两个 dispatch 请求并发 | dispatch ×2 | 只有一个 running/succeeded；第二个返回现有状态 | 一条 dispatch；无重复 assignment |
| T07 | 队长尝试分配其他团队 Agent | dispatch | failed `AGENT_NOT_MEMBER`；无写入 | 无 assignment |
| T08 | 队长分配自己 | dispatch | failed `AGENT_NOT_MEMBER`/`LEADER_EXCLUDED`；无写入 | 无 assignment |
| T09 | 团队无 leader | dispatch | failed `LEADER_NOT_SET`；Plan approved | 无 assignment；无 Run |
| T10 | 队长被停用/归档 | dispatch | failed `LEADER_INACTIVE`；不自动换人 | 无 assignment |
| T11 | 成员被停用 | dispatch 输出该成员 | failed `AGENT_INACTIVE`；整队无写入 | 无 assignment |
| T12 | 任务要求 analyze，队长分配 edit Agent | dispatch | failed `ACCESS_MODE_MISMATCH` | 无 assignment |
| T13 | 同一 wave 分配超过 Agent maxConcurrency | dispatch | failed `CAPACITY_EXCEEDED` | 无 assignment |
| T14 | 老板在 dispatch running 时改派 | assignTask | 拒绝 `DISPATCH_IN_PROGRESS` | 无新 assignment |

### M.2 老板改派与计划

| ID | 前置条件 | 操作 | 预期结果 | 数据一致性 |
|---|---|---|---|---|
| T15 | Plan approved，task 已由队长分配 A | assignTask → B（团队成员） | active=B；A 行 superseded；audit/comment | active unique=1；历史 2 行 |
| T16 | 同上，B 是团队外 Agent | assignTask | 拒绝；active 仍 A | 无新行 |
| T17 | Plan running | assignTask | 拒绝 `INVALID_PARAMS` | 无变化 |
| T18 | plan revison 后旧 dispatch/assignment | revise | 旧 dispatch cancelled；旧 assignment superseded；新版本 pending_approval | 新版本无 active；旧历史保留 |
| T19 | 已 running plan | revise | 拒绝；Run/assignment 不变 | 无变化 |
| T20 | 旧计划无 teamId、无 assignment 行 | startRun | legacy seed from version.assignments；Run 使用旧 Agent | source=legacy；Run 正常 |

### M.3 StartRun

| ID | 前置条件 | 操作 | 预期结果 | 数据一致性 |
|---|---|---|---|---|
| T21 | 全部 assignment active，无 active attempt | startRun | Plan running；Run running；workflow version published | plan.runId/versionId 与 Run 一致 |
| T22 | 两个 startRun 并发 | startRun ×2 | 只有一个 attempt 创建 Run；第二个 `PLAN_START_IN_PROGRESS` 或返回同一 Run | 1 Run；1 workflow version；plan 1 runId |
| T23 | 启动事务中 workflow/run 失败（注入） | startRun | 全部回滚；Plan approved；attempt failed | 无 orphan version/run；assignments 不变 |
| T24 | workflow version 创建成功、run 创建失败（若采用 saga） | startRun | attempt failed；记录 workflow_version_id；不创建 Run | 需清理/复用策略；不得重复启动 |
| T25 | kick 失败 | startRun | Plan/Run 已创建；返回 schedulingError；重试 kick 不新建 Run | 1 Run；attempt 记录错误 |
| T26 | 启动期间老板 assignTask | 并发 | 线性化：claim 先则 assign 拒绝；assign 先则 snapshot 读到新值 | 无撕裂 assignment |
| T27 | Run 启动后修改 plan/dispatch | 修改旧版本/assignment | Run 的节点 agent 不变 | workflow version 不变 |
| T28 | 旧 Plan 已 approved 无 dispatch | startRun | legacy 路径成功；不要求队长 | 无 dispatch；legacy assignment |

### M.4 队长权限

| ID | 前置条件 | 操作 | 预期结果 | 数据一致性 |
|---|---|---|---|---|
| T29 | 队长执行中 | 检查 allowed/disallowed tools | 无 Bash/Write/Edit；Provider 不支持 toolControl 则派工失败 | 审计 tool_policy |
| T30 | 队长输出包含 shell/其他动作 | dispatch | 只解析 assignments；非法输出 failed | 无执行副作用 |
| T31 | Assistant 尝试 approve | 后续阶段测试 | 不存在 approve 动作/被拒绝 | Plan 状态不变 |

### M.5 返工

| ID | 前置条件 | 操作 | 预期结果 | 数据一致性 |
|---|---|---|---|---|
| T32 | 测试失败，原 Agent 有效 | 返工 | 新 attempt 使用原 Assignment；不调队长 | agent 不变；rework round+1 |
| T33 | node override 存在 | 返工 | 使用 override agent | override 不变 |
| T34 | 原 Agent 停用 | 返工 | 节点 failed；不自动换人 | 无新 assignment |
| T35 | 老板运行中改派团队新成员 | reassignTask | 创建同 workRole Assignment + override；下一 attempt 生效 | active assignment/override 正确 |
| T36 | 达到 maxRounds | 返工 | 暂停分支；老板可继续/接管 | 轮次/状态现有语义 |

---

## N. 分阶段实施任务清单

### 阶段 1：Team Leader 基础（可独立实施）

1. 迁移 v27 `teams.leader_agent_id` + 索引；
2. TeamRecord/Repository 增加 leader；
3. TeamService：
   - `setLeader`（事务：active agent、团队成员、自动加入、审计）；
   - `removeMember` 阻止移除 leader；
   - `update` 支持 leader（或独立 `setLeader`）；
4. Protocol `Team`/`TeamUpdateParams` 增加 leaderAgentId；RPC/IPC/API；
5. TeamsPage：队长展示/设置/更换；成员负载；
6. 测试：队长变更、成员约束、旧团队 null、归档/停用；
7. 迁移测试 v27；
8. 文档/DECISIONS 记录。
9. **前置**：批准队长必须 analyze + 排除候选 + Provider toolControl 约束。

### 阶段 2：团队任务与派工（高风险，需要单独评审）

1. Protocol `PlanTask.teamId`、PlanTaskAssignment DTO、PlanAssignTask/PlanDispatch 参数；
2. PlannerService：
   - Team port/registry；PlanTask.teamId；
   - 校验规则（团队/个人/非权威建议）；
   - fallback 保持个人任务或明确团队策略；
3. 迁移 v28：`plan_task_assignments`、`plan_dispatches`、`plan_start_attempts`；
4. `PlanAssignmentService`：
   - seed personal/legacy；
   - leader result apply；
   - boss assign；
   - active unique / supersede；
   - readiness；
5. `TeamDispatchService`：
   - ensure dispatch rows；
   - claim/retry/cancel；
   - leader prompt/execution/system tool policy；
   - validate output；
   - atomic per-team write；
6. `PlanStartService`：
   - claim attempt/snapshot；
   - compile；
   - transaction-aware workflow version + run + plan writes；
   - kick after commit；
   - stale attempt recovery；
   - idempotent start/retry；
7. PlanService integration：
   - approve 创建 dispatch；
   - startRun 委托 PlanStartService；
   - plan.assignTask/dispatch/revise；
   - readiness DTO；
8. ExecutionService system execution options（leader no tools）；
9. 运行中 reassign 扩展（团队新成员 Assignment）；
10. UI：PlanPage dispatch 状态/队长分配/改派/启动门禁/失败重试；TeamsPage leader/负载；
11. 测试矩阵 M.1-M.5；
12. 迁移 v28 独立评审 + 全量门禁 + 备份。

### 阶段 3（不在本次）：Assistant

- Assistant chat/action/settings；本次不实现。

---

## O. 风险与未决问题

| # | 风险/问题 | 影响 | 处理 |
|---|---|---|---|
| O1 | StartRun 当前无并发占用、无原子事务 | 重复 Run/orphan version/Plan-Run 不一致 | 必须按 H 设计重构；否则阶段 2 NOT READY |
| O2 | `PlanPage` 不传 requestId | 重复启动 | StartAttempt active unique + 服务端 requestId |
| O3 | WorkflowDefinitionService/WorkflowRunService 自带事务 | 不能简单包大事务 | 增加 transaction-aware 方法；独立评审 |
| O4 | `analyze` 允许 Bash、空 allow 被拒 | 队长可能执行工具或无法无工具运行 | startSystem + 固定 tool policy + 校验 Provider toolControl |
| O5 | Provider toolControl 差异 | 某些 Provider 无法保证无工具 | 第一阶段队长限定 native toolControl Provider（建议 Claude Code/CodeBuddy） |
| O6 | 团队任务 workRole/运行中改派 | 新成员无 Assignment 无法改派 | G.3 同 workRole 创建 Assignment；冲突拒绝 |
| O7 | 队长失败后手动补齐的 dispatch 语义 | UI/状态歧义 | readiness 看 active assignment；dispatch 保留失败历史；是否新增 manual 状态待决策 |
| O8 | 计划修订期间 dispatch 运行 | 旧 leader 写旧版本 | dispatch 按 plan_version_id 绑定；revision 取消旧 dispatch/execution |
| O9 | 旧计划 legacy | 回归 | 明确识别条件；seed source=legacy；不做时间判断 |
| O10 | 旧团队无 leader | 团队任务失败 | 不猜测；UI 提示；老板设置队长/手动分配 |
| O11 | 迁移无 down | 回滚困难 | 迁移前备份；手工 down SQL；恢复备份 |
| O12 | 队长输出 JSON 不稳定 | 派工失败 | fail closed；不猜文本；重试/换队长 |
| O13 | PlanStatus 终态只读派生 | 状态机假设错误 | 启动/审批用 DB status；UI 派生；不要写 completed |
| O14 | Capacity 校验 | 并行任务超负载 | wave-aware 校验；测试 |
| O15 | 队长/助手审计 | 无法追责 | audit_logs + plan comments + dispatch executionId |
| O16 | Assistant 审批 | Human Governs 被破坏 | 不开放 approve 动作；审批仅老板 |

### 待决策

1. 队长是否只允许 native toolControl Provider（Claude Code/CodeBuddy）？（推荐是）
2. dispatch 触发：批准后显式 `plan.dispatch`，还是 approve 后自动异步？（推荐显式）
3. 队长失败后老板手动补齐时，dispatch 是否改为 manual-succeeded？（推荐保留 failed 历史，readiness 看 assignment）
4. 启动前改派是否允许在 `pending_approval` 阶段？（推荐只允许 approved 且未 start）
5. 运行中改派到团队新成员时，是否允许自动创建同 workRole Assignment？（推荐是，若已有不同 workRole 则拒绝）
6. 团队任务是否允许同一 Agent 被分配多个并行任务超过 maxConcurrency？（推荐拒绝）
7. 旧 Plan 的 legacy 路径是否在 v28 后一直保留，还是设定归档退出时间？（建议保留到旧计划全部归档）

---

## P. 实施准入结论

**结论：READY WITH CONDITIONS（阶段 1 可实施；阶段 2 有条件实施）**

### P.1 阶段 1（Team Leader 基础）

- 设计完整，数据模型/迁移/UI/测试明确；
- 可以进入实施；
- 条件：确认队长 analyze-only、排除候选、Provider toolControl 约束；迁移前备份。

### P.2 阶段 2（团队任务 + 派工 + StartRun）

- 业务规则/数据模型/派工校验已闭环；
- **StartRun 当前实现不满足并发与原子性**；必须采用 H 的 `PlanStartAttempt + 单事务写入 + 事务外 kick`；
- 必须增加 transaction-aware WorkflowDefinitionService/WorkflowRunService 方法，或等价的单事务写入方案；
- 必须实现队长系统执行入口与工具限制，且限制 Provider toolControl；
- 必须完成 v28 迁移评审、备份、全量门禁；
- 满足以上后才能进入阶段 2 实施。

### P.3 阻塞项

1. StartRun 并发/事务化（H）是**架构阻塞**；未解决不建议开始阶段 2。
2. 队长无工具的 Provider 约束（I）是**安全阻塞**；未确认不能开始队长执行。
3. v28 迁移必须独立评审；不可与业务改造混合发布。

### P.4 不建议现在做

- Assistant 实现（后续阶段）；
- Provider Base URL/API Key 管理；
- 队长运行中自动重新派工；
- 重写 Scheduler/Engine；
- 计划原地修改；
- 用队长替代 ReworkPolicy。

---

## Q. 审查后的 Git 状态对比

### Q.1 审查前

- 分支：`main`
- HEAD：`9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`
- `git status --porcelain=v1`：0 项
- `git status --short --ignored`：35 条 ignored；无业务未跟踪
- staged/unstaged/deleted/untracked：0/0/0/0
- worktrees：仅主目录 `main`
- merge/rebase/cherry-pick/bisect：无
- 运行中：Electron 实例（CDP 9228）；无测试/构建/安装

### Q.2 审查后

- 分支：`main`（未切换）
- HEAD：`9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`（未变）
- `git status --porcelain=v1`：
  ```text
  ?? docs/agentra-assistant-team-leader-implementation-readiness.md
  ```
- staged/unstaged/tracked diff：0 / 0 / 0（`git diff --stat` 为空）
- worktrees：仅 `/Volumes/MacExt SSD/Self Work/Agentra`（`main`），未变
- 新增文件：`docs/agentra-assistant-team-leader-implementation-readiness.md`（实施前 1407 行；实施后见当前文件）
- 修改既有文件：**无**
- 删除/移动既有文件：**无**
- 数据库/配置/测试：**未修改**
- 迁移/测试/构建/安装：**未运行**

### Q.3 实施后（2026-11-07）

- 分支：`main`（未切换），HEAD 仍为 `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`（未提交）。
- 代码：阶段 1/2 已实现，涉及 Core、Protocol、Desktop、迁移和测试；具体文件见本次交付报告。
- 迁移：v27 `team_leader`、v28 `plan_dispatch` 已在临时测试库验证；未对 `~/agt-agents-clean4` 执行迁移。
- 门禁：`pnpm test` 98 文件 / 869 用例通过；`pnpm typecheck`、`pnpm lint`（0 error，0 warning）、`pnpm build` 通过。
- 真实冒烟：临时数据目录启动桌面端，创建 analyze 队长 + 两名 edit 成员，设置队长；
  创建团队任务计划、批准、队长派工成功（Claude Code 真实执行，工具策略
  `allow:[]`、`deny:["Bash",...]`，exit 0）、启动 Run 成功；DB 中
  `plans / plan_start_attempts / workflow_versions / workflow_runs` 均为 1 条，
  重试 StartRun 返回同一 Run。
- 未执行：真实用户数据目录迁移、队长失败后的人工 UI 点击重试、安装包态验收。

### Q.4 审查声明（设计阶段历史）

设计阶段除新增本文件外，只读检查现有代码和数据库结构。文档中的文件/行号是设计审查时快照；
实施后代码已变化，以当前仓库和测试为准。

---

## 附录：关键事实/推荐设计/假设清单

### 设计审查时确认（历史）

- `PlanTask` 当时无 teamId；`PlanAssignment` 只有 taskKey/agentId/agentName。
- `PlanService.startRun` 当时无并发占用；`PlanPage` 启动不传 requestId。
- WorkflowDefinitionService 三段事务；WorkflowRunService 自带事务；`transaction()` 不支持嵌套。
- `plans.setRun` 在 Run 创建之后；失败不会自动取消 Run。
- `analyze` 允许 Bash；ExecutionService 拒绝空 allow。
- Team 当时无 leader；TeamService 无 leader 方法。
- 现有 PlanVersion 只创建 v1；没有 revise。
- Rework 继续原 Assignment/override；不调用 leader。
- 设计审查时迁移最高 v26，无 down 机制。

### 实施后变化

- `PlanTask` 已有 `teamId`；Planner 对团队任务不再决定最终成员。
- `teams.leader_agent_id` 已由 v27 加入；TeamService 支持设置/更换队长并自动加成员。
- v28 已加入 `plan_task_assignments`、`plan_dispatches`、`plan_start_attempts`。
- `PlanService.startRun` 已改为 `PlanStartService`：active attempt 唯一占用、
  assignment snapshot、单事务 workflow version/run/plan、事务外 kick。
- 队长通过 `ExecutionService.startSystem` 执行，工具策略 `allow:[]`、deny Bash/写工具；
  Provider 必须 native toolControl。
- `plan.dispatch` / `plan.assignTask` 已接入 Protocol、RPC、Desktop IPC 和 UI。
- ReworkPolicy 未改变：仍使用原 Assignment/override，不调用队长。
- 迁移仍无 down 机制；v27/v28 的正式回滚仍按 §J 备份/手工 SQL。

### 推荐设计

- PlanStatus 不变；新增 PlanDispatch/PlanTaskAssignment/PlanStartAttempt 状态。
- 每 team 原子派工；跨 team 允许部分失败；start 要求全部 assignment。
- leader 输出先校验后事务写入；失败不回落。
- StartRun claim/snapshot + 单事务 workflow/run/plan 写入 + 事务外 kick。
- 队长系统执行入口固定无工具 policy；Provider 必须 native toolControl。
- v27 leader、v28 三表；legacy 只读旧 assignments，不补 teamId/leader。

### 仍需实施前核实/确认

- SQLite 当前版本是否支持 partial unique index 与 DROP COLUMN（node:sqlite 预计支持，但需迁移测试）。
- Claude Code/CodeBuddy 的 `--allowedTools/--disallowedTools` 在空 allow/deny 具体行为；需真实 CLI 验证。
- WorkflowDefinitionService/WorkflowRunService 事务化重构的代码影响面；需专项设计/评审。
- 队长 Provider 限制是否接受；若要求多 Provider，需额外的无工具适配器设计。
- dispatch 是否自动触发；手动补齐后的 UI 语义。
- 运行中改派自动创建同 workRole Assignment 是否符合现有 Assignment 唯一约束与审计要求。
