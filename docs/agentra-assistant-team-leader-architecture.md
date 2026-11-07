# Agentra 架构调整方案：Agentra 助手 + 团队队长 + 规划体系

- 版本：0.1（架构审查与设计稿，**未实施**）
- 日期：2026-11-07
- 审查基线：分支 `feat/agentra-ux-plan-runtime`，HEAD `b8e21c8c2a1de620f6f444951c966d2709eff94c`，工作树包含上一轮未提交的 Agent 权限/技能/Provider/团队页改动
- 本轮约束：未修改业务源码、测试、数据库或配置；未运行迁移、测试、构建或安装；本文件是唯一新增文件

> 本文回答的核心问题：老板只通过一个 Agentra 助手管理软件、团队队长负责团队内派工、规划继续保留独立价值——这套目标能否在不推翻现有核心执行闭环的前提下落地。结论是**可以**，但必须先解决「Planner 选人」和「队长派工」的双头权威问题，并把 Plan / Assignment / Run 的版本边界定死。

---

## 0. 结论摘要

### 0.1 推荐架构

保留现有 Core、Plan、Workflow Engine、Scheduler、ReworkPolicy、ExecutionService，不重写执行内核。调整职责如下：

```text
老板
  │
  ▼
Agentra 助手（统一聊天入口：教学、查询、创建资源、发起规划、执行控制提案）
  │  调用
  ├── PlanGenerator（规划能力：任务、依赖、验收标准、团队归属）
  ├── Resource Services（Agent/Team/Skill/Work/Project）
  └── PlanService（批准后的计划生命周期）
          │
          ▼
        团队队长（仅对 team task 做成员分配）
          │  写入 Core 校验后的 Assignment 结果
          ▼
        Plan / Assignment / Run（快照与版本）
          │
          ▼
        Workflow Engine → Scheduler → ExecutionBridge → Agent Runtime
```

### 0.2 最重要的一条不变量

> **同一个决策只能有一个最终权威。**
>
> - 计划内容：PlanVersion 是唯一权威。
> - 团队任务的成员：队长/老板写入的 active assignment 是唯一权威；Planner 只能给非权威建议。
> - 已启动 Run 的执行成员：已发布的 workflow version + node override 是唯一权威；后续计划或分配变化不得修改已启动 Run。

### 0.3 现有实现最关键的问题

1. **Planner 目前直接选人，且 PlanService 直接用 `version.assignments` 建 Assignment、编译 DAG。** 如果再加队长，会出现 Planner 与队长同时决定团队成员的双头权威。
2. **`plan.startRun` 假设 Assignment 已存在。** 队长派工发生在批准后、启动前，当前没有「已批准但等待派工/派工失败」的中间状态。
3. **PlanVersion 表结构支持多版本，但服务层只创建 version=1。** 重新规划会创建新的 Plan，而不是同一 Plan 的新版本；已批准计划无法正式修订并重新审批。
4. **团队没有队长字段；团队成员只有 agent 关系。** 团队指引已经存在并注入成员执行，但没有队长消费指引做派工。
5. **没有 Agentra 助手实体、会话、动作协议或动作审计。** 现有 Planner 是只在 AI 规划时创建的系统 Agent，不是聊天入口。
6. **Assistant/Leader 的「不执行/无工具」无法用现有 accessMode 表达。** `analyze` 仍允许 Bash；`ExecutionService` 又拒绝空 allow。需要 Core 内部受限执行策略，不能直接给 system agent 开高权限。
7. **现有 `plan.reassignTask` 只支持运行中，且 node override 只有 `assignedBy`，没有 reason。** 老板在启动前改派、以及改派原因审计都缺失。
8. **不存在独立的 Orchestrator 类。** 现在由 PlanService（计划启动编排）、WorkflowEngine（节点分发）、FairDispatcher（跨 Run 公平）、Scheduler（单 Run 依赖/闸门/CAS）、ExecutionBridge（节点→Execution）分工。不要因为加队长再造 Scheduler 或执行引擎。

### 0.4 建议的第一阶段

先做**团队队长 + 团队任务归属 + 派工 Assignment 快照**（数据与执行真相），再做**助手只读聊天**，最后做**助手动作提案**。

原因：助手动作依赖稳定的资源服务和计划启动语义；如果先做聊天壳，后面仍会被双头派工和计划版本问题卡住。

---

## A. 当前架构现状（真实代码与调用链）

### A.1 代码与职责分布

| 层 | 位置 | 现有职责 |
|---|---|---|
| Desktop renderer | `apps/desktop/src/renderer` | UI、交互、状态展示 |
| Desktop main/preload | `apps/desktop/src/main`、`apps/desktop/src/preload` | IPC、Core RPC 代理、窗口生命周期 |
| Core | `apps/core/src` | 业务规则、SQLite、计划/团队/Run/Rework |
| Daemon | `apps/daemon/src` | CLI 进程启动、事件转发、模型探测调用 |
| Runtime SDK / CLI | `packages/runtime-sdk`、`packages/runtime-cli` | Provider 能力、发现、执行适配 |
| Protocol | `packages/protocol` | RPC 方法、DTO、Zod 信封 |
| Workflow schema | `packages/workflow-schema` | 7 节点定义、校验、checksum |

Core 是唯一业务权威；Desktop 不直接访问数据库或 spawn CLI。现有 RPC 注册在 `apps/core/src/rpc/methods.ts`，服务装配在 `apps/core/src/index.ts`。

### A.2 Planner 的真实调用链

当前调用链：

```text
PlanPage / TaskChatPanel
  → api.generatePlan({ goal, workId?, constraints?, mode })
  → RPC plan.generate
  → PlanService.generate           apps/core/src/services/plan-service.ts:126
  → PlannerService.generate        apps/core/src/services/planner-service.ts:97
  → ensurePlannerAgent()           apps/core/src/services/planner-service.ts:464
  → ExecutionService.start()       apps/core/src/services/execution-service.ts:446
  → Daemon → Provider CLI
  → extractOutput() → PlanDraft.safeParse
  → PlannerService.validate()      apps/core/src/services/planner-service.ts:359
  → PlanService.persist()          apps/core/src/services/plan-service.ts:152
  → plans / plan_versions / plan_threads / plan_comments
```

关键事实：

- `PlannerService` 是一个 **Agent 执行包装器**，不是独立的模型调用层。它通过 `ExecutionService.start` 跑一个名为 `Planner Agent` 的 Agent（`planner-service.ts:76`）。
- Planner Agent 的 `systemKind='planner'`，由 `ensurePlannerAgent()` 在首次 AI 规划时自动创建；优先绑定 Claude Code，模型默认 `sonnet`，`accessMode='analyze'`，`maxConcurrency=1`。
- Planner 输出必须是严格 `PlanDraft` JSON；解析失败或执行失败会回落到确定性草稿（`buildFallbackPlan`），并标记 `source='fallback'`。
- `PlannerService.validate()` 目前直接按 `suggestedAgentId` 或 `findMatchingAgents(active, requiredAccessMode)` 选出最终 Agent，并把结果写进 `PlanAssignment`（`planner-service.ts:413-459`）。
- `PlannerService.registrySnapshot()` 只包含 Agent，不包含 Team；`buildPrompt()` 只有 Agent Registry，没有团队归属（`planner-service.ts:523-545`、`:565-602`）。
- `PlanDraft` / `PlanTask` 目前没有 `teamId` 字段（`packages/protocol/src/methods/plan.ts:29`）；`PlanAssignment` 只有 `taskKey / agentId / agentName`（`plan.ts:80`）。

### A.3 Plan 生命周期、版本、审批和启动

- `PlanService.generate()`：调用 Planner，然后 `persist()`。
- `persist()`：创建 `PlanRecord`（`pending_approval`）和 `PlanVersion(version=1)`，把 `draft.validation.assignments` 写入 `plan_versions.assignments_json`，并创建每个任务的 `plan_threads`（`plan-service.ts:152-221`）。
- `approve()`：要求 `pending_approval` 且 `validation.valid`，CAS 更新 Plan/PlanVersion 为 `approved`（`plan-service.ts:243-274`）。
- `startRun()`：要求 Plan `approved`、已绑定 Work、Work `active`；调用 `ensureAssignments(workId, version.assignments)` 创建/复用 Assignment；`compilePlanDefinition()` 生成 7 节点 DAG；创建并发布 workflow version；`engine.startRun()`；最后 `plans.setRun()`（`plan-service.ts:300-380`）。
- `ensureAssignments()`：按 `version.assignments` 里的 Agent，逐个创建 `workRole = plan-<agentId 后 8 位>` 的 Assignment（`plan-service.ts:889-921`）。
- `PlanService` 没有 `addVersion` / `revise` / `updatePlan` 方法；`PlanVersionRepository.create()` 只在 `persist()` 中调用一次。现有 UI 的「重新规划」会生成新的 `planId`，不是同一 Plan 的新版本。
- `plan_versions` 表支持多个 `(plan_id, version)`（`migrations.ts:717-732`），但服务层尚未使用多版本能力。

### A.4 Team / Agent / Assignment 现状

- `teams` 表：`id, name, description, settings_json, status, created_at, updated_at, archived_at`；迁移 v26 增加 `instructions`（`migrations.ts:125-134`、`:929-937`）。
- `team_members`：`id, team_id, agent_id, permissions_json, joined_at`；v25 删除自由文本 `team_role`（`migrations.ts:136-144`、`:915-926`）。
- 没有 `leader_agent_id`；TeamService 只有 create/update/archive/member CRUD（`apps/core/src/services/team-service.ts:33-153`）。
- `work_teams`：Work 与 Team 多对多，只用于关联和展示；不约束 Assignment 或 Planner 选人。
- `assignments`：`work_id, agent_id, team_id?, work_role, status, concurrency_limit, context_ref`；`UNIQUE(work_id, agent_id)`（`migrations.ts:170-185`）。`team_id` 只校验团队存在且 active，不校验成员关系（`assignment-service.ts:82-90`）。
- AgentProfile：`avatar, description, systemPrompt, skillIds, accessMode(analyze/edit), systemKind(planner|agent_designer), model, toolPermissions, defaultProviderId, maxConcurrency`（`packages/protocol/src/dto.ts:120-140`）。
- 工具策略由 `accessMode` 派生：`analyze` 允许 `Read/Grep/Glob/WebFetch/WebSearch/Bash`、拒绝写工具；`edit` 允许读写和命令（`agent-service.ts:20-36`）。Assistant/Leader 若要「不执行、不碰命令」，现有 accessMode 不能表达。

### A.5 Workflow Engine、Scheduler、Orchestrator 现状

**结论：仓库里没有名为 Orchestrator 的类。** 实际职责由以下组件分担：

| 组件 | 文件 | 实际职责 |
|---|---|---|
| PlanService | `apps/core/src/services/plan-service.ts` | 计划生成/审批/启动编排：Plan→Assignment→DAG→Workflow version→Run |
| WorkflowEngine | `apps/core/src/workflow/engine.ts:66` | 节点类型分发、Run 启动/踢调度、Work 状态同步 |
| WorkflowFairDispatcher | `apps/core/src/workflow/fair-dispatcher.ts:35` | 多 Run 公平轮转；每个 Agent 每 Run 每轮最多 1 个节点 |
| WorkflowScheduler | `apps/core/src/workflow/scheduler.ts:144` | 单 Run 内 blocked→ready→running、依赖/闸门/CAS、per-agent rotation |
| ExecutionBridge | `apps/core/src/workflow/execution-bridge.ts:138` | `agent_task` → `ExecutionService.startForNode`，输出契约、重试、节点回写 |
| AssignmentResolver | `apps/core/src/workflow/assignment-resolver.ts:32` | Run 创建预检 + 节点启动前按 `workRole + agentProfileId` 复核 active |
| RunService | `apps/core/src/workflow/run-service.ts:36` | 写 Run/BranchRun/NodeRun 前预检全部 assignment；published version 校验 |
| ReworkService | `apps/core/src/workflow/rework-service.ts:149` | ReworkRequest、轮次、定向返工、超限暂停、继续/接管 |

调度层现状：

- Scheduler 的 readiness 由 `evaluateReadiness` 根据节点依赖/条件产出；进入 ready 后逐个过 `gates`（`scheduler.ts:216-303`）。
- 闸门包括 run status、branch status、Agent capacity、Provider health、workdir lock、input artifact、before_execute approval（`dispatch-gates.ts`）。
- `agentCapacityPort` 通过 `countActiveByAgent < agent.maxConcurrency` 判断（`ports.ts:14-35`）。
- 公平调度按 Run 轮转，每个 Agent 每 Run 每轮最多 1 个节点（`fair-dispatcher.ts:46-95`）。
- 这些机制已经覆盖「依赖、并发、公平、暂停、恢复」。**不要新增第二套 Scheduler/Orchestrator 来实现队长派工。**

### A.6 返工现状

- 测试任务的 `outputContract.profile='test_result'`；`pass=false` 时，ExecutionBridge 调 `ReworkService.onTestResult`（`execution-bridge.ts:310-336`）。
- ReworkService 从测试报告的 `relatedTasks` 找可到达 Condition 的目标任务，创建 `rework_requests`（`rework-service.ts:166-240`）。
- 返工通过为 target 及必要下游创建新 attempt 来执行（`rework-service.ts:369-460`），不新增 Retry/Loop 节点。
- 轮次上限、继续一轮、老板接管已实现（`rework-service.ts:480-541`）。
- 执行时 `AssignmentResolver` 优先使用 `node_assignment_overrides` 的 override，否则按原 Assignment（`execution-bridge.ts:157-160`、`assignment-resolver.ts:35-77`）。
- 现有返工没有「队长重新分配」步骤；这正好说明返工应继续沿原责任 Agent/老板改派，不应再次调用队长随机分配。

### A.7 Execution / Provider / Model 现状

- `ExecutionService.start` 的执行前置门禁：Work active、Prompt 非空、Agent active、tool allow 非空、Provider 可用、若带 workId 必须有 active Assignment、workdir lock（`execution-service.ts:446-486`）。
- 并发：`countActiveByAgent >= maxConcurrency` 时进入队列，不启动进程（`execution-service.ts:493-495`、`:575` 附近）。
- System prompt 组合：Agent 工作指令 + `skillIds` 对应技能 + 团队指引（仅当 Work 关联团队且 Agent 是成员）（`execution-service.ts:403-425`、`:566`）。
- Provider 由 Runtime SDK 发现；`RuntimeProviderRecord` 没有 Base URL/API Key 字段；凭据由 CLI/环境/cc-switch 管理。
- 模型列表：`ProviderRegistry.listModels()` 由 Daemon 调 Provider 的模型探测；Claude Code 读 `ANTHROPIC_BASE_URL` 的 `/v1/models` 或 `~/.claude/settings.json` 映射，Codex 读 cc-switch 目录，Antigravity/Grok 调 CLI；失败回退内置目录（`provider-registry.ts:78-110`、`claude-code/models.ts`、`codex/models.ts`）。
- 现有 Settings 页只展示运行时/数据/关于，不配置 Provider 凭据（`SettingsPage.tsx:71-178`）。

### A.8 Chat / Session / Message 现状

- 没有通用 Assistant Chat。现有聊天是 **Plan 任务线程**：`plan_threads` + `plan_comments`，每个 PlanTask 一个线程（`plan-repository.ts:293-344`）。
- 任务群聊 @ Agent 会启动一次协作执行，完成后把输出写回同一线程（`plan-service.ts:478-607`）。
- `agent_sessions` 是执行会话，不是用户聊天线程（`migrations.ts:64-74`）。
- 没有 `assistant_threads / assistant_messages / assistant_actions` 表，也没有对应 RPC。
- AgentDesignerService 已经验证了「系统 Agent + 严格 JSON + 失败兜底」的模式（`agent-designer-service.ts:111-170`、`:196-248`），可以作为 Assistant 结构化动作的参考，但不是聊天实现。

### A.9 RPC 与 UI 现状

现有导航（`apps/desktop/src/renderer/App.tsx:36-64`）：工作台（总览、规划、项目、任务）、协作（审批中心、交付物、Agents、技能、团队）、系统（备份中心、dev console）。

现状页面：

- **规划页**：目标/约束/可选任务 → AI 规划或快速草稿；最近计划；批准/拒绝；启动；转任务/转项目；任务线程；运行中改派/返工（`PlanPage.tsx:66-110`、`:444-700`）。
- **任务详情**：群聊为主，右侧概览/交付物/团队/设置（`WorksPage.tsx:54`、`:384-415`、`:370-420`）。
- **团队页**：已经是左侧团队列表 + 右侧详情，tabs 成员/指引/近期任务；没有队长（`TeamsPage.tsx:55-470`）。
- **设置页**：运行时、数据、关于；没有 Assistant 设置（`SettingsPage.tsx:71-178`）。
- 没有「助手」导航或页面。

### A.10 测试覆盖现状

仓库现有 93 个测试文件（上一轮工作树最后验证为 842 个用例；本次审查按要求未重新运行测试）。与本次改造直接相关的覆盖：

- `planner-service.test.ts`：系统 Planner 创建/复用/Provider 选择、权限匹配、快速草稿、失败回落、依赖环校验。
- `plan-service.test.ts`：生成→批准→启动 Run、任务线程事件、运行中改派、返工继续/接管、@ 协作、独立规划转任务/项目。
- `plan-compiler.test.ts`：Plan→7 节点 DAG、审批节点、验收 Condition/Rework。
- `assignment-resolver.test.ts`、`run-service.test.ts`、`execution-bridge.test.ts`：Assignment 预检/复核、Run 创建、节点启动、输出契约、改派。
- `rework-service.test.ts`、`rework-restart.test.ts`：A-G 触发、定向返工、轮次上限、继续/接管、重启恢复。
- `scheduler.test.ts`、`fair-dispatcher.test.ts`、`engine.test.ts`：依赖/闸门/CAS/公平/暂停。
- `phase2-domain.test.ts`：Team/Assignment/Work 状态机；`team-service` 目前已覆盖成员与 instructions，但没有 leader。
- 没有 Assistant、TeamLeader、PlanTask.teamId、plan dispatch、assistant action 的任何测试。

### A.11 现状能力矩阵

| 目标能力 | 现状 | 结论 |
|---|---|---|
| 老板统一入口 | 无 Assistant 页面/会话 | 缺失 |
| 助手教学/查询 | 无通用聊天；仅 Plan 任务线程 | 缺失 |
| 助手创建 Agent/Team/Skill/Task | 有 AgentDesigner 草案、Team/Work/Skill 服务 | 可复用服务，缺动作层 |
| 规划生成 | PlannerService + PlanService 已实现 | 可复用/需重构职责 |
| 规划独立存在 | Plan/PlanVersion/审批/DAG 已实现 | 保留 |
| 任务指定团队 | PlanTask 无 teamId | 缺失 |
| 团队队长 | Team 无 leader | 缺失 |
| 队长派工 | 无 dispatch/assignment 结果模型 | 缺失 |
| 老板启动前改派 | 仅运行中 `plan.reassignTask` | 部分缺失 |
| 计划版本修订 | 表支持，服务无写入 | 部分缺失 |
| Run 快照隔离 | workflow version 不可变 + run 引用 | 已具备 |
| 返工 | 完整 | 保留，需兼容路由 |
| 调度/执行 | 完整 | 保留，禁止重造 |
| Assistant/Leader 安全 | 无内部受限执行策略 | 缺失 |

---

## B. 产品目标架构

### B.1 设计原则

1. **AI Plans, Human Governs**：AI 生成计划/建议/动作，老板批准计划、确认动作、启动执行、做审批与验收。
2. **单一权威**：PlanVersion、active PlanTaskAssignment、published WorkflowVersion 各自只在各自阶段拥有最终权威。
3. **单一调度**：不新增 Scheduler/Orchestrator；队长派工是计划阶段的业务服务，不是运行期调度器。
4. **能力与权限分离**：Agent 的「擅长的工作」是文字上下文；技能是复用指令；accessMode/toolPermissions 才是执行权限。
5. **系统 Agent 走 Core 校验**：助手和队长的模型输出都只是提案，不能直接写数据库或作为执行事实。

### B.2 角色职责表

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| 老板 | 提目标、批计划、确认助手动作、查看/修改分配、启动/暂停/恢复/终止、审批/返工/接管、验收 | 不手工改数据库 |
| Agentra 助手 | 教学/答疑、查询、创建资源、发起规划、提出动作、解释计划/状态 | 不直接访问 DB/文件系统/Shell；不替代老板批计划；不直接执行团队成员任务 |
| PlanGenerator（规划能力） | 任务拆分、依赖/并行、输入输出、验收标准、风险、团队归属 | 不为团队任务选择最终成员；不改已批准计划 |
| 团队队长 | 读取团队指引/成员能力/负载，给团队任务选成员并说明理由 | 不生成计划、不审批、不执行团队成员任务、不选团队外 Agent |
| 普通 Agent | 执行分配的任务、使用授权工具/技能、提交 Artifact/结构化结果、返工 | 不自行派活、不改 Assignment |
| Orchestrator（概念） | 计划/派工/运行之间的协调 | 不新增第二个 Scheduler；现有 PlanService/Engine 已承担 |
| Scheduler | 依赖/闸门/并发/公平调度 | 不做业务选人 |
| Workflow Engine | 7 节点状态、暂停/恢复、审批/返工驱动 | 不决定谁执行 |
| Core | Zod 校验、业务规则、权限、数据一致性、审计 | 不执行 CLI |
| Agent Runtime | 调用本地 CLI、事件、进程控制 | 不做业务决策 |

### B.3 目标业务流

```text
老板 → 助手（聊天/查询/创建资源/发起规划）
        → PlanGenerator（PlanDraft：tasks + dependsOn + acceptance + teamId/personal agent）
        → Plan（pending_approval）
        → 老板批准
        → [team task] TeamDispatchService 唤醒各队队长
             → 结构化 assignment 提案
             → Core 校验（成员/权限/负载/完整性）
             → active PlanTaskAssignment
        → [personal task] 直接使用指定 Agent（或老板手动指定）
        → 老板查看/调整分配
        → startRun：PlanTaskAssignment → Assignment → published WorkflowVersion → Run
        → Scheduler/Engine/ExecutionBridge 执行
        → ReworkPolicy 返工（沿用原责任 Agent；老板可改派）
        → 老板验收
```

### B.4 三条不可破坏的边界

1. **规划不选团队最终成员**：PlanTask 有 `teamId` 时，`suggestedAgentId` 仍可存在，但只能作为「建议/参考」，不得进入 `PlanTaskAssignment` 的权威值，除非老板手动确认。
2. **队长不改计划**：队长只能输出 `taskKey → 团队成员 + reason`；不能增删任务、改依赖、改验收标准、改权限。
3. **Run 不被后续变化影响**：启动时把最终 assignment 编译进 published workflow version；之后 Plan/PlanTaskAssignment 的变化只能影响后续 Run，不能影响已启动 Run；运行中改派走 node override。

---

## C. 当前实现与目标差距

| # | 能力 | 当前实现 | 目标 | 处理方式 | 关键文件 |
|---|---|---|---|---|---|
| C1 | 助手入口/会话 | 无 | 统一聊天 | 新增 AssistantService/表/RPC/UI | 新增 |
| C2 | 助手动作 | 无 | 提案+确认+Core 执行 | 新增动作协议/执行器 | 新增 |
| C3 | 助手设置 | 无 | Provider/模型/指令/权限 | 复用 AgentProfile + 新 settings 表 | 扩展 |
| C4 | 规划能力 | PlannerService 直接产出 PlanDraft | 保留，但不再决定团队最终成员 | 重构 Planner 输出语义与校验 | `planner-service.ts` |
| C5 | 团队队长 | 无 | `teams.leader_agent_id` | 迁移 + TeamService/UI | `team-repository.ts`、`team-service.ts`、`TeamsPage.tsx` |
| C6 | 团队任务归属 | PlanTask 无 teamId | `teamId` + 个人任务 agent | 协议、Planner 提示、校验、UI | `methods/plan.ts`、`planner-service.ts` |
| C7 | 队长派工 | 无 | 结构化 assignment + Core 校验 | 新增 TeamDispatchService + 表 | 新增 |
| C8 | 老板启动前改派 | 无 | `plan.assignTask` | 新增 RPC/service/UI | `plan-service.ts` |
| C9 | 计划版本修订 | 表支持、服务只写 v1 | 新版本 + 重新审批 | 新增 revise/version 流程 | `plan-repository.ts`、`plan-service.ts` |
| C10 | Run 快照 | workflow version 不可变，run 引用 | 保持不变 | 复用 | `published-definition-provider.ts`、`run-service.ts` |
| C11 | 运行中改派 | node override（assignedBy） | 保留，补充 reason/审计 | 扩展 override 或 audit | `node-assignment-override-repository.ts` |
| C12 | 返工 | 完整，基于原 Assignment/override | 保留；不重新随机派工 | 不重写；补路由规则 | `rework-service.ts`、`assignment-resolver.ts` |
| C13 | 调度/引擎 | 完整 | 保留 | 不新增 Scheduler | `engine.ts`、`scheduler.ts`、`fair-dispatcher.ts` |
| C14 | 团队页 | 已有 Multica 风格 tabs | 增加队长展示/设置/负载 | 扩展 | `TeamsPage.tsx` |
| C15 | 设置页 | 运行时/数据/关于 | 增加助手设置 | 扩展 | `SettingsPage.tsx` |
| C16 | 系统 Agent 安全 | analyze 允许 Bash；空 allow 拒绝执行 | Assistant/Leader 无工具或只读 | 内部 `ExecutionOptions` | `execution-service.ts` |

---

## D. 数据模型

### D.1 当前模型（摘要）

```text
agent_profiles
  id, name, avatar, description, system_prompt, skill_ids_json,
  access_mode, system_kind, model, tool_permissions_json,
  default_provider_id, max_concurrency, status, timestamps

teams
  id, name, description, instructions, settings_json, status, timestamps
team_members
  id, team_id, agent_id, permissions_json, joined_at
  UNIQUE(team_id, agent_id)
work_teams
  work_id, team_id, created_at
  PRIMARY KEY(work_id, team_id)

plans
  id, work_id?, goal, status, current_version,
  workflow_version_id?, workflow_run_id?, approved_at/by, timestamps
plan_versions
  id, plan_id, version, plan_json, validation_json, assignments_json,
  checksum, status, source, fallback_reason, timestamps
plan_threads
  id, plan_id, task_key, created_at
plan_comments
  id, thread_id, author_type, author_id, content, created_at, run_id

assignments
  id, work_id, agent_id, team_id?, work_role, task_scope,
  status, concurrency_limit, context_ref, timestamps
  UNIQUE(work_id, agent_id)

workflow_runs
  id, work_id, workflow_version_id, status, runtime_state_json, timestamps
node_assignment_overrides
  id, workflow_run_id, workflow_node_key, agent_id, assigned_by,
  timestamps, UNIQUE(run, node)
```

### D.2 目标模型：新增/扩展

#### D.2.1 Team leader

```sql
ALTER TABLE teams ADD COLUMN leader_agent_id TEXT
  REFERENCES agent_profiles(id) ON DELETE SET NULL;
```

约束（由 Core 执行，不只靠 DB）：

- 队长必须是 active Agent；
- 队长必须同时是团队 active 成员；
- 建议队长 `accessMode='analyze'`，且派工执行使用受限工具策略（不能 Bash/写文件）；
- 更换队长时自动把新队长加入团队；移除队长前必须先更换；
- 一个团队只有一个 `leader_agent_id`，不需要额外唯一索引；
- 团队归档后队长字段保留，但 dispatch 不再可用。

#### D.2.2 PlanTask 团队/个人归属

在 `PlanTask` 增加：

```ts
teamId: string | null = null
```

语义：

- `teamId != null`：团队任务；最终成员由队长/老板决定。
- `teamId == null`：个人任务；`suggestedAgentId` 是最终执行 Agent 的依据（仍需 Core 校验 active/accessMode）。
- `suggestedAgentId` 在团队任务中只作为非权威建议：若填写，Core 可校验它属于该团队，但不得直接作为 Assignment。
- 规则：团队任务不能同时把 `suggestedAgentId` 当成最终分配；个人任务必须能解析出一个 active Agent，否则计划校验失败。

Planner 输入需要新增 Team Registry：`id, name, description, instructions(截断), memberCount, members[{id,name,description,accessMode,skills}]`。Planner 提示要求：

- 多角色/多成员协作 → `teamId`；
- 单一明确 Agent → `teamId=null, suggestedAgentId=<id>`；
- 不得为 team task 指定最终成员（`suggestedAgentId` 只能作为建议）。

#### D.2.3 计划任务分配（权威、可改派）

新增表 `plan_task_assignments`：

```sql
CREATE TABLE plan_task_assignments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
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
```

设计理由：

- `plan_versions.assignments_json` 是 Planner 的**历史建议快照**，不可变；不能在批准后原地修改。
- 队长派工、老板改派需要一个可更新、可校验、可审计的权威表。
- active 行唯一约束保证「任务必须且只能有一个有效分配」。
- 老板改派：更新旧行 `status='superseded'`，插入新 active 行；旧行保留历史。
- 审计：写 `audit_logs` + Plan 任务线程系统消息；不额外建 event 表，避免重复。
- 个人任务：计划批准时由 Core 从 `suggestedAgentId` 生成 active 行，`source='planner'`；老板可改。
- 旧计划：启动时若没有 active 行且 PlanTask 无 `teamId`，从 `plan_versions.assignments` 生成 `source='legacy'` 行（仅内存或落库均可；推荐落库一次，统一后续查询）。

#### D.2.4 派工状态（队长执行）

新增表 `plan_dispatches`：

```sql
CREATE TABLE plan_dispatches (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  leader_agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  execution_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_version_id, team_id)
);
```

- 一个 PlanVersion 下每个 team 只有一条 dispatch 记录；重试递增 attempt / 重置 failed→running。
- 队长输出无效、成员不匹配、权限不匹配、容量不足、漏任务/多任务 → `failed`；不写任何 active assignment（先全量校验，再事务写入）。
- Plan 本身仍保持 `approved`；`plan.startRun` 检查该 version 的所有 team task 是否 dispatch succeeded 且有 active assignment；不满足则拒绝启动并给出结构化错误。
- 不把 `dispatching/dispatch_failed` 塞进 `plans.status`，避免污染现有 Plan 状态机与历史语义。

#### D.2.5 老板启动前改派

新增 RPC `plan.assignTask`（与运行中 `plan.reassignTask` 区分）：

```ts
{
  planId, taskKey, agentId, reason, decidedBy
}
```

- 只允许 Plan `pending_approval` / `approved` 且尚未 startRun；
- 团队任务：agent 必须是该团队 active 成员、权限匹配、该 version 的 dispatch 已成功（或老板明确绕过 dispatch？推荐不允许绕过，只能手工指定并记录 `source='user'`）；
- 个人任务：agent 必须 active、权限匹配；
- 更新 active `plan_task_assignments` 行 + 审计 + 计划线程系统消息；
- 幂等：同一 `planId/taskKey/agentId/reason` 重复提交不重复写；用请求级 key 或比较当前 active 行。

运行中改派继续使用现有 `plan.reassignTask` + `node_assignment_overrides`；建议扩展 override 表增加 `reason` 列或把 reason 写入 audit/plan comment。

#### D.2.6 Plan 版本修订

现有 `plan_versions` 表已支持多版本，但服务层没有写入新版本。新增 `PlanService.revise`：

- 输入：`planId, PlanDraft, decidedBy`；
- 只允许 `pending_approval`/`approved` 且尚未 startRun；
- 计算新 checksum；若与当前版本相同，拒绝空修订；
- `version = current+1`；插入新 `PlanVersion`，状态 `pending_approval`；
- 更新 Plan `current_version`、状态 `pending_approval`、清空/保留 approved 字段（新版本未批准）；
- 旧版本的 `plan_task_assignments` 标记 `superseded`；旧 `plan_dispatches` 取消/失效（不删历史）；
- 老板重新批准后才能 dispatch/start；
- 已启动 Run 不允许修订；需要新 Plan/新 Work 或后续版本（Phase 5 再讨论）。

#### D.2.7 Assistant 会话与动作

新增四张表：

```sql
CREATE TABLE assistant_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assistant_actions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES assistant_messages(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  description TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('read','low','medium','high')),
  confirmation_required INTEGER NOT NULL CHECK (confirmation_required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','executing','executed','cancelled','failed')),
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  executed_at TEXT
);

CREATE TABLE assistant_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('advisory','confirm_writes','low_risk_auto')),
  allowed_actions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
```

- `assistant_actions.id` 是幂等键；确认接口以 actionId + status CAS 执行。
- `payload_json` 必须用协议 Zod 再校验；`result_json` 只存脱敏后的资源引用与摘要。
- 不把 Assistant 聊天塞进 `plan_threads`：Plan 线程只是任务上下文，Assistant 是产品入口，生命周期和权限不同。

#### D.2.8 是否新增 `assistant` systemKind

现状：`AgentSystemKind = ['planner','agent_designer']`（`dto.ts:106`），DB 有 CHECK 约束（迁移 v24 重建 agent_profiles）。

两个选项：

| 选项 | 优点 | 缺点 | 建议 |
|---|---|---|---|
| A. 复用 `planner`，把显示名改为「Agentra 助手」 | 不新增迁移；复用已有 Planner 自动创建逻辑；一个系统 Agent | systemKind 名称语义陈旧；计划模式与聊天模式需要内部 prompt override | **推荐** |
| B. 新增 `assistant` kind | 语义干净 | 需要再次重建 agent_profiles CHECK；可能与旧 planner 并存；多一个 Agent | 暂不做 |

推荐 A：保留内部 `systemKind='planner'`，产品显示为「Agentra 助手」。新增一次性显示名迁移（只改默认名 `Planner Agent` → `Agentra 助手`，不覆盖用户自定义名）或 UI 映射。计划生成不再依赖该 Agent 的固定 systemPrompt，而是由 Core 在调用时注入「规划模式」系统提示词。

#### D.2.9 Assignment / Run 快照

不新增 `run_assignments` 表。理由：

- `PlanService.startRun` 会把最终 `PlanTaskAssignment` 编译成 `workflow_versions.definition_json`，其中 `assignmentSelector` 已包含 `agentProfileId + workRole`；
- `workflow_versions` 对 published/deprecated 有不可变触发器 + checksum；
- `workflow_runs.workflow_version_id` 锁定该定义；
- 运行中改派由 `node_assignment_overrides` 记录；
- 因此 Run 的 assignment 快照已经是「published workflow version + run overrides」，不需要重复存一份。

必须在文档/UI 中明确：`plan_versions.assignments_json` 是规划建议，不是 Run 快照；Run 快照在 workflow version。

### D.3 数据权威时序

```text
生成 Plan
  PlanVersion.plan_json / assignments_json（建议快照）
        │ 批准
        ▼
老板批准
  PlanTaskAssignment active 行（权威）
        │ 队长/老板改派（未启动）
        ▼
启动 Run
  编译为 workflow_versions.definition_json（快照，不可变）
  workflow_runs.workflow_version_id 锁定
        │ 运行中
        ▼
运行中改派
  node_assignment_overrides（按 run+node），只影响后续 attempt
```

---

## E. 核心业务流程

### E1. 助手聊天 / 教学 / 查询

```text
用户打开助手
  → 创建/复用 Assistant Thread
  → 用户消息写入 assistant_messages
  → AssistantService 组装：
      1) 产品使用指南（静态，可版本化）
      2) 最近 N 条会话
      3) 只读资源快照（agents/teams/skills/works/plans/providers）
      4) 当前可用动作清单与 JSON schema
  → ExecutionService.start(assistantAgent, 受限工具, prompt)
  → 模型返回 { reply, actions[] } JSON 或普通文本
  → 解析/校验
      - 合法：写 assistant message；actions 写 proposed
      - 不合法：只展示文本；不猜测动作
  → UI 流式显示 + 动作卡
```

关键约束：

- 助手不直接访问 DB；可读数据由 Core 以只读快照注入。
- 助手不能执行任意 Shell；动作只通过 Core 业务服务。
- 助手不能审批计划；审批是老板治理门禁。助手可以总结计划并打开审批页。
- 生成计划时，助手调用 PlanGenerator；计划仍进入 `pending_approval`，不自动批准。

### E2. 生成计划

1. 助手/规划页提交目标、约束、可选 Work、团队上下文。
2. PlanGenerator（现有 PlannerService 重构后）读取 Agent + Team Registry。
3. 输出 `PlanDraft`：`PlanTask.teamId` 或 `suggestedAgentId`（个人任务）。
4. 校验：
   - 任务 key 唯一、依赖无环、验收目标存在；
   - teamId 存在且 active；
   - team task 不把 suggestedAgentId 当最终成员；
   - personal task 的 suggestedAgentId active、accessMode 匹配；
   - 团队任务所属团队的 leader 存在且 active（若没有 leader，计划可生成但不可启动；UI 提示先设置队长）。
5. 保存 Plan/PlanVersion（pending_approval），创建任务线程。
6. 老板审批。

### E3. 批准

现有 `PlanService.approve` 保留：

- 只允许 `pending_approval` + `validation.valid`；
- 写 Plan/PlanVersion approved；
- 不触发队长；队长派工在批准后异步/显式执行。

### E4. 队长派工（核心新增）

**触发**：老板批准后，`PlanService` 调用 `TeamDispatchService.dispatch(planId)`；也可以由助手/UI 显式「开始派工」。

**按团队聚合**：一个 PlanVersion 下，同一 team 的所有 task 合并为一次队长执行，减少成本与并发冲突。

**队长输入**：

```text
团队：名称 / 描述 / 指引
队长：Agent 名称 / 擅长的工作 / 工作指令
成员花名册（排除队长本人）：
  - agentId / name / 擅长的工作 / accessMode / skills / provider / maxConcurrency / 当前 active executions
待分配任务：
  - taskKey / title / description / acceptanceCriteria / requiredAccessMode / dependsOn / parallelGroup
规则：
  - 只能选本团队 active 成员
  - 权限必须匹配 requiredAccessMode
  - 不得选择队长本人
  - 不得遗漏/重复 taskKey
  - 输出 JSON，不执行任务
```

**队长输出**：

```json
{
  "assignments": [
    {
      "taskKey": "frontend",
      "agentId": "agt-...",
      "reason": "该成员是前端工程师，当前负载 0/5"
    }
  ]
}
```

**Core 校验（全部通过才写库）**：

1. 输出是合法 JSON；只包含 `assignments`，不执行其他动作。
2. 每个待派工 task 恰好出现一次；不能多、不能漏。
3. taskKey 属于本团队待派工集合。
4. agentId 是团队 active 成员，不是队长本人。
5. Agent status active；`accessMode` 匹配任务 `requiredAccessMode`。
6. Agent 不在同一 wave 中被分配超过 `maxConcurrency` 个任务（wave 由 DAG 的并行关系计算）。
7. 不存在的 Agent / 团队 / 任务 → 整批失败，不写任何行。
8. 写入 `plan_task_assignments`（active）+ `plan_dispatches.succeeded`，同事务。
9. 写 audit + 计划线程系统消息。

**失败**：

- `plan_dispatches.status='failed'`，记录 `error_code/error_message/execution_id`；
- 不写任何 active assignment；
- Plan 保持 `approved`；`startRun` 拒绝；
- UI 显示失败团队/队长/原因，提供：
  - 重试队长派工；
  - 更换队长；
  - 更换团队；
  - 老板手动分配。

**并发**：

- `UNIQUE(plan_version_id, team_id)`；
- dispatch 状态 CAS `pending→running`，同一团队只有一个队长执行；
- 重复点击返回当前 dispatch 状态，不重复启动队长。

### E5. 老板查看和调整分配

- 计划详情展示每个 task 的：team、队长分配 Agent、reason、source（leader/user/legacy）、状态。
- 启动前改派：`plan.assignTask`；团队任务只能选该团队 active 成员；个人任务选 active Agent。
- 改派后更新 active assignment 行、audit、计划线程系统消息。
- 老板可以拒绝整份计划，或要求重新规划；重新规划走 `plan.revise`（新版本 + 重新审批），不是原地修改。

### E6. 启动执行与快照

`PlanService.startRun` 改为：

1. 校验 Plan `approved` + Work active；
2. 校验 latest PlanVersion 是当前批准版本；
3. 校验所有 task 有 active `PlanTaskAssignment`：
   - team task：必须有 dispatch succeeded + leader/user assignment；
   - personal task：必须有 planner/user assignment；
   - 旧计划（无 teamId）允许从 `version.assignments` 生成 legacy 行；
4. 按最终 assignment 调 `ensureAssignments` 创建/复用 Work Assignment（workRole 继续使用稳定生成规则）；
5. `compilePlanDefinition` 生成 DAG；published workflow version 是不可变快照；
6. `engine.startRun`；`plans.setRun`；
7. 之后的 Plan/assignment 变化不影响该 Run；运行中改派只走 node override。

### E7. 返工

保留现有 ReworkPolicy，增加路由规则：

1. 测试失败 → `relatedTasks` → 目标 NodeRun。
2. 返工 attempt 继续使用原 Assignment/override；**不重新调用队长**。
3. 如果原 Agent 已停用/Assignment 失效：
   - 不自动随机换人；
   - 任务节点 fail-closed；
   - 通知老板/计划线程；
   - 老板可通过 `plan.reassignTask` 改派，或由队长在“替换模式”下提建议（需老板确认）。
4. 轮次上限、继续返工、老板接管保持现状。
5. 不允许新增 Retry/Loop 节点；返工仍由 ReworkPolicy 驱动。

### E8. 计划修订

- 已批准但未启动：允许 `plan.revise` 生成新 PlanVersion，状态回到 `pending_approval`；旧 dispatch/assignment superseded；重新批准后再 dispatch。
- 已启动 Run：不允许原地修订；需要新 Plan/新 Work 或后续「追加计划」能力（不在本阶段）。
- 非实质性修改（仅措辞/备注）是否必须重新审批：建议按 checksum 变化判断；任务、依赖、验收标准、团队归属、个人 Agent 任一变化都算实质性，必须重新审批。

### E9. 助手动作协议

#### 动作类型（第一版）

| actionType | 风险 | 确认 | 复用服务 |
|---|---|---|---|
| `query`（agents/teams/skills/works/plans/providers） | read | 否 | 只读 Repository/Service |
| `create_agent_draft` | low | 是 | AgentDesignerService |
| `create_agent` | medium | 是 | AgentService.create |
| `create_team` | low | 是 | TeamService.create |
| `set_team_leader` | medium | 是 | TeamService.update |
| `add_team_member` | low | 是 | TeamService.addMember |
| `remove_team_member` | medium | 是 | TeamService.removeMember |
| `create_skill` / `update_skill` | low | 是 | SkillService |
| `create_work` | medium | 是 | WorkService.create（默认 draft） |
| `generate_plan` | medium | 是 | PlanService.generate |
| `start_plan` | high | 是 | PlanService.startRun |
| `pause_work` / `resume_work` | high | 是 | WorkService |
| `rework_continue` / `rework_take_over` | high | 是 | ReworkService |
| `reassign_task` | high | 是 | PlanService.reassignTask / assignTask |

**不建议**把 `approve_plan` / `reject_plan` 作为助手动作。审批是老板的治理门禁；助手只能展示计划和打开审批入口，不能代替老板决策。若产品最终要求“确认后由助手代按”，必须作为单独决策并写审计，但默认不开放。

#### 动作输出格式

模型返回：

```json
{
  "reply": "我可以帮你创建一个项目经理 Agent，并生成一份计划。",
  "actions": [
    {
      "actionType": "create_agent_draft",
      "payload": { "brief": "项目经理，负责需求拆解、排期和验收标准" },
      "description": "生成项目经理 Agent 草案",
      "riskLevel": "low"
    }
  ]
}
```

Core 生成 canonical `actionId`，写入 `assistant_actions`（proposed），聊天里显示动作卡。

#### 确认/执行

- `assistant.action.confirm({ actionId, requestId })`：
  - CAS `proposed → executing`；
  - 用协议 Zod 校验 payload；
  - 再执行一次业务校验（不能只信模型）；
  - 调对应 Core Service；
  - 成功写 `executed` + result；失败写 `failed`；
  - 重复请求返回已有结果，不重复创建。
- `assistant.action.cancel`：仅 `proposed → cancelled`；取消无副作用。
- 每次执行写 `audit_logs`，并在聊天中回写结果卡（资源类型/ID/名称/打开入口）。

#### 权限级别

| 级别 | 行为 |
|---|---|
| `advisory`（默认） | 所有写动作必须确认；查询自动 |
| `confirm_writes` | 同上（保留更细的策略位） |
| `low_risk_auto` | 只自动执行低风险动作（创建团队/技能等），中高风险仍需确认；“启动执行”永远确认 |

第一版建议只做 `advisory`；其他级别先保留枚举，不开放 UI 或只做只读展示。

---

## F. 接口设计

### F.1 服务边界

| 服务 | 职责 | 不做什么 |
|---|---|---|
| `AssistantService` | 会话、消息、上下文快照、调用 Assistant Agent、解析 reply/actions | 不直接写业务表 |
| `AssistantActionService` | 动作校验、确认、幂等、审计、执行器映射 | 不信任模型 payload |
| `PlanGeneratorService`（可由 PlannerService 重构） | 目标→PlanDraft；团队/个人归属；校验 | 不决定团队最终成员 |
| `PlanService` | Plan 生命周期、批准、dispatch 协调、startRun、reassign/assign、rework 入口、版本修订 | 不执行 CLI |
| `TeamDispatchService` | 按团队唤醒队长、校验输出、写 assignment/dispatch | 不调度节点、不改计划 |
| `TeamService` | Team/leader/member CRUD、团队指引 | 不选任务成员 |
| `ExecutionService` | 执行门禁、队列、Session/Execution、system prompt | 不做业务选人 |
| `WorkflowEngine/Scheduler/FairDispatcher` | 运行期调度 | 不新增队长逻辑 |
| `ReworkService` | 返工轮次/定向 attempt | 不重新随机派工 |

### F.2 RPC 方法（建议）

新增：

```text
assistant.thread.list/create/get
assistant.message.send          // 可能 30-120s，IPC 放宽
assistant.action.confirm
assistant.action.cancel
assistant.settings.get/update

team.update                     // 已存在；扩展 leaderAgentId
plan.assignTask                 // 启动前老板改派
plan.dispatch                   // 显式触发/重试队长派工（可选）
plan.dispatch.get               // 查看派工状态
plan.revise                     // 新版本 + 重新审批
```

复用：

```text
agent.create/update/archive
agent.generateDraft
skill.create/update/delete
team.create/update/archive/member.*
work.create/linkTeam/activate/pause/resume/complete/terminate
plan.generate/approve/reject/startRun/reassignTask/comment/thread.list
execution.start/get/logs/cancel/interrupt/sendMessage
```

### F.3 内部执行选项（Assistant / Leader 安全）

现有 `ExecutionStartParams` 只有 `agentId, prompt, workId?, worktreeId?`；系统服务无法为一次执行覆盖 system prompt 或工具策略。建议增加 **Core 内部**（不暴露 RPC）的 options：

```ts
type SystemExecutionOptions = {
  systemPromptOverride?: string
  toolPermissionsOverride?: ToolPermissions
  purpose: 'assistant_chat' | 'assistant_plan' | 'team_dispatch'
}
```

`ExecutionService.start(params, options?)` 只允许 Core 服务调用；RPC handler 永远不传 options。

- Assistant chat：`toolPermissionsOverride = { allow: [], deny: ['Bash','Write','Edit'] }` 或 allow `Read` only；建议第一版 `allow: []`，并在 ExecutionService 中为 `purpose='assistant_chat'` 放行空 allow（仍记录审计）。
- Plan mode：`systemPromptOverride = PLANNER_STRICT_PROMPT`；不使用 Assistant 的聊天指令。
- Team dispatch：`systemPromptOverride = TEAM_DISPATCH_PROMPT`；工具策略为空/只读；不得 Bash/写文件。
- 所有 override 必须写 `execution.tool_policy`/system log，便于审计。

> 这是本方案里最容易被忽视的安全点：`analyze` 不是「无工具」，它允许 Bash；不能把 Assistant/Leader 当作普通 analyze Agent 运行。

### F.4 Orchestrator / Scheduler 边界

- 不新增 `Orchestrator` 类；`PlanService` 继续承担计划启动编排。
- `TeamDispatchService` 是**计划阶段的业务协调器**，不参与运行期节点调度。
- `WorkflowFairDispatcher` 继续跨 Run 公平；`Scheduler` 继续单 Run 依赖/闸门/CAS；`ExecutionBridge` 继续节点→执行。
- 任何「队长在运行中重新派活」的需求，必须走 `plan.reassignTask`/node override，不允许队长直接改 Run。

### F.5 动作 payload 复用协议 Schema

动作 payload 必须直接复用现有协议参数 schema（或抽出共享 schema），例如：

- `create_agent` → `AgentCreateParams`
- `create_team` → `TeamCreateParams`
- `set_team_leader` → `TeamUpdateParams`
- `create_skill` → `SkillCreateParams`
- `create_work` → `WorkCreateParams`
- `generate_plan` → `PlanGenerateParams`
- `start_plan` → `PlanStartRunParams`
- `reassign_task` → `PlanReassignTaskParams` / `PlanAssignTaskParams`

不要为动作层再发明一套字段，避免「动作 payload 合法、业务参数非法」的双重标准。

---

## G. UI 页面调整

### G.1 导航

建议导航改为：

```text
工作台
  助手        ← 新增，默认入口
  规划
  项目
  任务

协作
  审批中心
  交付物
  Agents
  技能
  团队

系统
  备份中心
  （执行控制台仅 dev）
```

设置仍在左下角。助手作为默认页时，首次打开应创建/复用 Assistant Agent，并展示产品引导。

### G.2 Agentra 助手页

新增 `AssistantPage`：

- 左侧会话列表（新建/重命名/归档）；
- 右侧聊天：
  - 用户/助手消息；
  - 流式输出（复用 Execution 事件/日志，或轮询）；
  - 动作卡（类型、描述、风险、确认/取消）；
  - 结果卡（创建成功/失败、资源名称、打开入口）；
  - 错误卡（Provider 不可用、队长未设置、计划未批准等）；
- 首次进入可显示「我能帮你做什么」示例：创建 Agent、创建团队、生成计划、查看任务状态。
- 动作确认后刷新对应页面数据（agents/teams/plans/works）。
- 不显示任意 Shell 执行入口。

### G.3 团队页

当前已是左侧列表 + 右侧详情（成员/指引/近期任务）。新增：

- 详情头部：队长头像/名称/状态；「设置队长」/「更换队长」；
- 队长必须是团队成员；候选列表只显示团队成员；
- 成员行显示：头像、名称、擅长的工作、accessMode、Provider、当前负载（active executions / maxConcurrency）；
- 队长行加「队长」徽标，禁止移除队长（先更换）；
- 指南：团队指引仍可编辑；队长派工时读取，成员执行时也读取；
- 没有队长时：显示「设置队长后才能接收团队任务」，团队任务 dispatch 会被阻断。

### G.4 规划页

保留独立规划页，但降低创建入口权重：

- 顶部仍可目标/约束/Work 生成计划；
- 最近计划：待批准、已批准、运行中、历史；
- 计划详情：
  - 版本列表（PlanVersion）；
  - 任务 DAG/依赖（现有卡片/线程）；
  - 每个任务的 `teamId` 或直接 Agent；
  - 队长派工状态（按团队）；
  - 队长分配结果 + reason；
  - 老板改派（启动前 `plan.assignTask`；运行中 `plan.reassignTask`）；
  - 启动按钮：只有所有任务有 active assignment + dispatch 成功才可用；
  - 失败 banner：团队/队长/原因/重试/换队长/换团队/手动分配。
- 「重新规划」改为 `plan.revise`（同 Plan 新版本），不再总是新建 Plan；旧计划仍可保留。

### G.5 设置页

新增「Agentra 助手」卡片：

- Provider（必选，复用 Provider 列表/健康）；
- 模型（复用动态模型读取与自定义 ID）；
- 工作指令（Assistant Agent 的 systemPrompt）；
- 权限级别（第一版只启用 advisory；其他只读展示）；
- 允许的动作范围（多选）；
- 最大并发；
- 状态（active/disabled）；
- 当前 Assistant Agent 状态/最近执行。

**Base URL / API Key**：

- 当前架构没有 Agentra 管理的 Provider 凭据表；凭据由 Claude Code 设置/环境/cc-switch 管理（`RuntimeProviderRecord` 不含 key）。
- 建议设置页只显示 Provider 认证状态/可执行提示，不新增明文 API Key 输入。
- 如果必须由 Agentra 管理凭据，需要单独的 Secret Store（macOS Keychain / 加密存储）与 Provider 注入设计，属于独立高风险阶段，不应在第一版混入。

### G.6 任务页

- 任务群聊继续是主视图；
- 右侧「团队」显示关联团队、队长、当前 Assignment/负载；
- 任务详情可显示「队长派工结果」链接/摘要；
- 不把 Assistant 聊天混入任务群聊；Assistant 只提供跳转/摘要。

---

## H. 数据迁移与兼容性

### H.1 迁移版本建议

当前最高迁移 v26（`team_instructions`）。建议：

| 版本 | 名称 | 内容 |
|---|---|---|
| v27 | `team_leader` | `ALTER TABLE teams ADD COLUMN leader_agent_id ...`；可选：默认 Planner Agent 显示名迁移 |
| v28 | `plan_dispatch_assignments` | `plan_task_assignments` + `plan_dispatches` + 索引 |
| v29 | `assistant_workspace` | `assistant_threads/messages/actions/settings` + 索引 |
| v30（可选） | `agent_system_kind_assistant` | 仅当决定新增 `assistant` systemKind，需要重建 agent_profiles CHECK |

推荐先不做 v30：复用 `planner` kind，避免再重建 `agent_profiles`。

### H.2 旧数据兼容规则

1. **旧 Team**：`leader_agent_id` 为 null；允许查看/编辑/指引；团队任务 dispatch 被阻断，提示设置队长。**不自动猜队长、不把第一个成员设为队长。**
2. **旧 Plan/PlanVersion**：
   - `PlanTask.teamId` 缺失 → 按个人任务处理；
   - 启动时若 `plan_task_assignments` 没有 active 行，则从 `plan_versions.assignments_json` 生成 `source='legacy'` 行；
   - 旧计划行为保持不变，不需要重新批准；
   - 旧计划没有 dispatch 记录，不要求队长。
3. **旧 Assignment**：继续有效；StartRun 的 `ensureAssignments` 仍复用/恢复现有 Assignment；新增 Assignment 的 workRole 生成规则保持不变（`plan-<agent后缀>`），避免破坏 Workflow 节点匹配。
4. **旧 Run**：已启动 Run 不受新表影响；`workflow_runs.workflow_version_id` 仍是快照；node override 继续生效。
5. **旧 Planner Agent**：保留 `systemKind='planner'`；如果名称为默认 `Planner Agent`，可迁移为 `Agentra 助手`；用户自定义名称不覆盖。
6. **旧 Assistant 数据**：无。
7. **回滚**：v27-v29 都是增量表/列，不删除旧列；回滚代码可忽略新表；不要在迁移中删除 `plan_versions.assignments_json`，它是历史建议快照。

### H.3 兼容性红线

- 不得在迁移中回填队长（不能猜）。
- 不得把旧 `suggestedAgentId` 直接当作 team task 的最终成员；旧计划没有 teamId，仍按个人任务处理。
- 不得改变已发布 workflow version 的不可变触发器/checksum。
- 不得修改 Run 的状态机或 node 状态机；dispatch 是 Plan 层新状态，不进入 Workflow 状态机。
- 不得让队长派工直接写 `assignments` 表；必须先写 PlanTaskAssignment，StartRun 再统一建 Assignment。

---

## I. 测试方案

### I.1 现有测试基线

- 93 个测试文件；上一轮工作树最后验证 842 个用例通过。
- 本次架构审查**未运行测试**（按任务约束），因此实施前必须重新跑：
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`

### I.2 新增单元测试

**Team / Leader**
- 设置/更换队长：必须是 active Agent + active 团队成员。
- 移除队长：必须拒绝，先换队长。
- 更换队长自动加入新成员；旧队长保留成员身份。
- 团队归档后不可设置队长/派工。
- 队长 accessMode 限制（建议 analyze）。
- 队长不能作为团队任务候选。

**PlanTask / PlanGenerator**
- teamId 合法/不存在/归档团队。
- team task 与 suggestedAgentId 冲突（必须标记为非权威）。
- personal task 必须有可解析 Agent。
- 团队任务在无队长时生成计划：允许生成但 validation 标记不可启动。
- 旧 plan JSON 缺 teamId 的兼容解析。

**TeamDispatchService**
- 合法输出 → 原子写 dispatch + assignments。
- 漏 task / 多 task / 未知 task → 整批失败，零写入。
- Agent 非团队成员 / inactive / 权限不匹配 / 超并发 → 失败。
- 队长本人被分配 → 失败。
- 重复派工 CAS → 只执行一次。
- 队长执行失败/超时/JSON 非法 → dispatch failed，计划仍 approved，startRun 拒绝。
- 并发两个 dispatch 请求 → 一个执行，一个返回已有状态。

**Plan assignment**
- 启动前老板改派：团队成员/权限校验；旧行 superseded、新行 active；audit/线程记录。
- 个人任务改派：active Agent 校验。
- 重复改派幂等。
- 旧计划 legacy 行生成。
- 所有 task 有 active assignment 才能 startRun。

**Plan version**
- revise 创建新版本、重新 pending_approval、旧 dispatch/assignment superseded。
- checksum 不变拒绝空修订。
- 已启动 Run 拒绝 revise。
- 旧版本历史仍可读。

**Assistant**
- 聊天输出解析：合法 reply/actions、非法 JSON 只展示文本。
- 动作 payload Zod/业务校验。
- 确认幂等（重复 confirm 不重复创建）。
- 取消无副作用。
- 权限级别：advisory 全部写动作要求确认；读动作自动。
- 助手不能审批计划（如果采用推荐策略）。
- 无工具执行策略（不允许 Bash/Write）。

### I.3 集成测试

- DB 迁移 v27-v29：旧 Team/Plan/Run/Assignment 数据保留；FK/索引/唯一约束。
- Plan 批准 → 队长派工 → 老板改派 → startRun → Run/Definition 快照正确。
- 队长失败 → startRun 拒绝 → 重试成功。
- 启动后修改 PlanTaskAssignment/PlanVersion → 已启动 Run 的节点 agent 不变。
- 运行中 `plan.reassignTask` → 下一次 attempt 使用 override；rework 保持原 Agent。
- 旧计划（无 teamId/无 dispatch）仍可 startRun。
- Assistant 对话 + 动作确认 → 调用真实 Core service → 资源创建；重复确认幂等。
- Assistant 动作失败不会产生部分资源（事务/服务保证）。
- 并发两个确认 → 一个执行。

### I.4 E2E / 人工验收

- 真实 Claude Code：助手聊天、生成计划、队长派工（如果 CLI 可用）、老板改派、启动、返工。
- UI：助手页会话/流式/动作卡/结果卡；团队页设置队长/负载；规划页 dispatch 状态/改派/启动；设置页助手参数。
- 失败路径：Provider 未认证、队长未设置、队长 JSON 无效、团队无成员、任务权限不匹配、并发不足。
- 验收测试不得 `skip`；环境缺失必须失败并提示。

### I.5 测试矩阵（最小）

| 场景 | 单元 | 集成 | E2E |
|---|---|---|---|
| 设置队长/成员约束 | ✓ | ✓ | ✓ |
| 团队任务生成/校验 | ✓ | ✓ | |
| 队长派工成功 | ✓ | ✓ | ✓ |
| 队长失败/不回落 | ✓ | ✓ | ✓ |
| 老板启动前改派 | ✓ | ✓ | ✓ |
| Run 快照隔离 | ✓ | ✓ | |
| 旧计划兼容 | ✓ | ✓ | |
| 返工不重派 | ✓ | ✓ | |
| Assistant 聊天/动作 | ✓ | ✓ | ✓ |
| 动作幂等/取消/权限 | ✓ | ✓ | |

---

## J. 分阶段实施计划

### 阶段 0：决策与 ADR（0.5–1 天）

- 目标：确认本方案的 8 个决策点（见 L.5）。
- 产出：更新 `DECISIONS.md`（D-035 等）；不改代码。
- 前置：用户确认。
- 验收：决策记录签字/确认。
- 回滚：无代码。

### 阶段 1：团队队长模型与团队页（2–3 天）

- 目标：Team 有唯一有效队长；UI 可设置/更换；数据约束成立。
- 具体：
  - 迁移 v27 `teams.leader_agent_id`；
  - TeamRepository/Service/Protocol `leaderAgentId`；
  - `team.update` 支持 leader；
  - 队长必须是成员、active、建议 analyze；移除队长拦截；
  - TeamsPage 展示/设置队长、成员负载、队长徽标。
- 模块：`apps/core/src/db`、`services/team-service.ts`、`packages/protocol/methods/team.ts`、`TeamsPage.tsx`、`useAgentra`/IPC。
- 前置：确认队长是否必须 analyze；确认是否排除队长作为任务候选。
- 风险：旧团队无队长；不自动猜。
- 验收：单测/集成/UI；旧团队可读、无队长时显示提示。
- 回滚：迁移只加列；UI 可隐藏；旧数据不受影响。

### 阶段 2：PlanTask teamId + 队长派工 + Assignment 权威（5–8 天）

- 目标：团队任务只能由队长/老板分配；启动前有完整、可审计的 assignment。
- 具体：
  - PlanTask `teamId`；Planner prompt/registry 加 Team；
  - Plan validation：团队/个人任务规则；无队长可生成但不可启动；
  - 迁移 v28 `plan_task_assignments` + `plan_dispatches`；
  - `TeamDispatchService`：按团队聚合、队长执行、结构化输出、Core 校验、事务写入；
  - `PlanService.dispatch` / `startRun` 门禁 / `plan.assignTask` / 旧计划 legacy 行；
  - PlanPage 展示/改派/重试/失败原因；
  - 审计 + 计划线程消息。
- 前置：阶段 1；确认 dispatch 在批准后由 Core 自动触发还是 UI 显式触发（建议自动触发 + 可重试）。
- 风险：最高风险阶段；双头派工、失败回落、并发、旧数据。
- 验收：I.3 全部；旧计划启动不回归；队长失败 startRun 拒绝；Run 快照隔离。
- 回滚：应用代码可关闭 dispatch（legacy 路径）；新表不删除；迁移不破坏旧数据；发布前备份。

### 阶段 3：助手只读聊天 + 设置（3–5 天）

- 目标：老板有一个统一入口，可教学/查询/解释当前资源；不执行写动作。
- 具体：
  - 复用/重命名 Planner Agent 为 Agentra 助手；内部 planner kind；
  - 迁移 v29 assistant threads/messages（先不做 actions）；
  - AssistantService：上下文快照、聊天执行、消息存储；
  - AssistantPage：会话/流式/错误；
  - 设置页助手 Provider/模型/指令/并发/状态；
  - 无工具/只读内部执行策略。
- 前置：阶段 2 的 Plan/Team 数据可查询；确认 Assistant 是否允许读取文件/仓库（建议不）。
- 风险：Provider JSON/聊天稳定性、工具越权、会话膨胀。
- 验收：助手能回答产品用法、查询资源、生成计划（调用 PlanGenerator，不自动批准）。
- 回滚：隐藏助手导航；Assistant 表保留；Planner 旧路径仍可用。

### 阶段 4：助手动作提案 + 确认执行（5–8 天）

- 目标：助手可提出创建资源/执行控制动作；老板确认后由 Core 执行。
- 具体：
  - assistant_actions 表；动作协议/校验/幂等/审计；
  - AssistantActionService 映射到现有 services；
  - 动作卡/结果卡/打开资源；
  - 权限级别（第一版 advisory）；
  - 创建 Agent/Team/Skill/Work、生成计划、启动/暂停/恢复/返工；
  - 审批动作不开放（建议）。
- 前置：阶段 3；协议 action payload schema 复用。
- 风险：模型生成恶意/错误 payload、重复动作、越权。
- 验收：单元/集成/E2E；重复确认不重复创建；取消无副作用。
- 回滚：关闭动作功能，聊天只读；动作表保留。

### 阶段 5：计划版本修订与体验收口（3–4 天）

- 目标：计划修订可追溯、可重新审批；旧计划/新流程统一。
- 具体：
  - `plan.revise`；PlanVersion v2+；dispatch/assignment supersede；
  - PlanPage 版本列表/差异提示；
  - 运行中禁止修订；
  - 旧计划迁移提示；
  - 文档/验收矩阵。
- 前置：阶段 2/4；
- 风险：版本冲突、审批状态、Run 隔离；必须 fail closed。
- 验收：修订→重新批准→重新派工→启动；旧 Run 不受影响。
- 回滚：禁用 revise 入口；旧版本仍可读。

---

## K. 风险清单

| # | 风险 | 触发 | 影响 | 缓解 |
|---|---|---|---|---|
| K1 | 双头派工 | Planner suggestedAgentId 与 leader assignment 并存 | 两份负责人，执行不可追溯 | PlanTask teamId 语义；suggestedAgentId 仅建议；StartRun 只读 PlanTaskAssignment；测试覆盖 |
| K2 | 计划/分配不一致 | 老板改派/队长重试/旧数据 | 启动错人 | active 唯一约束；事务；startRun 校验；审计 |
| K3 | 队长失败被静默回落 | 队长超时/JSON 非法 | 随机派工，失去控制 | dispatch failed；startRun 拒绝；不回落；UI 重试/换队长 |
| K4 | 队长越权/执行任务 | 队长 Agent 有 Bash/写权限 | 队长改代码/执行任务 | 内部 `toolPermissionsOverride` 无工具；排除队长作为候选；prompt 规则 |
| K5 | 助手越权 | 模型生成 shell/DB 动作 | 破坏数据/主机 | 动作白名单；Core Zod/业务校验；确认；无 Shell；审计 |
| K6 | 重复动作 | 重复点击/重试 | 重复创建 | actionId 幂等；CAS；requestId |
| K7 | 并发派工 | 两个请求同时 dispatch | 重复队长执行/重复 assignment | UNIQUE(plan_version, team)；CAS status；单事务写 |
| K8 | 旧数据迁移 | 旧 Team 无 leader / 旧 Plan 无 teamId | 启动失败/行为变化 | 队长不猜；旧计划 legacy 路径；迁移测试；回滚 |
| K9 | 返工路由错误 | 队长重新随机分配 | 返工给错人/循环 | 返工沿原 Assignment/override；不重跑队长；老板改派 |
| K10 | 计划版本变化影响运行中 Run | 批准后改 Plan/Assignment | 已启动 Run 换人 | Run 引用不可变 workflow version；startRun 后禁止 revise；节点 override 仅未来 attempt |
| K11 | 并发容量不匹配 | 队长给同一 Agent 分配过多并行任务 | 排队/延迟/锁冲突 | wave-aware 校验；maxConcurrency；UI 显示负载 |
| K12 | 模型 JSON 不稳定 | 队长/助手输出非 JSON | 派工/动作失败 | 严格 parse；失败 fail closed；重试；不猜文本 |
| K13 | 团队指引过长 | 注入 prompt | 超 100k/成本 | 限制长度；截断并审计；提示用户 |
| K14 | 助手会话膨胀 | 长期聊天 | prompt/成本 | 滑动窗口；摘要；会话归档 |
| K15 | Provider 凭据管理 | 设置页要求 Base URL/Key | 凭据泄露/重复管理 | 第一版不存凭据；用 CLI 配置；如要做走 Keychain/独立阶段 |
| K16 | 审批被助手替代 | 助手直接 approve | 破坏 Human Governs | 不开放 approve 动作；老板人工批准 |
| K17 | 迁移破坏旧数据 | 重建/删除 | 数据丢失 | 只加列/表；不删 version JSON；迁移测试；备份 |

---

## L. CTO 最终建议

### L.1 推荐架构

**推荐：保留现有执行内核，增加两层业务协调：**

1. **PlanGenerator**（现有 PlannerService 重构）：只回答「做什么、依赖、验收、团队归属」。
2. **TeamDispatchService**（新增）：只回答「团队任务给谁」。
3. **AssistantService**（新增）：统一入口/聊天/资源/动作提案，复用 Core services。
4. **PlanService**：计划生命周期编排，不新增调度器。
5. **Workflow Engine + Scheduler + FairDispatcher + ExecutionBridge**：完全保留。

### L.2 不推荐的方案

- ❌ **让 Planner 继续最终选团队成员，再加队长**：双头权威。
- ❌ **照搬 Multica 的队长 @成员 + 评论触发循环**：Agentra 已有 DAG/Assignment/Workflow Engine，会形成第二套调度/触发系统。
- ❌ **助手直接执行 Shell/改数据库**：破坏 Core 权威与安全边界。
- ❌ **新增独立 Orchestrator/Scheduler**：现有 PlanService/FairDispatcher/Scheduler 已覆盖；重复实现会分叉状态。
- ❌ **原地修改已批准 PlanVersion**：破坏审批与 Run 快照。
- ❌ **把 Base URL/API Key 明文存进 Agentra**：现有 Provider 凭据由 CLI/系统管理；如需应用管理，必须单独安全设计。
- ❌ **让助手直接审批计划**：违反 Human Governs；助手只能准备/解释/打开审批。

### L.3 第一阶段做什么

**先做阶段 1 + 阶段 2（团队队长 + PlanTask teamId + dispatch + assignment）：**
- 这是执行真相的变更，必须先定；
- 做完后，助手只需要调用稳定接口；
- 不需要改 Workflow Engine/Scheduler/Rework；
- 可在旧计划 legacy 路径下保持兼容。

### L.4 暂时不要做

- Assistant 低风险自动执行（先只做 advisory + 确认）；
- 助手管理 Provider 明文凭据；
- 队长运行中自动重新派工；
- 跨团队自动协调器；
- 计划修订影响已启动 Run；
- 任意 Shell 控制。

### L.5 需要老板决策的点

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| 1 | 任务团队归属粒度 | 每个 PlanTask 一个 teamId；不做整任务一个团队 | 数据模型/Planner |
| 2 | 队长派工时点 | 批准后、启动前 | 状态/UI |
| 3 | 队长分配是否要老板二次确认 | 不需要额外审批；老板可在启动前改派 | UX/控制 |
| 4 | 队长是否必须 analyze | 是，且内部无工具 | 安全 |
| 5 | 队长是否排除在团队任务候选外 | 是 | 派工规则 |
| 6 | 助手是否允许审批计划 | 否（推荐）；只展示/打开审批 | Human Governs |
| 7 | 助手第一版权限 | advisory（全部写动作确认） | 安全/UX |
| 8 | Planner/助手是否一个 Agent | 一个 Agent，内部计划模式 prompt override；复用 planner kind | 迁移/实现 |
| 9 | 是否在应用内管理 Base URL/API Key | 否；沿用 CLI/Provider 配置 | 安全 |
| 10 | 计划修订是否重新审批 | 是，实质性变更必须重新批准 | 版本/流程 |
| 11 | 旧计划是否自动补队长 | 否；legacy 按个人任务启动 | 兼容 |

### L.6 是否具备开始实施条件

**有条件具备。** 先确认 L.5 的 1–11（至少 1、2、3、4、5、8、10），然后从阶段 1 开始。阶段 2 是高风险，必须在开始前对现有 842 用例跑全量门禁并做迁移备份。

---

## M. Git 状态保护报告

### M.1 审查前

- 工作目录：`/Volumes/MacExt SSD/Self Work/Agentra`
- Git 根：`/Volumes/MacExt SSD/Self Work/Agentra`
- 分支：`feat/agentra-ux-plan-runtime`
- HEAD：`b8e21c8c2a1de620f6f444951c966d2709eff94c`
- HEAD subject：`fix(ui): anchor provider popover above status button`
- `git status --porcelain=v1`：95 项
  - 72 ` M`（未暂存修改）
  - 2 ` D`（未暂存删除：`agent-capability-matcher.ts` 与其测试）
  - 21 `??`（未跟踪）
  - 0 staged
- `git status --short --ignored`：130 行（含 35 条 ignored：dist、node_modules、.DS_Store、.claude 等）
- 操作标记：`MERGE_HEAD`、`REBASE_HEAD`、`CHERRY_PICK_HEAD`、`BISECT_LOG` 均不存在
- `git stash list`：空
- Worktrees：
  - `/Volumes/MacExt SSD/Self Work/Agentra`（当前分支）
  - `/Users/mac/.antumi/worktrees/b3f35939/Agentra`（`phase5.5/backup-ui`，未触碰）
- 运行中的进程：一个 Electron/Core/Daemon 实例（数据目录 `~/agt-agents-clean4`，CDP 9228）；无测试/构建/安装进程。
- 未完成操作：无 merge/rebase/cherry-pick/bisect；工作树为本轮之前的未提交改动。

### M.2 审查后

- 新增文件：`docs/agentra-assistant-team-leader-architecture.md`（本文件）
- 修改的既有文件：**无**
- 删除/移动的既有文件：**无**
- 数据库/配置/测试：**未修改**
- 迁移：**未运行**
- 测试/构建/安装：**未运行**（按本轮约束）
- 预期 `git status --porcelain=v1`：原 95 项 + 1 个 `?? docs/agentra-assistant-team-leader-architecture.md` = 96 项；其余类别与审查前一致。

### M.3 审查范围声明

本报告只对当前工作树做只读检查。工作树已有 95 项未提交变更属于上一轮 Agent 权限/技能/Provider/团队页工作，不是本审查修改；本审查没有回退、覆盖或格式化它们。

---

## 附录 A：关键代码索引

| 主题 | 文件/方法 |
|---|---|
| Planner 生成/校验 | `apps/core/src/services/planner-service.ts:97` `generate`；`:359` `validate`；`:464` `ensurePlannerAgent`；`:523` `registrySnapshot`；`:565` `buildPrompt` |
| Plan 生命周期 | `apps/core/src/services/plan-service.ts:126` `generate`；`:152` `persist`；`:243` `approve`；`:300` `startRun`；`:625` `reassignTask`；`:889` `ensureAssignments` |
| Plan 协议 | `packages/protocol/src/methods/plan.ts:29` `PlanTask`；`:80` `PlanAssignment`；`:134` `PlanRecord`；`:149` `PlanVersion` |
| Plan 编译 | `apps/core/src/services/plan-compiler.ts:118` `compilePlanDefinition` |
| Assignment 解析 | `apps/core/src/workflow/assignment-resolver.ts:35` `resolveForNode`；`:81` `precheck` |
| Run 创建/快照 | `apps/core/src/workflow/run-service.ts:48` `createRun`；`:72` `precheck`；`published-definition-provider.ts:45` |
| Engine/Scheduler | `apps/core/src/workflow/engine.ts:66`；`scheduler.ts:186` `tick`；`fair-dispatcher.ts:35` |
| Execution bridge | `apps/core/src/workflow/execution-bridge.ts:145` `onNodeStarted`；`:205` `startForNode`；`:225` `onExecutionFinished` |
| Rework | `apps/core/src/workflow/rework-service.ts:166` `requestForTestFailure`；`:369` `start`；`:480` `continueExhausted`；`:531` `takeOverExhausted` |
| Execution 门禁 | `apps/core/src/services/execution-service.ts:446` `startInternal`；`:493` 并发；`:403` `composeSystemPrompt` |
| Agent/权限 | `apps/core/src/services/agent-service.ts:20` `ACCESS_MODE_TOOL_POLICY`；`packages/protocol/src/dto.ts:106` `AgentSystemKind`；`:120` `AgentProfile` |
| Team | `apps/core/src/services/team-service.ts:33`；`apps/core/src/db/repositories/team-repository.ts`；`packages/protocol/src/methods/team.ts:7` `team.update` |
| Team instructions | `migrations.ts:929` v26；`execution-service.ts:403-425` |
| Assistant 参考模式 | `apps/core/src/services/agent-designer-service.ts:111` `AgentDesignerService`；`:196` `ensureDesignerAgent` |
| Model discovery | `apps/core/src/services/provider-registry.ts:78` `listModels`；`packages/runtime-cli/src/claude-code/models.ts`；`codex/models.ts` |
| UI 导航 | `apps/desktop/src/renderer/App.tsx:36` `NAV_GROUPS` |
| 规划页 | `apps/desktop/src/renderer/components/PlanPage.tsx:66`；`:444` PageHeader；`:590` 计划详情 |
| 团队页 | `apps/desktop/src/renderer/components/TeamsPage.tsx:55` |
| 设置页 | `apps/desktop/src/renderer/components/SettingsPage.tsx:71` |
| 任务详情 | `apps/desktop/src/renderer/components/WorksPage.tsx:54`、`:384-415` |

## 附录 B：方案验收问题逐条回答

1. **老板只通过一个 Agentra 助手，是否可以管理整个 Agentra？**
   可以，前提是助手动作协议 + Core 校验 + 确认机制落地；助手不直接操作 DB/Shell。

2. **助手是否可以帮助老板创建 Agent、团队、任务和技能？**
   可以，复用现有 AgentService/TeamService/WorkService/SkillService；第一版走动作提案 + 老板确认。

3. **助手是否可以生成复杂任务计划？**
   可以，复用 PlanGenerator（现有 PlannerService 重构）；计划仍需老板批准。

4. **规划是否仍然保留独立的业务价值？**
   是。规划负责任务内容、依赖、验收标准、团队归属；不再负责团队最终成员选择。

5. **团队任务是否只能由队长决定最终执行成员？**
   是。团队任务在批准后由队长派工；Planner 的 suggestedAgentId 只能是非权威建议；老板可改派。

6. **个人任务是否可以绕过队长直接指定 Agent？**
   可以。`teamId=null` + `suggestedAgentId`；仍由 Core 校验 active/accessMode。

7. **队长分配失败是否会安全停止？**
   是。dispatch failed，Plan 保持 approved；startRun 拒绝；不回落；老板可重试/换队长/换团队/手动分配。

8. **老板是否可以在启动前修改分配？**
   可以。`plan.assignTask` 更新 active PlanTaskAssignment，记录 reason/audit；运行中使用现有 `plan.reassignTask`。

9. **Plan、Assignment 和 Run 是否保持一致？**
   设计上：PlanVersion 内容不可变；PlanTaskAssignment 是启动前权威；Run 使用 published workflow version 快照；运行中 override 只影响未来 attempt。

10. **已启动 Run 是否不受后续计划变化影响？**
    是。Run 引用不可变 workflow version；计划修订只允许未启动计划；运行中改派走 override。

11. **助手是否只能通过 Core 业务接口操作软件？**
    是。动作层复用 Core Service/协议 Zod；无 DB/文件/Shell 直接访问。

12. **现有返工、审批、暂停、恢复和执行引擎是否完整兼容？**
    是。返工继续沿原 Assignment/override，不重新调用队长；审批仍是老板；暂停/恢复/Engine/Scheduler 不改。

13. **是否能在不推翻现有核心架构的情况下分阶段实现？**
    能。阶段 1/2 只加 Team leader、PlanTask.teamId、assignment/dispatch 表和 PlanService 编排；Workflow Engine/Scheduler/Rework/Execution 不重写。

## 附录 C：待确认问题

1. 团队任务的最小粒度：每个 PlanTask 一个 teamId（推荐），还是整个 Plan 只归属一个团队？
2. 队长派工是批准后自动触发，还是由老板/助手显式点击「开始派工」？（推荐自动触发 + 可重试）
3. 队长必须 analyze 且内部无工具，是否接受？（推荐是）
4. 队长是否排除在团队任务的候选成员之外？（推荐是）
5. 助手是否允许审批计划？推荐否；如果允许，必须明确是「老板确认后助手代按」并写审计。
6. Assistant 与 Planner 是否共用一个 Agent？（推荐共用 `planner` kind + 内部 prompt override）
7. 是否需要在应用内管理 Provider Base URL/API Key？推荐第一版不做。
8. 计划修订是否必须重新审批？推荐实质性变更必须。
9. 旧团队没有队长时，是阻断团队任务，还是允许老板手动指定成员？（推荐阻断队长派工，但允许老板手动分配并记录 source=user）
10. 队长派工的并发容量校验采用 wave-aware（推荐）还是简单总任务数上限？
