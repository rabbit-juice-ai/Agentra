# Agentra 上下文管理架构专项审查

- 日期：2026-11-08
- 审查范围：Session Lifecycle / Task Memory / Checkpoint / Context Builder
- 审查基线：`main`，HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`，当前工作区包含尚未提交的团队协作与 UI 改造
- 审查方式：只读代码审查 + 本地 SQLite 只读统计；本次仅修订文档，未修改业务代码、未执行迁移、未修改 Prompt 或权限
- 产品原则（CTO 已确认）：**用户管理任务，Agentra 自动管理上下文和会话；不提供手动 Session 控制入口**
- 决策基线：Provider Resume 分阶段（Phase 1 Checkpoint 重建、Phase 2 Resume）；Planner 采用项目级 Thread；验收标准 Work + Task Memory 双层保存；Checkpoint 失败按风险分级；Token 软/硬阈值 70%/85%

---

## 0. 结论摘要

当前系统实际上已经做到了一部分“避免单会话无限增长”：

- 每次 Planner 对话、队长运行、成员运行、工作流节点 attempt 都会创建新的 Execution 和新的模型 Session；
- 没有把 Claude Code 的 Session ID 当作任务 ID；
- 任务/线程/消息是持久化的，模型上下文在每次运行时重新组装。

但它还不是一套上下文管理系统，而是**“每次运行新建 Session + 最近 N 条聊天消息重建上下文”**：

- 没有 Task Memory；
- 没有 Checkpoint；
- 没有 Context Builder；
- 没有 Token 预算、上下文窗口模型目录、Session 指标；
- 没有 Session 复用、压缩、自动切换和失败恢复；
- 所有 Provider 适配器都把 `resume` 声明为 `unsupported`，Core 也没有传递 `resumeSessionId`；
- 任务验收标准在 Planner 动作里有，但没有持久化到 Work/Task Memory，队长和成员的 Prompt 看不到；
- 团队任务的长报告直接进入最近 30 条消息，可能造成上下文爆炸；
- 本地样本中 37 个 Session 对应 37 个 Execution，执行日志已约 128 MB，且没有清理策略。

**建议的目标架构是四层：Agent 身份层、Project Memory、Task Memory、Session/Checkpoint。实现上先采用一个 `TaskContextService` 统一管理 Task Memory 与 Checkpoint，再加一个纯函数式 `ContextBuilder`；`SessionLifecycleManager` 在 Phase 1C 引入基础接口、Phase 2 完善。全部围绕现有 `ExecutionService` 扩展，不引入第二套调度器或执行引擎。**

**已确认的路线约束：**

- Phase 1 必须 Provider 无关，依靠 Task Memory + Checkpoint + Context Builder 新建 Session；Phase 2 才接 Claude Code / CodeBuddy Resume；
- Planner 采用项目级 Thread，旧 `planner_messages` 必须迁移而不是删除；
- Work 保存正式验收标准，Task Memory 保存带版本引用的快照；
- Checkpoint 失败按风险分级，任何任务都不得假装创建成功；
- Token 软阈值 70%、硬阈值 85%，阈值可由 Core 配置调整，不暴露为用户 Session 控制；
- Phase 1A 可以先于 Planner Thread 迁移启动：Task Memory 以 Work 为隔离边界，`project_id` 来自 Work，不依赖 `planner_threads`。

---

## 1. 当前代码实现核实

### 1.1 关键数据表

| 表 | 作用 | 代码位置 |
|---|---|---|
| `agent_sessions` | 执行会话账本：`assignment_id`、`provider_id`、`external_session_id`、`context_ref`、`status(active/ended)`、时间戳 | `apps/core/src/db/migrations.ts:64-74`，v3 重建在 `:211-230` |
| `executions` | 一次模型执行：`session_id`、`node_run_id`、Provider、进程、状态、工作目录、能力快照 | `apps/core/src/db/migrations.ts:77-95`，v10 重建在 `:456-490` |
| `execution_logs` | 原始 stdout/stderr/system/structured 日志 | `apps/core/src/db/migrations.ts:97-105` |
| `works` | 任务：目标、描述、根目录、生命周期状态、issue 状态、负责人 | `apps/core/src/db/migrations.ts:146-161`，v29 扩展在 `:1017-1026` |
| `assignments` | Work × Agent 岗位；`context_ref` 列存在但当前团队路径未使用 | `apps/core/src/db/migrations.ts:170-185` |
| `projects` | 项目：只有名称、描述、状态 | `apps/core/src/db/migrations.ts:779-787` |
| `planner_messages` | Planner 持久聊天；没有 `project_id` | `apps/core/src/db/migrations.ts:1028-1041` |
| `team_task_messages` | 团队任务线程；按 `work_id` 隔离 | `apps/core/src/db/migrations.ts:1043-1058` |
| `team_task_subtasks` | 队长拆出的子任务 | `apps/core/src/db/migrations.ts:1060-1075` |
| `team_task_runs` | 队长/成员运行队列，`execution_id` 关联 Execution | `apps/core/src/db/migrations.ts:1077-1104` |
| `team_task_run_steps` | 工具调用步骤（Bash/Read/Edit 等） | `apps/core/src/db/migrations.ts:1108-1123` |
| `artifacts` / `artifact_versions` | 工作流正式交付物；版本不可变 | `apps/core/src/db/migrations.ts:611-660` |
| `rework_requests` | 工作流返工请求；`UNIQUE(target_node_run_id, round)` | `apps/core/src/db/migrations.ts:528-546` |

没有 `task_memories`、`task_checkpoints`、`project_memories`、`context_manifests`、`session_metrics` 等表。全仓搜索没有对应的服务或迁移。

### 1.2 Execution / Session 创建链路

实际调用链：

```text
PlannerChatService.send
  → PlannerChatService.runPlanner
  → ExecutionService.startSystem({ agentId, prompt }, { purpose: 'planner_chat', toolPermissions: [] })
  → ExecutionService.startInternal
  → 新建 ses-* + externalSessionId(UUID)
  → agent_sessions.create(status='active', context_ref=agentId, external_session_id=UUID)
  → executions.create(status='pending', session_id=ses-*)
  → Daemon execution-manager.start
  → Claude Code: --session-id UUID
  → 终态：recordTerminalObservation → executions.finish + agent_sessions.end
```

对应代码：

- `PlannerChatService.send` 持久化用户消息后调用 `runPlanner`：`apps/core/src/services/planner-chat-service.ts:158-185`
- `runPlanner` 调用 `startSystem`：`:397-405`
- `ExecutionService.startSystem`：`apps/core/src/services/execution-service.ts:390-405`
- Session/Execution 创建：`apps/core/src/services/execution-service.ts:522-581`
- 终态结束 Session：`:1132-1139`
- Session 表结构：`apps/core/src/db/migrations.ts:64-74`、`:211-230`
- Session 数据访问只有 `create/get/bindAssignment/end`：`apps/core/src/db/repositories/session-repository.ts`

团队任务：

```text
TeamCollaborationService.createFromPlanner
  → 创建 Work / 激活 / 初始消息
  → enqueueRun(leader)
  → startRunInternal
  → ExecutionService.startSystem({ agentId: leader, prompt: leaderPrompt })
  → 新 Session（无 assignment，context_ref=leaderAgentId）

TeamCollaborationService.startRunInternal(member)
  → ensureWithRoleInTransaction（Assignment）
  → ExecutionService.start({ agentId, workId, prompt: memberPrompt })
  → 新 Session（assignment_id 绑定）
```

对应代码：

- `createFromPlanner`：`apps/core/src/services/team-collaboration-service.ts:143-180`
- `startRunInternal`：`:728-805`
- 队长 `startSystem`：`:744-755`
- 成员 `start`：`:776-783`
- 任务运行记录 `team_task_runs.execution_id`：`apps/core/src/db/migrations.ts:1077-1094`

工作流任务：

```text
WorkflowScheduler tick
  → ExecutionBridge.start
  → ExecutionService.startForNode(nodeRunId, { agentId, workId, prompt })
  → 新 Execution + 新 Session
```

对应代码：

- `ExecutionBridge` 启动节点执行：`apps/core/src/workflow/execution-bridge.ts:204-210`
- `ExecutionService.startForNode`：`apps/core/src/services/execution-service.ts:411-415`
- 工作流 attempt 与 NodeRun：`apps/core/src/workflow/execution-bridge.ts:434-446`
- 返工产生新 attempt：`apps/core/src/workflow/rework-service.ts`；`rework_requests` 的 `UNIQUE(target_node_run_id, round)` 是幂等键

### 1.3 Session ID 的实际含义

- `agent_sessions.external_session_id` 是 Core 生成的随机 UUID：`execution-service.ts:523-524`
- 同一个 UUID 同时写入 `executions.external_execution_id`：`:553`
- Daemon 把它作为 CLI 的 `sessionId` 传入：`apps/daemon/src/runtime/execution-manager.ts:165-175`
- Claude Code 适配器用 `--session-id <sessionId>` 启动：`packages/runtime-cli/src/claude-code/args.ts:7-25`

结论：**`external_session_id` 是 Provider 会话 ID 的载体；`executions.external_execution_id` 当前并不是 Provider 返回的执行 ID，而是同一个 Session UUID 的重复存储。** 这是一个命名/语义债务，接入 resume 时必须先澄清。

### 1.4 Session 与 Execution 的实际基数

本地只读统计（`~/Library/Application Support/agentra/agentra.db`）：

```text
agent_sessions: 37
executions: 37
execution_logs: 585,484 行
execution_logs 内容大小: 127,892,621 bytes（约 128 MB）
sessions per execution: 全部为 1（37 个 Session 都是 1 个 Execution）
sessions with assignment_id: 6
sessions without assignment_id: 31
planner_messages: 30
team_task_messages: 87
team_task_runs: 26
```

这说明当前是**构造上的 1 Session : 1 Execution**；Schema 本身允许一个 Session 对应多个 Execution（`executions.session_id` 没有唯一约束），但代码从不复用 Session。

### 1.5 Session 生命周期当前行为

- 创建：每次 `ExecutionService.startInternal` 新建 Session，状态 `active`。
- 运行：Session 不随执行更新 `last_active_at`、不记录 token、不记录 turn。
- 终态：任何终态（succeeded/failed/cancelled/crashed）都调用 `sessions.end`：`execution-service.ts:1132-1139`。
- 排队：Execution 可能先 pending，Session 已 active；Core 重启时排队 Execution 被 `discardQueuedOnStartup` 标为 failed，Session 随终态结束：`execution-service.ts:1551-1567`。
- 取消：Execution 终态 cancelled，Session 结束；没有 Checkpoint。
- 失败/崩溃：Session 结束；没有 Session 恢复入口。
- 重试：工作流 `retryOrFail` 创建新 NodeRun attempt，新 Execution，新 Session；`scheduler.ts:440-450` 的注释提到“resume 走既有 session”，但当前代码没有任何 `resumeSessionId` 调用，注释与实现不一致，应以代码为准。
- 返工：`ReworkService` 创建新 attempt / 新执行链；没有上下文摘要或 Checkpoint。
- Agent 更换：Assignment 改派后，新 Agent 使用新 Session；没有记忆迁移。
- 任务完成：Session 结束；没有最终 Checkpoint。

### 1.6 当前上下文组装

#### Planner

`PlannerChatService.buildPrompt` 实际包含：

1. Planner 固定 system prompt；
2. 活跃团队列表（名称、描述、instructions、队长、成员 ID）；
3. Agent 列表（名称、描述、accessMode、状态）；
4. Provider 列表（名称、健康状态）；
5. 最近 **40 条** `planner_messages`，按 `作者: content` 拼接；
6. 本次输入（`老板说：...` 或升级问题）。

代码：`apps/core/src/services/planner-chat-service.ts:426-479`。

限制：

- `planner_messages` 没有 `project_id`，Planner 聊天是全局的；
- 没有项目记忆、计划版本摘要、任务结果摘要；
- 没有 Token 预算，40 条消息按原文字符串拼接；
- 没有上下文来源清单，也没有裁剪优先级。

#### Team Leader

`leaderPrompt` 包含：

1. 角色说明（团队队长、只协调不执行）；
2. 任务名称、目标、描述；
3. 团队 instructions；
4. 成员列表（ID、名称、描述、accessMode）；
5. 已有子任务（ID、标题、状态、负责人）；
6. 触发消息；
7. 最近 **30 条** `team_task_messages`（`authorType(authorId): content`）；
8. JSON 输出契约。

代码：`apps/core/src/services/team-collaboration-service.ts:856-884`，`contextFor` 在 `:1093-1098`。

限制：

- **没有验收标准**：`createFromPlanner` 接收 `acceptanceCriteria`，但没有写入 Work，也没有写入任何表；`works` 表没有验收标准列，队长 Prompt 也没有该字段（`team-collaboration-service.ts:143-166`，`migrations.ts:146-161`）；
- 没有 Task Memory / Checkpoint；
- 最近 30 条消息不按 Token 裁剪，长报告会原样进入 Prompt；
- 没有项目级约束、文件变更摘要、测试结果摘要；
- 没有对“已完成/未完成”的结构化验证。

#### Team Member

`memberPrompt` 包含：

1. 成员角色说明；
2. 任务名称、目标、描述；
3. 子任务标题和描述（或 general discussion）；
4. 最近 30 条线程消息；
5. 触发消息；
6. JSON 输出契约（`reply/blocked/question`）。

代码：`apps/core/src/services/team-collaboration-service.ts:887-906`。

限制：

- 没有 Task Memory；
- 没有项目级约束；
- 没有已修改文件、测试结果、阻塞清单；
- 无法跨 Session 恢复；
- 只能依赖最近 30 条消息和子任务描述。

#### Workflow / Plan

- AgentTask 的 Prompt 由 `ArtifactExchange.prompt` 生成：`taskPrompt` + 上游 artifact 内容 + 输出契约（`apps/core/src/workflow/artifact-exchange.ts:117-125`）。
- 上游 artifact 有校验和与 provenance 校验（`:127-157`），这是当前最接近“结构化任务记忆”的机制。
- 但它是节点级输入/输出，不是跨 Session 的任务记忆；NodeRun 的 `input_snapshot_json/output_snapshot_json` 保存的是节点快照，不是给模型恢复的上下文。

#### Execution System Prompt

`ExecutionService.composeSystemPrompt` 目前只注入：

- Agent 自己的 `systemPrompt`；
- 该 Agent 的 `skillIds` 对应技能指令；
- 该 Work 关联且 Agent 属于成员的团队 instructions。

代码：`apps/core/src/services/execution-service.ts:431-455`。

没有注入项目记忆、任务记忆、Checkpoint 或最近的已验证事实。

### 1.7 Provider Resume 能力现状

| Provider | `sessionPersistence` | `resume` | 适配器实际路径 |
|---|---|---|---|
| Claude Code | native | **unsupported** | CLI 支持 `--resume`，`args.ts:18-20` 已实现；但能力声明为 unsupported，Core 也不传 `resumeSessionId` |
| CodeBuddy | native | **unsupported** | 兼容 Claude stream-json，args 支持 `--resume`；能力声明 unsupported |
| Codex | unsupported | unsupported | 单回合 JSONL，无双向会话 |
| Gemini CLI | unsupported | unsupported | 单回合 JSONL |
| Grok CLI | unsupported | unsupported | 单回合 JSONL |
| Antigravity CLI | unsupported | unsupported | 单回合 JSONL |

代码：

- `packages/runtime-cli/src/claude-code/capabilities.ts:15-25`
- `packages/runtime-cli/src/codebuddy/capabilities.ts`
- `packages/runtime-cli/src/codex/capabilities.ts`
- `packages/runtime-cli/src/gemini/capabilities.ts`
- `packages/runtime-cli/src/grok/capabilities.ts`
- `packages/runtime-cli/src/antigravity/capabilities.ts`

SDK 已有 `StartExecutionConfig.resumeSessionId`（`packages/runtime-sdk/src/types.ts:46-60`），Claude args 也支持，但：

- `ExecutionStartParams` 没有 `resumeSessionId`（`packages/protocol/src/methods/execution.ts:13-22`）；
- Daemon `execution-manager.start` 没有透传 `resumeSessionId`（`apps/daemon/src/runtime/execution-manager.ts:165-175`）；
- Core 没有任何调用方传入 `resumeSessionId`（全仓搜索只有 SDK/args 定义）。

结论：**底层 CLI 具备 resume 能力，但 Agentra 当前没有可用的 Session Resume 链路；所有 Provider 的适配器能力口径都是 unsupported。**

---

## 2. 当前架构的问题

### 2.1 上下文连续性靠“最近消息”，不是任务记忆

Planner 40 条、团队 30 条，都是硬编码数量：

- 没有 Token 预算；
- 没有按重要性选择；
- 没有摘要；
- 没有项目/任务记忆；
- 没有来源与更新时间；
- 没有“已验证事实/模型推断/待确认”的区分。

长任务中，早期关键决策会被挤出窗口；团队长报告又可能占满窗口。

### 2.2 每次执行新建 Session，但没有 Checkpoint

当前不会出现单个 Session 无限增长，但每次切换都从最近消息重建：

- 任务阶段变化、返工、Agent 更换、异常退出都没有结构化交接；
- Session 结束后没有可恢复的任务状态；
- 模型只能看到最近 30/40 条，无法可靠知道已完成/未完成；
- 任务完成、失败、取消后没有可审计的交接点。

### 2.3 验收标准丢失

`createFromPlanner` 接收 `acceptanceCriteria`，但没有持久化：

- `works` 没有验收标准列；
- 队长/成员 Prompt 没有验收标准；
- 只有 `planner_messages.action_json` 和 UI 动作卡里能看到；
- 后续 Session 无法从数据库恢复验收标准。

这是当前任务上下文最具体的缺陷之一。

### 2.4 没有 Token/上下文窗口模型

- `ProviderModelInfo` 只有 `id/label`（`packages/runtime-sdk/src/types.ts:40-44`）；
- `agent_sessions` 没有 token 使用量、上下文窗口、turn 数；
- `execution_logs` 里 result frame 有 `usage.input_tokens/output_tokens`，但没有解析入库；
- 没有模型上下文窗口目录，无法做预算决策。

### 2.5 Session 生命周期不可观测

- Session 没有创建/复用/压缩/切换/恢复的审计事件；
- `agent_sessions.last_active_at` 只在创建/结束时写；
- 没有 `ended_reason`、`parent_session_id`、`resumed_from_session_id`；
- 没有 Session 列表/诊断 RPC（这符合“不提供用户手动控制”，但内部诊断仍需要）。

### 2.6 日志与数据增长

本地样本 `execution_logs` 约 128 MB，585k 行，没有 retention/prune：

- 原始日志是审计和恢复的宝贵证据；
- 但不能无限增长；
- 需要按 Session/Execution 保留策略，并区分“可重建摘要”和“原始审计日志”。

### 2.7 团队任务与工作流任务的能力不对等

- 工作流有 NodeRun snapshot、Artifact 版本、ReworkRequest、审批；
- 团队任务有消息、子任务、运行记录、工具步骤，但没有结构化 Rework、Checkpoint、验收标准、Artifact provenance；
- 团队任务的文件交付通过工作目录列举，不生成正式 Artifact（`WorkspaceFilesService`），因此无法用 checksum 验证交付物一致性。

### 2.8 恢复副作用不可判定

当前没有 side-effect ledger：

- Execution 终态只能说明进程结束，不能说明某个外部操作是否成功；
- 取消、崩溃、Session 失效后，无法区分“尚未执行 / 执行中 / 已成功 / 失败 / 结果未知”；
- 直接重试可能重复部署、重复发消息、重复写外部系统；
- 模型文本中的“已完成”不能作为副作用成功的证据。

这是 Checkpoint 恢复和未来 MCP/外部工具接入前必须补齐的安全边界。

---

## 3. Task / Execution / Session / Checkpoint 关系

### 3.1 目标关系图

```text
Project 1 ─── N Work(Task)
Project 1 ─── N PlannerThread          （每个项目独立的 Planner 聊天上下文）
PlannerThread 1 ─── N PlannerMessage   （旧 planner_messages 迁移到默认项目 Thread）
Work 1 ─── N Assignment
Assignment 1 ─── N AgentSession        （当前是 1:N；同一 Agent 的多次运行可复用 Session）
AgentSession 1 ─── N Execution         （目标允许；当前构造为 1:1）
Work 1 ─── N TaskCheckpoint            （不可变、追加式）
Work 1 ─── 1 TaskMemory                （当前快照，可版本化）
Work 1 ─── N TaskSideEffect            （副作用记录，Phase 1 建接口/表）
Project 1 ─── 1 ProjectMemory          （当前快照，可版本化）

TaskCheckpoint N ─── 1 Work
TaskCheckpoint N ─── 0..1 Execution    （来源执行）
TaskCheckpoint N ─── 0..1 AgentSession （来源会话）
TaskCheckpoint N ─── 0..1 TaskCheckpoint（parent，版本链）
TaskCheckpoint N ─── N TaskSideEffectRef（checkpoint JSON 内的副作用引用）

Execution N ─── 1 AgentSession
Execution N ─── 0..1 NodeRun           （工作流）
Execution N ─── 0..1 TeamTaskRun       （团队任务，通过 execution_id 关联）
```

### 3.2 明确结论

1. **Task 可以有多个 Session。** 当前每个 Execution 一个新 Session；目标架构中同一任务的不同阶段、不同 Agent、返工可以各有 Session。
2. **Session 可以跨多个 Execution，但当前没有实现。** Schema 允许；ExecutionService 目前每次新建 Session 并在终态结束。
3. **一个 Execution 只能对应一个 Session。** 一次模型进程只使用一个 Provider 会话。
4. **Session Resume 与 Checkpoint Resume 不同：**
   - Session Resume 复用 Provider 内部对话上下文（Claude `--resume`），不重建上下文；
   - Checkpoint Resume 新建 Session，用 Task Memory + Checkpoint + 产物重建上下文；
   - 前者是优化，后者是恢复的可靠基础；Phase 1 只做后者。
5. **Session ID 不能作为 Task ID。** 一个 Task 会有多个 Session；Provider Session ID 只属于某个 Agent/Provider。
6. **Checkpoint 是任务的不可变交接记录，不是聊天摘要。** 它必须引用任务、执行、会话、产物、测试证据和当时的验收标准版本。
7. **Task Memory 是当前工作快照；Checkpoint 是历史版本。** 当前快照可更新，历史 Checkpoint 不应原地修改。
8. **Planner Thread 属于 Project，不属于 Session。** 项目之间的 Planner 聊天、决策和记忆必须隔离；全局 UI 只是统一入口。
9. **Work 保存正式验收标准，Task Memory 保存快照。** 新 Execution 使用 Work 当前版本；历史 Checkpoint 保留当时版本。
10. **副作用是独立事实。** 没有 Checkpoint 不等于没有执行；恢复前必须查 side-effect 状态。

---

## 4. 四层记忆架构

建议把“记忆”拆成四层，而不是把所有内容都塞进聊天历史：

### 4.1 Agent 身份层（Agent Identity）

- 来源：`agent_profiles.system_prompt`、`skillIds`、`accessMode`、`toolPermissions`、`defaultProviderId`；
- 内容：角色、工作方式、权限、技能、团队 instructions（运行时注入）；
- 生命周期：随 Agent 配置变化；
- 共享：同一 Agent 的所有任务共享；
- 隔离：不包含项目/任务私有事实。

这一层已经存在，不需要新增表；需要的是在 ContextBuilder 中把它作为 P0 固定段。

### 4.2 Project Memory（项目记忆）

- 归属：Project；
- 内容：项目级目标、不可违反约束、架构决策、术语表、仓库路径、发布/安全规则、跨任务通用约定；
- 生命周期：项目级长期；版本化；
- 读取：Planner、Leader、Member 都可读（只读）；
- 写入：Core 在用户确认决策、计划批准、关键架构决策时写入；模型只能提议，不能直接写；
- 当前缺失：`projects` 只有名称/描述/状态，没有记忆。
- Planner Thread：每个项目一个独立 Planner 聊天上下文；`planner_messages` 通过 `planner_threads` 归属项目。全局 UI 只提供统一入口，Core 自动定位当前项目 Thread；项目之间的消息、决策和记忆不得混入同一 Prompt。

### 4.3 Task Memory（任务记忆）

- 归属：Work（Task）；
- 内容：目标、范围、验收标准快照、约束、已完成、进行中、决策、文件变更、测试结果、问题、阻塞、下一步、待确认事项；
- 验收标准双层：`works` 保存正式验收标准（业务事实，带版本/更新时间）；`task_memories` 保存引用该版本的快照；Checkpoint 保存当时使用的快照版本；
- 生命周期：任务创建时 seed，任务运行中更新，任务完成时冻结；
- 读取：Planner（摘要/决策）、Leader（完整任务视图）、Member（与自身子任务相关的切片）；
- 写入：Core 从结构化事件/产物/测试结果更新；模型输出只作为 `inferred`，不能直接标记 `verified`；
- 当前缺失：只有 Work 的静态字段、消息、子任务、运行记录；验收标准当前只存在于 Planner action_json。

### 4.4 Session / Checkpoint Memory（会话与检查点）

- Session：Provider 内部对话上下文，短生命周期；可复用则复用，不可复用则从 Checkpoint 新建；
- Checkpoint：任务在某个时间点的不可变结构化快照 + 证据引用；
- 生命周期：Checkpoint 追加式；Session 可结束、可恢复、可替换；
- 读取：ContextBuilder 读取最近有效 Checkpoint；审计读取全部；
- 写入：Core 自动创建；模型可提供摘要建议，但 Core 验证后保存；
- 副作用：Checkpoint 引用 `task_side_effects`，记录尚未执行/执行中/成功/失败/结果未知；恢复前必须查询，不得以“没有 Checkpoint”推断操作未发生。

### 4.5 为什么不用 Markdown 文件作为记忆源

- Markdown 适合作为人类可读导出/Artifact，不适合作为权威状态：缺少事务、外键、并发控制、结构化查询和审计；
- SQLite JSON 列可以用 Zod 校验、事务写入、按 Work/Project 查询，并且能随现有备份/恢复一起走；
- 原始 Session 日志仍保存在 `execution_logs`，用于审计和重放，不作为 Prompt 的默认输入。

---

## 5. Session Lifecycle 设计

### 5.1 设计原则

- Session 管理由 Core 的 `SessionLifecycleManager` 决策，模型不能修改 Session 关联；
- 不提供用户手动“继续/新建/选择 Session”的入口（CTO 强制产品原则）；
- 所有决策基于 Token 预算、任务阶段、Agent、返工、异常和 Checkpoint 有效性，不以消息条数作为唯一依据；
- Provider 能力差异通过能力矩阵处理，不假设所有 Provider 都支持 Resume；
- Session 失败/失效必须降级到 Checkpoint 新建 Session；没有有效 Checkpoint 时明确失败/等待，不假装恢复；
- Phase 1 的 Session 决策必须 Provider 无关：即使所有 Provider 都不支持 Resume，也必须能通过 Checkpoint 新建 Session 恢复任务。

### 5.2 决策表

| 场景 | 策略 |
|---|---|
| 同一任务、同一 Agent、同一阶段连续追问 | 优先复用当前 Session（Phase 2 且 Provider `resume` 可用、预算充足时）；Phase 1 以 Checkpoint 新建 Session 保证恢复 |
| 普通工具调用后继续工作 | 复用当前 Session |
| 上下文达到软阈值 70% | 自动评估压缩：优先压缩低价值历史消息，保留任务目标、验收标准、权限约束和关键决策；更新 Task Memory/Checkpoint |
| 上下文达到硬阈值 85% | 禁止继续无控制追加上下文；自动压缩或结束当前 Session，基于最新有效 Checkpoint 新建 Session |
| 任务进入新阶段 | 计算阶段相关性；上下文相关性低或预算高时新建 Session，否则复用 |
| 大范围返工 | 倾向新建 Session；从返工前 Checkpoint + 返工请求重建 |
| Agent 更换 | 新 Agent 新建 Session；只共享 Task/Project Memory，不共享旧 Agent 的私有 Session |
| Session 失效/Provider 不支持 Resume | 基于最新有效 Checkpoint 新建 Session |
| 任务完成/最终交付 | 创建最终 Checkpoint，结束 Session；后续重新打开任务时从最终 Checkpoint 新建 Session |
| 执行异常退出/取消 | 创建异常/取消 Checkpoint；下次运行从 Checkpoint 恢复，不重复副作用 |

### 5.3 预算与阈值

- 模型上下文窗口来源优先级：
  1. Provider 能力配置；
  2. 具体模型的上下文窗口配置；
  3. 配置必须记录来源、更新时间和适用范围；
  4. 无法准确获取时使用保守估算，并记录估算方式和置信度；
  5. 业务代码不得随意硬编码某个模型的上下文窗口。
- 软阈值固定为上下文窗口的 **70%**；硬阈值固定为 **85%**；第一版默认值允许通过 Core 配置调整，但不暴露为普通用户 Session 管理功能；
- 预留输出预算（建议 20%–25%）；P0（权限、约束、验收标准、最新有效 Checkpoint）不得被裁剪；
- 每次执行终态解析 CLI result frame 的 `usage.input_tokens/output_tokens/cache_*`，写入 Session 指标；
- 用实际 usage 校准下一轮估算；没有 usage 时用保守字符估算，并明确标记“估算”；
- P0 超出硬预算时，**失败并暴露明确错误**，不允许静默裁剪。

### 5.4 Session 复用与 Resume 集成

当前 Provider 能力：

- Claude Code / CodeBuddy 的 CLI 有 `--resume` 能力，但适配器声明 `resume: unsupported`；
- Codex / Gemini / Grok / Antigravity 是单回合，不能 Session Resume；
- Phase 1 不依赖 Claude Code `--resume`，必须完成 **Provider 无关的 Checkpoint 重建**；Phase 2 再为 Claude Code、CodeBuddy 接入 Resume；
- 不支持 Resume 的 Provider 始终使用 Checkpoint 重建；Resume 失败自动降级为 Checkpoint 恢复。

集成点建议（Phase 2）：

1. `ExecutionStartOptions` 增加内部 `resumeSessionId?: string`（不暴露给普通 RPC）；
2. `ExecutionStartParams`/Daemon 启动参数增加内部 `resumeSessionId` 透传；
3. `ExecutionService` 支持“复用已有 Agentra Session”或“新建 Session 但使用已有 Provider Session ID”；
4. Provider 能力声明只有在适配器真正实现并测试后才改为 `native`；
5. 如果 Provider 不支持 Resume，SessionLifecycleManager 直接选择 Checkpoint 新建 Session；
6. Resume 失败时：记录失败原因，降级为 Checkpoint 新建 Session；如果 Checkpoint 也不可用，任务进入明确的 `blocked`/`recovery_required`，不自动假装继续。

### 5.5 与当前 ExecutionService 的边界

- `ExecutionService` 继续负责：执行门禁、并发队列、进程、日志、终态观察、Session/Execution 持久化；
- Phase 1C 引入 `SessionLifecycleManager` 的基础接口，只负责：选择 Session、决定新建/复用/压缩/结束、调用 ContextBuilder、写审计；Phase 2 完善；
- 不引入第二套执行引擎或调度器；工作流调度仍由 `WorkflowScheduler`/`FairDispatcher` 负责；
- 团队任务仍由 `TeamCollaborationService` 的队列和状态机负责；Lifecycle Manager 不接管任务状态。

---

## 6. Context Builder 设计

### 6.1 输入

```text
build({
  agent: AgentProfile,
  work: WorkRecord | null,
  project: ProjectRecord | null,
  plannerThread: PlannerThread | null,   // Planner 项目级 Thread
  execution: ExecutionIntent,            // 本次触发
  session: AgentSession | null,
  taskMemory: TaskMemory | null,
  checkpoint: TaskCheckpoint | null,
  acceptanceCriteria: { version: number; items: MemoryItem[] }, // 来自 Work 当前版本
  recentMessages: MessageSlice,
  artifacts: ArtifactRef[],
  files: WorkspaceFileRef[],
  sideEffects: SideEffectRef[],
  tokenBudget: TokenBudget
})
```

### 6.2 分段与优先级

| 优先级 | 内容 | 裁剪策略 |
|---|---|---|
| P0 | Agent system prompt、权限/工具边界、项目硬约束、任务目标与当前验收标准（Work 版本）、最新有效 Checkpoint 的约束/已完成/阻塞、副作用状态 | 永不裁剪；超出预算则失败并明确报错 |
| P1 | Task Memory 的决策/已完成/进行中/测试结果/文件变更/未解决项 | 可压缩为摘要；保留来源引用 |
| P2 | 最近必要聊天消息（Planner 仅当前项目 Thread；团队仅当前 Work；按相关性/时间窗口） | 按 Token 预算裁剪；不默认加载全部历史 |
| P3 | 相关文件/Artifact 内容 | 按引用/相关性加载；大文件只放摘要/路径/校验和 |

### 6.3 预算

- 先估算 P0，再分配 P1/P2/P3；
- 软阈值 70% 触发压缩评估；硬阈值 85% 触发压缩或新建 Session；
- 每个分段生成 manifest：section、来源、token 估算、是否裁剪、hash、置信度；
- manifest 写入 execution 的 system log 或审计，便于排查“为什么模型没看到某条约束”；
- 对长任务，优先加载 Task Memory/Checkpoint，而不是重放完整聊天；
- 对成员，只加载其子任务相关切片 + 项目约束，不加载其他成员完整历史；
- 对 Planner，只加载当前项目 Thread + 项目记忆 + 计划/任务摘要，不加载其他项目历史。

### 6.4 上下文来源

- Task Memory/Checkpoint 中的事实必须带 `source`（消息/执行/Artifact/测试/用户决策）和 `updatedAt`；
- `verified` 事实必须有可验证证据（文件 hash、Artifact checksum、测试报告、结构化工具输出）；
- `inferred` 和 `pending` 明确标注，不进入 P0 的“不可违反”区域；
- 摘要不能替代约束原文；验收标准、硬约束保留原文；
- 验收标准必须带 Work 版本号；新 Execution 使用 Work 当前版本，历史 Checkpoint 使用当时快照版本。

---

## 7. 数据库设计建议

> 以下为设计建议，本次不实施迁移。所有新表应通过现有 `MIGRATIONS` 数组新增版本（建议 v31+），不得改写历史迁移。

### 7.1 `agent_sessions` 扩展

建议新增列（保留现有 `id/assignment_id/provider_id/external_session_id/context_ref/status`）：

```sql
ALTER TABLE agent_sessions ADD COLUMN agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN work_id TEXT REFERENCES works(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution';
ALTER TABLE agent_sessions ADD COLUMN context_window INTEGER;
ALTER TABLE agent_sessions ADD COLUMN context_tokens_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN last_checkpoint_id TEXT REFERENCES task_checkpoints(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN ended_reason TEXT;
ALTER TABLE agent_sessions ADD COLUMN resumed_from_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
```

- `agent_id` 从 `context_ref` 回填（当前 `context_ref` 就是 agentId）；
- `work_id` 对已绑定 assignment 的 Session 可从 `assignments.work_id` 回填；系统 Session 允许为空；
- `external_session_id` 建议加 `(provider_id, external_session_id)` 非空唯一索引，避免重复 resume 目标；
- `purpose` 取值：`planner_chat`、`team_leader`、`team_member`、`workflow_node`、`scratch`、`assistant`。

不建议把 `work_id` 作为 Session 的唯一任务归属；Session 是 Agent 的运行容器，任务归属仍由 Assignment/TeamRun/NodeRun 决定。`work_id` 只是便于查询和预算统计的冗余索引。

### 7.2 `task_memories`

```sql
CREATE TABLE task_memories (
  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  memory_json TEXT NOT NULL,
  acceptance_criteria_snapshot_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_work_version INTEGER NOT NULL DEFAULT 1,
  acceptance_criteria_work_updated_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  source_checkpoint_id TEXT REFERENCES task_checkpoints(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`memory_json` 用 Zod 校验，建议结构：

```ts
type TaskMemory = {
  schemaVersion: 1
  taskId: string
  objective: string
  scope: string
  acceptanceCriteria: {
    workVersion: number
    workUpdatedAt: string
    items: MemoryItem[]
  }
  constraints: MemoryItem[]
  completed: MemoryItem[]
  inProgress: MemoryItem[]
  decisions: MemoryItem[]
  files: FileChange[]
  tests: TestResult[]
  issues: MemoryItem[]
  blockers: MemoryItem[]
  nextActions: MemoryItem[]
  openQuestions: MemoryItem[]
  updatedAt: string
}

type MemoryItem = {
  id: string
  statement: string
  verification: 'verified' | 'inferred' | 'pending'
  source: { type: 'message' | 'execution' | 'artifact' | 'test' | 'user' | 'checkpoint'; id: string }
  sessionId?: string
  executionId?: string
  updatedAt: string
}
```

- 当前快照一行；历史版本由 Checkpoint 保存，不需要单独的 `task_memory_versions` 表；
- `summary` 只用于 UI/低优先级上下文，不作为权威事实；
- 任务创建时从 Work 当前验收标准 seed；Task Memory 保存 `workVersion/workUpdatedAt`，Work 验收标准变化时必须刷新快照并记录审计；
- 新 Execution 使用 Work 当前版本；历史 Checkpoint 保留当时快照版本，不回写。

### 7.3 `task_checkpoints`

```sql
CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL, -- stage_complete / session_switch / compression /
                       -- execution_failed / user_cancelled / rework / final_delivery
  execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  parent_checkpoint_id TEXT REFERENCES task_checkpoints(id) ON DELETE SET NULL,
  acceptance_criteria_work_version INTEGER NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  evidence_status TEXT NOT NULL CHECK (
    evidence_status IN ('verified', 'partial', 'invalid', 'missing', 'not_required')
  ),
  side_effect_completeness TEXT NOT NULL CHECK (
    side_effect_completeness IN ('complete', 'partial', 'not_tracked')
  ),
  checkpoint_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, seq)
);
CREATE INDEX idx_task_checkpoints_work_created ON task_checkpoints(work_id, created_at);
```

- 追加式、不可变；不提供 UPDATE/DELETE（可用触发器保护，类似 `artifact_versions`）；
- `checkpoint_json` 包含 Task Memory 快照 + 当前阶段 + 已完成/进行中/阻塞/下一步 + Session/Execution 引用；
- `evidence_json` 存文件 hash、Artifact refs、测试报告引用、工具证据；
- `content_hash` 用于校验 Checkpoint 未被篡改/重复；
- `parent_checkpoint_id` 形成版本链；
- 失败/取消/返工都创建 Checkpoint；最终交付创建 `final_delivery`；
- `risk_level` 由 Core 根据操作类型、权限和副作用风险计算，不由模型自行判断；
- Checkpoint JSON 记录当时的 `acceptanceCriteria.workVersion` 与 `sideEffects` 状态，恢复时不得使用当前 Work 版本覆盖历史。

Checkpoint JSON 建议：

```ts
type TaskCheckpoint = {
  schemaVersion: 1
  taskId: string
  seq: number
  kind: string
  stage: string
  status: 'in_progress' | 'blocked' | 'review' | 'done' | 'failed' | 'cancelled'
  goal: string
  acceptanceCriteria: {
    workVersion: number
    workUpdatedAt: string
    items: MemoryItem[]
  }
  constraints: MemoryItem[]
  completed: MemoryItem[]
  inProgress: MemoryItem[]
  decisions: MemoryItem[]
  files: FileChange[]
  tests: TestResult[]
  issues: MemoryItem[]
  blockers: MemoryItem[]
  nextActions: MemoryItem[]
  sideEffects: {
    completeness: 'complete' | 'partial' | 'not_tracked'
    refs: SideEffectRef[]
  }
  evidenceStatus: 'verified' | 'partial' | 'invalid' | 'missing' | 'not_required'
  evidence: {
    files: FileEvidence[]
    artifacts: ArtifactEvidence[]
    tests: TestEvidence[]
  }
  session: { agentraSessionId: string | null; providerSessionId: string | null; executionId: string | null }
  memoryVersion: number
  generatedBy: 'core'
  createdAt: string
}
```

证据类型（Phase 1B 契约，不新增独立文件表）：

```ts
type FileEvidence = {
  worktreeId: string | null          // 工作流 worktree；团队任务为 null
  relativePath: string               // 相对 Work root/worktree，禁止绝对路径作为跨机恢复键
  status: 'created' | 'modified' | 'deleted'
  size: number | null
  sha256: string | null
  verifiedAt: string
  verification: 'verified' | 'missing' | 'mismatch' | 'skipped'
}

type ArtifactEvidence = {
  artifactId: string
  version: number
  checksum: string
  workId: string
  executionId: string | null
  verification: 'verified' | 'missing' | 'mismatch' | 'not_required'
}

type TestEvidence = {
  kind: string
  result: 'passed' | 'failed' | 'skipped'
  at: string
  codeVersion: { worktreeId: string | null; gitCommit: string | null; fileHashes: Record<string, string> }
  reportArtifact: { artifactId: string; version: number; checksum: string } | null
  verification: 'verified' | 'stale' | 'missing'
}
```

- 不重复存储 Artifact 内容；只存 `artifactId/version/checksum`；
- 文件内容只在需要时读取并计算 SHA-256；团队任务没有 worktree 时以 Work root 为边界；
- 路径必须 realpath 校验在 Work root/worktree 内，跳过符号链接逃逸；
- 测试证据必须绑定 `codeVersion`；旧代码版本的测试通过不能证明新版本通过。

### 7.4 `project_memories`

```sql
CREATE TABLE project_memories (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  memory_json TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
```

内容：项目级约束、架构决策、术语、仓库/发布规则、跨任务约定、来源。Planner 长期记忆与项目记忆分离：Planner 的对话历史在 `planner_messages`，项目事实在 `project_memories`；ContextBuilder 同时读取两者，但来源和写入规则不同。

### 7.5 `planner_threads` 与旧消息迁移

CTO 决策采用**项目级 Planner Thread**。当前 `planner_messages` 没有 `project_id`，是全局聊天；不能直接删除旧记录。

```sql
CREATE TABLE planner_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id)
);

ALTER TABLE planner_messages ADD COLUMN thread_id TEXT REFERENCES planner_threads(id) ON DELETE CASCADE;
CREATE INDEX idx_planner_messages_thread ON planner_messages(thread_id, created_at);
```

迁移策略：

1. 为 `prj-default` 创建默认 Thread；
2. 现有全部 `planner_messages.thread_id` 回填默认 Thread，保证旧聊天完整保留；
3. 有明确 `related_work_id` 且能唯一映射到其他项目的旧消息，可选择迁移到对应项目 Thread；无法唯一判断时保留在默认 Thread，不猜测；
4. 新项目首次进入 Planner 时，Core 自动创建该项目 Thread；
5. `planner.chat.get/send` 增加可选 `projectId`；UI 传入当前项目，Core 自动定位/创建 Thread，不要求用户选择 Session；
6. ContextBuilder 只加载当前项目 Thread + 项目记忆 + 相关任务摘要，不加载其他项目 Thread；
7. 旧消息不做物理删除；需要归档时只做逻辑归档/索引，不清理；
8. `task_memories/task_checkpoints/task_side_effects` 以 `work_id` 关联，不依赖 `thread_id`；Phase 3 迁移不得重写这些表，迁移前后做 hash/内容对比。

全局 Planner 入口仍可以保留一个统一页面，但页面内容按当前项目自动切换 Thread。项目级 Thread 的 `UNIQUE(project_id)` 是第一版简化；如果未来需要自动轮换 Thread，再增加 `status/archived_at`，不改变“用户不手动选 Session”的原则。

### 7.6 任务验收标准双层保存

当前 `works` 没有验收标准列，`createFromPlanner` 的 `acceptanceCriteria` 被丢弃。CTO 决策是 Work + Task Memory 双层：

```sql
ALTER TABLE works ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE works ADD COLUMN acceptance_criteria_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE works ADD COLUMN acceptance_criteria_updated_at TEXT;
```

- `works.acceptance_criteria_json` 是正式业务事实来源，`acceptance_criteria_version` 在每次验收标准变化时递增，并写 `audit_logs`（from/to/version/source）；
- `task_memories.acceptance_criteria_snapshot_json` 保存快照，并记录 `acceptance_criteria_work_version/work_updated_at`；
- 新 Execution 使用 Work 当前版本；如果 Task Memory 快照版本落后，Core 刷新快照、写审计，并在需要时创建 Checkpoint；
- 历史 Checkpoint 保留当时 `workVersion`，不因 Work 后续修改而改变；
- 旧任务从 `planner_messages.action_json` 的 `create_team_task.acceptanceCriteria` 回填；没有来源的旧任务标记为 `pending`/空，不伪造；
- 不重复增加与 `objective/description` 语义相同的字段；验收标准单独成列，因为它有独立版本和变更语义。

### 7.7 `task_side_effects`（Phase 1 基础设计）

Phase 1 不要求完整幂等恢复，但必须把副作用记录的表、接口和安全边界定下来，避免后续无法扩展。

```sql
CREATE TABLE task_side_effects (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  tool_call_key TEXT,
  effect_key TEXT NOT NULL,
  kind TEXT NOT NULL, -- deploy / publish / message / external_write / irreversible_command / other
  status TEXT NOT NULL CHECK (
    status IN ('not_started', 'in_progress', 'succeeded', 'failed', 'unknown')
  ),
  idempotency_key TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  last_observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, effect_key)
);
CREATE UNIQUE INDEX idx_task_side_effects_idempotency
  ON task_side_effects(work_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_task_side_effects_work_status ON task_side_effects(work_id, status);
```

状态机：

```ts
type SideEffectRef = {
  effectKey: string
  kind: string
  status: 'not_started' | 'in_progress' | 'succeeded' | 'failed' | 'unknown'
  completeness: 'complete' | 'partial' | 'not_tracked'
  executionId: string | null
  sessionId: string | null
  toolCallKey: string | null
  idempotencyKey: string | null
  evidenceRef: string | null
}
```

```text
not_started → in_progress → succeeded
                         ↘ failed
                         ↘ unknown → (核实) succeeded | failed
```

- `succeeded` 是终态，不得重复执行；
- `failed` 只有在明确失败且风险允许时才能用新的 attempt/idempotency key 重试；
- `unknown` 必须先核实外部结果，不得自动重试；
- 外部操作已成功但本地尚未写入 `succeeded` 时，崩溃后只能标记 `unknown`，不能猜成成功或未开始；
- `tool_call_key` 关联 `execution_logs` 的 structured tool_use id / `team_task_run_steps.step_key`；`execution_id/session_id` 关联来源执行；
- 状态转换写 `audit_logs`；`evidence_json` 存工具回执/外部确认；
- 没有记录时是 `not_tracked`（记录不完整），不是 `not_started`；Checkpoint 必须明确标记完整性。

接口边界（建议）：

```ts
interface SideEffectLedger {
  declare(input: { workId; effectKey; kind; idempotencyKey?; executionId?; sessionId?; toolCallKey? }): SideEffect
  begin(effectId: string): void
  succeed(effectId: string, evidence: Record<string, unknown>): void
  fail(effectId: string, error: string): void
  markUnknown(effectId: string): void
  listByWork(workId: string): SideEffect[]
}
```

安全规则：

- 没有 Checkpoint 不等于操作没有发生；恢复前必须查 ledger；
- `succeeded` 不重复执行；`in_progress`/`unknown` 不得盲目重试；
- 模型不能自行认定副作用成功；成功必须有 Core 可验证的证据或明确的工具回执；
- Phase 1B 先定义 `SideEffectRef`/完整性契约；Phase 1D 实现表与查询；Phase 4 完善幂等/对账。

### 7.8 `model_context_windows`（Token 预算来源）

```sql
CREATE TABLE model_context_windows (
  provider_id TEXT NOT NULL REFERENCES runtime_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  source TEXT NOT NULL, -- provider_capability / model_catalog / manual_config / fallback
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
```

- 优先级：Provider 能力配置 > 具体模型配置 > 保守估算；
- 每条记录必须有 source、updated_at、适用 provider/model；
- 没有记录时使用保守估算并记录 confidence=low；不得在业务代码硬编码某个模型窗口；
- 软/硬阈值（70%/85%）作为 Core 配置，可按环境调整，不暴露为用户 Session 管理功能。

### 7.9 迁移、索引、删除策略

- 新增迁移版本建议按依赖顺序：
  - v31 `task_checkpoints`（先建，供后续表/列引用）；
  - v32 `task_memories`；
  - v33 `agent_sessions` 扩展（`last_checkpoint_id` 依赖 v31）；
  - v34 `works.acceptance_criteria_json/version` + `task_side_effects`；
  - v35 `planner_threads` + `planner_messages.thread_id` + `project_memories`；
  - v36 `model_context_windows`（可在 Phase 1C/2 前加入）。
- 任何引用 `task_checkpoints` 的表/列必须在它之后创建；
- 旧 Session 回填 `agent_id=context_ref`；`work_id` 从 assignments 回填，无法回填的保持 NULL；
- 旧 Planner 消息全部回填默认项目 Thread，不删除；有唯一项目归属的旧消息可迁移，无法判断则保留默认；
- 旧任务不伪造 Task Memory；首次运行时由 Core 从 Work/消息/子任务生成 `inferred/pending` 记忆，并标记来源；
- 旧 Work 验收标准从 `planner_messages.action_json` 回填；无来源的保持空并标记 `pending`；
- `task_memories`、`task_checkpoints`、`task_side_effects` 随 Work 删除；`execution_id/session_id` 使用 `ON DELETE SET NULL` 保留历史引用；
- 备份/恢复：现有备份是整库备份，新表自动包含；需要补充 restore 后的 Session/Checkpoint/SideEffect 一致性检查，避免恢复后重复执行外部副作用；
- 日志保留：`execution_logs` 按 Session/Execution 保留策略清理，Checkpoint/Task Memory 长期保留；原始 Session 日志用于审计，不默认进入 Prompt；不得在 Phase 1 直接清理已有日志。

---

## 8. Planner、Team Leader、Member 的差异化策略

### 8.1 Planner

| 项目 | 策略 |
|---|---|
| 连续性 | 保留当前项目内与老板的沟通连续性；加载当前项目 Planner Thread + 项目记忆 + 计划/任务摘要 |
| 长期记忆 | 项目决策、计划版本、关键约束写入 Project Memory；Planner 对话历史与项目记忆分离 |
| Session | Phase 1 每轮新 Session；Phase 2 可在同一项目、同一话题、预算充足时复用 Session |
| 隔离 | 只读取当前项目 Thread；不读取其他项目聊天、决策和记忆；不加载所有任务完整聊天 |
| 写入 | 模型只能提议计划/团队/任务；Core 校验后写入；不能直接改 Session/Memory/Thread |

当前 Planner Prompt 是全局的，`planner_messages` 没有 `project_id`；Phase 3 完成 `planner_threads` 迁移后，项目隔离才生效。Phase 1A/1B 可以先用现有全局 Planner 聊天，但 Task Memory 以 `work_id` 为主键，不依赖 Thread；`project_id` 从 Work 读取；旧全局消息只作为上下文来源，不进入任务事实。项目级 Thread 是已确认目标，不是可选方向。

### 8.2 Team Leader

| 项目 | 策略 |
|---|---|
| 任务视图 | 完整 Task Memory + 验收标准 + 团队 instructions + 成员/子任务/运行状态 |
| 团队状态 | 从 `team_task_subtasks/team_task_runs/team_task_messages` 派生，不另建一套状态 |
| Session | 与 Planner 不共享模型 Session；同一任务/阶段可复用，返工/换人新建 |
| 隔离 | 只读取当前 Work 的团队线程；不读取无关任务完整历史；项目记忆只读 |
| 记忆 | 不需要独立 `team_memories` 起步；Task Memory 已包含团队协调所需状态；若未来出现跨任务团队模式，再评估 team-level memory |

### 8.3 Team Member

| 项目 | 策略 |
|---|---|
| 任务视图 | 自己的子任务 + 相关验收标准/约束 + 相关文件/Artifact + 最近必要线程片段 |
| 记忆 | 读取 Task Memory 的相关切片；不默认读取全部团队消息、其他成员完整历史 |
| Session | 同一子任务/阶段可复用；返工/换人/上下文超限新建 |
| 隔离 | 不能读取其他任务或项目私有记忆；项目记忆只读；敏感信息按权限过滤 |
| 写入 | 输出 `reply/blocked/question`；Core 将声明标记为 inferred/pending，证据由工具/测试/Artifact 验证 |

### 8.4 记忆归属与权限

| 记忆 | 归属 | 可读 | 可写 |
|---|---|---|---|
| Agent Identity | Agent | 该 Agent 的所有运行 | Core/用户配置 |
| Project Memory | Project | Planner、Leader、Member（只读） | Core（用户确认/关键决策） |
| Planner Thread | Project | 当前项目的 Planner | Core |
| Task Memory | Work | 该任务 Planner 摘要、Leader 完整、Member 切片 | Core |
| Checkpoint | Work | 该任务相关 Agent/审计 | Core |
| SideEffect | Work | 该任务相关 Agent/审计 | Core |
| Session | Agent × Task/阶段 | 该 Session 的运行 | Core |
| 原始日志 | Execution | 审计/诊断 | Core（只追加） |

权限控制由 Core 在 ContextBuilder 查询时执行，模型不能通过 Prompt 或工具越权读取其他任务。

### 8.5 Planner Thread 与 Phase 1 的依赖结论

1. **Phase 1A 可以在 Planner Thread 迁移前启动。** Task Memory 以 `work_id` 为主键，`project_id` 从 Work 读取，不依赖 `planner_threads`。
2. **Task Memory 不需要 Planner Thread ID。** Planner 消息只是上下文来源，不是任务事实的唯一来源。
3. **旧全局 Planner 消息不能作为任务事实。** Phase 1B 的 ContextBuilder 只读取当前 Work 明确关联的 Planner 消息；无法确认归属的旧消息只保留，不进入 Task Memory/Checkpoint 的事实区。
4. **Planner 创建 Work 时必须保存 Project ID 和验收标准。** 当前 `create_team_task` action schema 没有 `projectId`（`planner-chat-service.ts:27-34`）；Phase 1A 增加可选 `projectId`，Core 校验项目存在，写入 `works.project_id`，同时写 Work 验收标准与 Task Memory 快照。缺少 projectId 时使用默认项目并标记来源，不猜测其他项目。
5. **Phase 3 迁移只更新 Planner 消息归属。** `task_memories`、`task_checkpoints`、`task_side_effects` 以 work_id 关联，不因 `planner_threads` 迁移而重写；迁移前后应做 hash/内容对比测试。
6. **Phase 1A 的项目隔离来自 Work.project_id，不来自 Planner Thread。** 即使 Planner 仍是全局聊天，Task Memory 也不能跨 Work/Project 混用。

---

## 9. 异常恢复与降级

### 9.1 Checkpoint 创建时机

- 执行成功终态（尤其是子任务完成/阶段完成）；
- 执行失败/崩溃；
- 用户取消；
- 返工开始/完成；
- Session 即将切换或压缩；
- 最终交付。

### 9.2 创建失败：按任务风险分级

Core 根据任务操作类型、Agent 权限、工具 allow/deny、是否涉及不可逆操作、是否已有副作用记录等计算风险等级；**不能只依赖模型自行判断**。

**高风险任务（例如部署、发布、外部写入、不可逆命令、生产数据操作）：**

- Checkpoint 创建失败时阻止进入下一阶段；
- 禁止继续执行不可逆操作；
- 进入明确的阻塞/恢复待处理状态；
- 保留上一个有效 Checkpoint；
- 记录失败原因和审计，不得假装 Checkpoint 创建成功。

**普通任务（例如只读分析、低风险本地文件修改）：**

- 允许在安全边界内保留当前 Execution；
- 必须记录 Checkpoint 创建失败；
- 标记当前任务恢复能力不足；
- 不允许在缺少必要恢复信息时自动开启新 Session；
- 不允许继续执行可能导致数据损坏或重复副作用的操作。

无论风险等级，**任何任务都不能把失败伪装成成功**；UI 只展示业务状态和明确异常，不暴露 Session 控制。

### 9.3 Session Resume 失败

- 记录失败原因（Provider 不支持、Session 过期、进程不兼容、CLI 参数错误）；
- 自动降级：用最新有效 Checkpoint 新建 Session；
- 如果没有有效 Checkpoint：任务进入 `blocked`/`recovery_required`，等待 Core/用户处理；不重复执行已成功的副作用。

### 9.4 副作用安全

Phase 1 建立基础记录与接口边界，Phase 4 完善完整幂等恢复：

- 状态区分：`not_started` / `in_progress` / `succeeded` / `failed` / `unknown`；
- Checkpoint 记录 `sideEffects` 引用；
- 恢复时先查 `task_side_effects`；`succeeded` 不重复执行，`in_progress`/`unknown` 不盲目重试；
- 不可逆操作必须有明确执行记录和审计证据；
- 需要幂等键的操作由 Core 管理；
- 模型不能自行认定副作用成功；
- 没有 Checkpoint 不等于操作没有发生，必须查 ledger。

### 9.5 任务完成与重新打开

- 任务完成时创建 `final_delivery` Checkpoint 并结束 Session；
- 如果任务重新打开（当前系统允许在 completed Work 上继续团队运行），Lifecycle Manager 新建 Session，从最终 Checkpoint 恢复，不复用已结束 Session；
- 不改变 Work/Assignment 的业务归属。

### 9.6 Checkpoint 与文件/Artifact 一致性

Checkpoint 记录历史证据，当前工作区是当前状态；两者不能混用。

校验状态：

| 状态 | 含义 | 恢复策略 |
|---|---|---|
| `verified` | 所有必需文件/Artifact/测试证据通过校验 | 允许正常恢复 |
| `partial` | 仅非关键参考资料缺失或无法确认 | 按风险等级决定是否受限恢复；高风险任务仍需人工/阻塞 |
| `invalid` | 文件 hash、Artifact checksum 或测试代码版本不一致 | 禁止直接恢复；报告差异，要求重新验证/重建 |
| `missing` | 必需文件/Artifact 不存在 | 恢复阻塞，不得自动创建/覆盖文件 |
| `not_required` | 任务不依赖文件/Artifact 证据 | 可正常恢复 |

校验规则：

1. 必需文件不存在 → 不能 `verified`；
2. 必需文件 SHA-256 不一致 → 不能 `verified`；
3. 必需 Artifact 不存在 → 不能 `verified`；
4. Artifact 版本/checksum 不一致 → 不能 `verified`；
5. 测试报告绑定的代码版本与当前 Checkpoint 代码版本不一致 → `stale`，不能作为当前版本通过证据；
6. 非关键参考资料缺失 → 可 `partial`，但高风险任务仍不得继续不可逆操作；
7. 校验结果写入 Checkpoint `evidence_json`；
8. 校验失败不能通过修改状态字段伪装成功；
9. 恢复时先报告差异并保留现场，禁止自动覆盖/回滚/删除用户文件；
10. 路径必须 realpath 限制在 Work root/worktree 内，拒绝符号链接逃逸。

Phase 1B 只实现规则、证据结构和校验；Phase 1D/4 再补完整恢复对账。

---

## 10. 测试验收矩阵

| # | 阶段 | 场景 | 初始状态 | 操作 | 预期结果 | 验证方式 |
|---|---|---|---|---|---|---|
| 1 | 1A | Task Memory 与 Work 验收标准一致 | Work 有验收标准版本 v1，Task Memory 已 seed | 读取 Task Memory 并运行新 Execution | 快照 `workVersion=v1`，Prompt 使用同一版本；不一致时 Core 刷新并审计 | DB 断言 + Context Manifest |
| 2 | 1A | 验收标准修改后的版本隔离 | 已有 v1 Checkpoint | 修改 Work 验收标准为 v2，再新建 Execution | 新 Execution 用 v2；旧 Checkpoint 仍保存 v1；不覆盖历史 | Work/TaskMemory/Checkpoint 三方断言 |
| 3 | 1B | 新 Session 从 Checkpoint 恢复 | 任务中断，存在有效 Checkpoint | 新建 Session 继续任务 | 新 Session 获得 Task Memory、已完成/未完成、下一步、验收标准；不重放全部聊天 | Checkpoint JSON + Prompt manifest |
| 4 | 1C | 70% 软阈值触发压缩评估 | Session token 使用达到窗口 70% | 继续运行 | 自动评估压缩，优先压缩低价值历史；P0 不裁剪；产生审计 | Session 指标 + Context Manifest |
| 5 | 1C | 85% 硬阈值触发压缩或新 Session | Session token 使用达到 85% | 继续运行 | 禁止无控制追加；压缩或新建 Session；新 Session 从 Checkpoint 恢复 | Session 切换记录 + Checkpoint |
| 6 | 1C | Token 使用量不可准确获取 | Provider 无 usage 或结果缺失 | 触发预算评估 | 使用保守估算，记录估算方式与 confidence=low；不误判为精确值 | Context Manifest/审计 |
| 7 | 1D | Checkpoint 失败：高风险任务 | 任务涉及部署/外部写入，写 Checkpoint 失败 | 执行终态/进入下一阶段 | 阻止下一阶段；禁止不可逆操作；保留上一 Checkpoint；任务阻塞并提示 | DB/审计/UI 状态 |
| 8 | 1D | Checkpoint 失败：普通任务 | 低风险只读/本地任务，写 Checkpoint 失败 | 执行终态 | 允许安全边界内保留 Execution；记录失败和恢复能力不足；不自动新建 Session | 审计 + 任务恢复标记 |
| 9 | 1C/2 | Provider 不支持 Resume | 使用 Codex/Gemini/Grok/Antigravity | 跨 Session 继续 | 不尝试 resume；自动 Checkpoint 新建 Session | 执行参数 + Session 记录 |
| 10 | 2 | Resume 失败自动降级 | Claude/CodeBuddy 声明支持但 resume 报错 | 继续任务 | 记录失败；自动用最新 Checkpoint 新建 Session；无 Checkpoint 则阻塞 | 执行日志/审计 |
| 11 | 1D | 执行结果未知时不得重复副作用 | side effect 状态 unknown | 恢复任务 | 不盲目重试；要求核对或阻塞；记录审计 | `task_side_effects` + 执行记录 |
| 12 | 1D | 已成功副作用恢复时不得重复执行 | side effect 状态 succeeded | 从 Checkpoint 恢复 | 跳过该副作用；使用已有证据；不重复调用 | ledger + 工具调用计数 |
| 13 | 3 | Planner 不同项目记忆隔离 | 两个项目各有 Thread/记忆 | 在项目 A 发消息 | 只加载项目 A Thread/Project Memory；项目 B 内容不进入 Prompt | Prompt manifest + DB 查询 |
| 14 | 3 | Team Leader 与成员记忆隔离 | 同一任务多成员 | 成员运行 | 成员只读自己子任务切片；Leader 读完整任务；不读取其他成员私有历史 | Prompt manifest + 权限测试 |
| 15 | 2/3 | Agent 更换后的上下文恢复 | 任务运行中改派 Agent | 新 Agent 接手 | 新 Session 从 Task Memory/Checkpoint 恢复；不共享旧 Agent Session | Assignment + Session + Checkpoint |
| 16 | 3 | 旧 Planner 消息迁移和兼容 | v30 全局 `planner_messages` | 启动迁移 | 旧消息保留并回填默认项目 Thread；新项目自动建 Thread；无丢失 | 迁移测试 + 旧数据 fixture |
| 17 | 1B/1D | 用户取消、异常退出、任务返工 | 运行中/已完成节点 | 取消/崩溃/返工 | 创建对应 Checkpoint；Session 结束/新建；不误记完成；返工轮次可追溯 | 审计 + NodeRun/TeamRun 状态 |
| 18 | All | UI 不存在手动 Session 管理入口 | 正常桌面 UI | 检查导航/任务详情/设置 | 没有继续/新建/选择 Session、手动恢复、手动压缩入口；只显示业务状态和异常 | UI 快照 + 路由/按钮扫描 |
| 19 | 1B | P0 超预算安全失败 | 约束/验收标准超过硬预算 | 组装 Context | 不静默裁剪 P0；明确失败并提示；不启动新 Session | ContextBuilder 单测 |
| 20 | 1B | Checkpoint 与真实文件/Artifact 一致 | 有文件变更/Artifact | 创建 Checkpoint | 文件 hash/Artifact checksum 与证据一致；不一致不标记 verified | 文件/Artifact 校验测试 |
| 21 | 1A | 旧全局 Planner Thread 下创建 Task Memory | 旧全局 Planner 消息存在，Phase 3 Thread 未迁移 | 创建 Work/Task Memory | Task Memory 以 work_id 隔离；不依赖 thread_id；projectId 从 Work 读取 | DB 断言 |
| 22 | 1A | Planner 创建 Work 保存 Project ID | 当前项目 A | Planner 提议 create_team_task 并确认 | Work.project_id=A；Task Memory 归属 A；验收标准写入 Work 当前版本 | Work/TaskMemory DB 断言 |
| 23 | 1B | Ledger 未实现时 Checkpoint 标记不完整 | Phase 1D 表尚未实现 | 创建 Checkpoint | `sideEffectCompleteness=not_tracked`；不伪装 complete；高风险任务不继续不可逆操作 | Checkpoint JSON + 风险策略 |
| 24 | 1B | Checkpoint 引用不存在的副作用 | SideEffectRef 有 key，ledger 无记录 | 恢复 | 标记 missing/partial；不得当作 not_started；高风险阻塞 | Checkpoint/ledger 断言 |
| 25 | 1D | 外部成功但本地未写 succeeded 时崩溃 | 外部操作成功，ledger 仍 in_progress | 进程崩溃后恢复 | 标记 unknown；要求核实；不自动重试 | ledger 状态机 + 审计 |
| 26 | 1B | 文件/Artifact/测试证据不一致 | 必需文件缺失、hash 变化、Artifact version/checksum 变化、测试对应旧代码 | 创建/恢复 Checkpoint | 分别标记 missing/invalid/stale；不能 verified；不覆盖文件 | 证据校验测试 |
| 27 | 1B | 非关键参考资料缺失 | 必需证据通过，非关键资料缺失 | 恢复 | 标记 partial；按风险决定受限恢复；高风险仍阻塞 | Checkpoint evidenceStatus |
| 28 | 3 | Thread 迁移不影响 Task Memory/Checkpoint | Phase 1 已生成 Task Memory/Checkpoint | 执行 v35 迁移 | Task Memory/Checkpoint 内容与 work_id 不变；只更新 Planner 消息归属 | 迁移前后 hash 对比 |
| 29 | 1B | Phase 1B 无 Ledger 时安全运行 | Phase 1D 未实现 | 普通任务执行/Checkpoint | 记录不完整但任务可安全继续；不执行高风险副作用 | 风险策略 + 审计 |
| 30 | 1C/2 | Session 自动切换后上下文完整 | 触发 85% 或 Session 失效 | 自动新建 Session | ContextBuilder 从 Checkpoint 恢复 P0/P1；无手动操作 | Prompt manifest + Session 记录 |
| 31 | 1A | 无法判断归属的旧消息不进入任务事实 | 旧全局消息存在且无项目归属 | 创建/读取 Task Memory | 旧消息只保留，不写入任务事实；标记来源不确定 | Task Memory 断言 |
| 32 | 1B | 路径越界/符号链接逃逸 | Work root 外文件/符号链接 | 创建 Checkpoint 文件证据 | 拒绝越界路径；不读取/不记录外部文件 | 路径安全测试 |
| 33 | 1B | 恢复失败不覆盖当前工作区 | 文件缺失/hash 不一致 | 尝试恢复 | 报告差异并保留现场；不自动覆盖/回滚/删除 | 文件系统快照对比 |

补充测试：

- 备份/恢复后 Session/Checkpoint/SideEffect 一致性；
- 日志 retention 不删除审计所需 Checkpoint；
- 手工注入超长消息/超长报告，验证预算裁剪；
- 项目级 Planner Thread 自动创建，不需要用户选择。

---

## 11. 分阶段实施路线

### Phase 1A：Task Memory 和验收标准持久化

- 新增 `task_checkpoints` 基础表（v31，Phase 1B 启用自动创建）和 `task_memories`（v32）、Work 验收标准字段（v34）；
- Task Memory 以 `work_id` 为主键，不依赖 Planner Thread；`project_id` 从 Work 读取，Work 创建时明确保存；
- 任务创建时把 Planner action 的验收标准写入 Work，并 seed Task Memory 快照；Planner action 增加可选 `projectId`，Core 校验项目存在并写入 Work；
- 保存关键决策、约束、进度、待办、文件/测试证据；
- 区分 verified/inferred/pending，记录来源与更新时间；
- Phase 1A 可以继续使用旧全局 Planner 聊天，但 Task Memory 的事实只从 Work/Execution/Artifact/Test 等可验证来源构建；旧 Planner 消息只作为上下文来源，不进入任务事实；
- 旧消息无法确认项目归属时只保留在默认 Thread/默认项目，不推断为当前项目事实；
- 不再只依赖最近 30/40 条消息。

验收：新 Execution 使用 Work 当前验收标准；旧 Checkpoint 保留当时版本；旧任务可回填/标记 pending；Task Memory 的 project/work 隔离不依赖 Planner Thread 迁移。

### Phase 1B：Checkpoint 和 Context Builder

- 启用 `task_checkpoints` 自动创建（表已在 Phase 1A 建立）和 `ContextBuilder` 纯模块；
- 定义 `SideEffectRef`、副作用完整性标记（complete/partial/not_tracked）和恢复前查询接口契约；Phase 1D 前不假装副作用完整；
- 在 Phase 1D ledger 尚未实现时，Checkpoint 必须标记 `sideEffectCompleteness=not_tracked`；高风险任务遇到不完整副作用信息时不得继续不可逆操作；
- 定义文件/Artifact/测试证据结构与校验状态（verified/partial/invalid/missing/not_required）；
- 执行终态自动创建 Checkpoint；
- ContextBuilder 统一组装 Agent/Project/Task Memory/Checkpoint/最近消息/文件/Artifact；
- ContextBuilder 只读取当前 Work 允许的 Planner 消息：Phase 3 前不读取全局历史作为任务事实；
- 建立 Token 预算和 P0/P1/P2/P3 裁剪优先级；
- 支持通过 Checkpoint 创建全新 Session 并恢复任务；
- 验证恢复信息与真实文件/Artifact 一致。

验收：成员/队长跨 Session 恢复；验收标准不丢失；长任务不因消息窗口丢失关键约束。

### Phase 1C：自动上下文管理基础

- 引入 `SessionLifecycleManager` 基础接口；
- 新增 `model_context_windows`（v36），提供 Provider/模型上下文窗口与来源/置信度；
- 实现 70% 软阈值和 85% 硬阈值；
- 实现自动压缩评估与新 Session 决策；
- 实现 Provider 不支持 Resume 时的自动 Checkpoint 降级；
- 不提供任何手动 Session 控制入口；
- 仍保持 Provider 无关，不依赖 Claude Code `--resume`。

验收：预算阈值触发可解释；新 Session 从 Checkpoint 恢复；UI 无 Session 控制。

### Phase 1D：恢复安全

- 实现 Phase 1B 定义的 `SideEffectRef` 契约和 `task_side_effects` 基础表/接口（v34）；
- 处理 Checkpoint 创建失败的风险分级；
- 明确恢复过程的状态判断（not_started/in_progress/succeeded/failed/unknown）；
- 增加任务风险分级（Core 根据操作/权限/副作用）；
- 增加日志容量监控与保留策略设计；
- 不得直接清理已有日志。

验收：高风险任务失败阻塞；普通任务受控降级；未知副作用不盲目重试。

### Phase 2：SessionLifecycleManager 和 Provider Resume

- 完善 SessionLifecycleManager；
- 打通 `resumeSessionId`：协议内部参数 → Daemon → Provider；
- Claude Code 适配器实现并测试 `--resume`，能力声明改为 `native`；
- 评估并接入 CodeBuddy Resume；
- 保留 Provider 无关的 Checkpoint 恢复；
- 完成 Resume 失败降级测试；
- 其他 Provider 始终 Checkpoint 新建。

验收：同一任务连续工作可复用 Session；Resume 失败可降级；不同 Provider 行为一致可解释。

### Phase 3：记忆隔离

- Planner 项目级 Thread（v35）；
- Team Leader 团队协调记忆；
- 成员任务级记忆；
- 项目、任务、Agent 的记忆访问权限隔离；
- UI 只显示业务进度/异常，不提供 Session 控制。

验收：项目隔离、权限隔离、Planner 长期决策不丢失。

### Phase 4：长期可靠性

- 完整副作用幂等机制；
- 恢复对账；
- 日志保留与归档；
- 备份和恢复一致性验证；
- 长期运行稳定性测试。

验收：取消/崩溃/恢复/返工/重启全链路可追溯，不重复副作用。

---

## 12. 剩余技术问题（不再包含已确认决策）

以下问题不改变 CTO 已确认的六项决策，只影响具体实现细节；**不阻塞 Phase 1A 启动；Phase 1B 可以启动，但 `verified` 判定前需定稿文件/Artifact 校验范围**。

1. **风险分级的具体矩阵**：哪些工具/权限/操作算 high/medium/low；建议 Phase 1D 前由 Core 安全规则确定，不依赖模型。阻塞 Phase 1D，不阻塞 Phase 1A/1B。
2. **模型上下文窗口的 Provider 映射与 fallback**：`model_context_windows` 的具体数据来源、缺失时的保守默认值；阻塞 Phase 1C 的预算决策，不阻塞 Phase 1A/1B。
3. **Checkpoint 文件一致性校验范围**：全工作区 hash、仅变更文件、还是 Artifact checksum；建议先变更文件 + Artifact，Phase 1B 可实施。阻塞 Phase 1B 的“verified”判定，不阻塞表/接口建立。
4. **Project Memory 写入策略**：哪些决策自动写、哪些需要用户确认；阻塞 Phase 3，不阻塞 Phase 1。
5. **Planner Thread 是否需要自动轮换**：第一版建议一个项目一个 Thread；如果后续需要自动轮换，再增加 `status/archived_at`。阻塞 Phase 3 的长期策略，不阻塞 Phase 1。
6. **原始日志保留期**：当前样本约 128MB；建议 30–90 天或按任务保留，但不在 Phase 1 清理。阻塞 Phase 1D/4 的运维参数，不阻塞 Phase 1A/1B。
7. **团队任务是否升级为结构化 ReworkRequest**：Phase 1 至少把返工轮次/原因写入 Checkpoint；独立表在 Phase 3/4 评估。不阻塞 Phase 1。
8. **完成 Work 后重新打开的 Session 语义**：建议“最终 Checkpoint + 结束 Session；重新打开 = 新 Session 从最终 Checkpoint 恢复”，Phase 2 前确认。不阻塞 Phase 1。

**Phase 1A 没有阻塞性未决决策；Phase 1B 可以启动，但在把 Checkpoint 标记为 `verified` 前必须定稿文件/Artifact 一致性校验范围。** 可以先做 Task Memory、Work 验收标准、Checkpoint 表和 ContextBuilder；Phase 1C/1D 前再确认风险矩阵、上下文窗口来源和保留策略。

---

## 13. 对重点问题的明确回答

1. **Task、Execution、Session、Checkpoint 关系**：Task 1:N Execution；Execution N:1 Session；Task 1:N Checkpoint；Checkpoint 可选引用 Execution/Session；Task Memory 是 Task 的当前快照。
2. **Task 是否可有多个 Session**：可以，当前事实上每次执行一个新 Session；目标按阶段/Agent/返工管理多个 Session。
3. **Session 是否可跨多个 Execution**：Schema 允许，当前未实现；目标在预算允许且 Provider 支持 Resume 时允许。
4. **Execution 是否可创建多个 Session**：不可以；一次执行只使用一个 Provider Session。Resume 失败应结束当前执行并从 Checkpoint 新建。
5. **Session Resume 与 Checkpoint Resume 区别**：前者复用 Provider 内部上下文，后者新建 Session 并重建结构化上下文；Checkpoint 是可靠基础。
6. **Session 丢失/无法恢复**：从最新有效 Checkpoint 新建；无 Checkpoint 时明确阻塞/等待，不假装成功。
7. **新 Session 如何获得足够上下文**：ContextBuilder 按优先级加载 Agent/Project/Task Memory/Checkpoint/相关文件/最近消息，不重放全部历史。
8. **如何避免摘要错误导致偏离**：事实分级（verified/inferred/pending）、来源引用、Checkpoint 证据、Core 验证、验收标准原文保留、P0 不裁剪。
9. **Planner 长期记忆是否与项目记忆分离**：是；Planner 对话历史在项目级 `planner_threads`，项目事实在 `project_memories`；ContextBuilder 同时读取但来源和写入规则不同。
10. **Leader 是否需要独立团队记忆**：起步不需要独立表；Task Memory + 团队状态派生足够；跨任务团队模式出现后再评估。
11. **是否保留原始 Session 历史**：保留用于审计/诊断，但默认不进入 Prompt；需要 retention 策略。
12. **如何控制上下文成本和重复输入成本**：Token 预算、Context Manifest、Task Memory/Checkpoint、Session 复用、Provider cache、日志/摘要分层。
13. **Phase 1 是否依赖 Provider Resume**：不依赖；Phase 1 只做 Checkpoint 重建，Phase 2 才接 Claude Code/CodeBuddy Resume。
14. **副作用如何记录**：`task_side_effects` 区分 not_started/in_progress/succeeded/failed/unknown；恢复前查询，不盲目重试。
15. **验收标准如何保存**：Work 保存正式版本，Task Memory 保存带 Work 版本/时间戳的快照，Checkpoint 保存历史版本。
16. **用户是否可以手动管理 Session**：不可以；UI 只显示业务进度/异常，所有 Session/Checkpoint 决策由 Core 自动完成。

---

## 14. 当前实现与目标架构差距摘要

| 能力 | 当前 | 目标 |
|---|---|---|
| Session 复用 | 无；每次新 Session | Phase 2 自动复用/切换；Phase 1 Checkpoint 重建 |
| Session Resume | Provider 层未打通 | Claude/CodeBuddy Phase 2 可选，失败降级 |
| Task Memory | 无 | 结构化、版本化、可恢复 |
| Checkpoint | 无 | 追加式、不可变、带证据 |
| Project Memory | 无 | 项目级长期记忆 |
| Planner Thread | 全局 `planner_messages`，无项目隔离 | 项目级 `planner_threads`，旧消息迁移保留 |
| 验收标准 | Planner 动作有，DB/Prompt 丢失 | Work 正式版本 + Task Memory 快照 + Checkpoint 历史版本 |
| 上下文预算 | 无；固定 30/40 条 | 70%/85% Token 预算驱动 |
| 上下文来源 | 无 manifest | 分段/来源/hash/置信度可审计 |
| 异常恢复 | 新 Session，无 Checkpoint | Checkpoint 恢复 + 明确失败 |
| 副作用安全 | 无 | `task_side_effects` + 恢复前查询 |
| 审计 | Session 生命周期未审计 | 全自动决策审计 |
| 日志保留 | 无清理；样本约 128MB | 分层 retention |

**最重要的架构风险：**

1. 当前“最近 N 条消息”会在长任务中丢失验收标准和关键约束，且没有 Checkpoint 可恢复；
2. 所有 Provider Resume 都未打通，若直接做 Session 复用会不可用；Phase 1 必须 Checkpoint 重建；
3. 团队任务的验收标准实际被丢弃；
4. 长报告进入 Prompt 可能超出模型窗口，且没有 token 预算；
5. 恢复时可能重复副作用，当前没有 side-effect ledger；
6. Planner 聊天是全局的，项目之间没有隔离，长期决策可能串项目。

**推荐方案：** 先做 Provider 无关的 Task Memory + Checkpoint + ContextBuilder（Phase 1），再做 Claude/CodeBuddy Resume 和 SessionLifecycleManager（Phase 2）；不要引入第二套调度器/执行引擎，所有状态仍由 Core 控制。

---

## 15. 架构简化审查（是否过度设计）

结论：**不需要新增第二套调度器、执行引擎或事件总线；Phase 1A/1B 也不需要拆成多个微服务。**

### 15.1 可以复用的现有结构

- `ExecutionService`：继续负责执行门禁、并发队列、进程、日志、终态；不把上下文管理塞进执行器；
- `Work / Assignment / Execution / AgentSession`：继续作为任务、岗位、执行、会话的业务骨架；
- `team_task_subtasks / team_task_runs / team_task_messages`：团队状态继续从现有表派生，不另建团队状态机；
- `node_runs / workflow_runs / artifacts / rework_requests`：工作流的结构化快照、Artifact 版本、返工请求继续复用；
- `execution_logs`：继续作为原始审计证据，不把聊天摘要当事实。

### 15.2 服务拆分建议

| 模块 | 是否 Phase 1 引入 | 结论 |
|---|---|---|
| `TaskContextService` | 是 | 统一管理 Task Memory + Checkpoint 两个仓储；不拆成两个服务，避免过早模块化 |
| `ContextBuilder` | 是 | 纯函数/纯模块，输入结构化快照，输出 Prompt + manifest；便于单测 |
| `SessionLifecycleManager` | Phase 1C 基础接口，Phase 2 完善 | 不接管执行；只做 Session 选择/切换/预算决策 |
| `SideEffectLedger` | Phase 1D 接口 + 表 | 先建记录/查询接口，完整幂等 Phase 4 |
| 独立事件总线 | 否 | 继续使用现有 Execution 终态回调和 team/workflow 事件；不引入第二套事件系统 |
| 独立调度器 | 否 | 继续使用 `WorkflowScheduler` / `FairDispatcher` / 团队运行队列 |
| 独立执行引擎 | 否 | 继续使用 `ExecutionService` 和 Provider Adapter |

### 15.3 数据模型简化

- 不建 `task_memory_versions`：当前 Task Memory + 不可变 Checkpoint 已能表达历史；
- 不建 `agent_memories`：Agent 身份层继续用 `agent_profiles.system_prompt/skills`，动态记忆先放 Project/Task；
- 不建 `team_memories`：团队状态从现有子任务/运行/消息派生，避免重复状态；
- `project_memories` 只保留当前快照 + 版本号，不先拆版本表；Checkpoint/Task Memory 已承担任务历史；
- `planner_threads` 是必要的：当前 `planner_messages` 全局，无法可靠做项目隔离；一个项目一个 Thread 是最小设计；
- `works.acceptance_criteria_json` 是必要的：验收标准是业务事实，不能只存在 Task Memory 或 Prompt；
- `task_side_effects` 是必要的：Execution/Log/Audit 是追加记录，缺少状态机、唯一性和幂等键，不能安全替代副作用账本；
- 不建 `checkpoint_files` 表：Phase 1B 的文件证据放在 Checkpoint JSON，按需读取 Artifact checksum；只有出现按文件查询/跨 Checkpoint 聚合需求时再规范化；
- 不重复存 Artifact 内容：只存 `artifactId/version/checksum`；文件 SHA-256 只对必需/变更文件计算，能复用 Artifact checksum 就不重复计算；
- Phase 1A 的 Task Memory 不依赖 Planner Thread；Phase 3 的 Thread 迁移可独立实施，不重写 Task Memory/Checkpoint。

### 15.4 避免过度设计

- 不让模型直接写 Task Memory/Checkpoint/Session 关联；Core 是唯一写入者；
- 不把“聊天摘要”当任务事实；摘要只作为低优先级上下文；
- 不重复保存可以可靠引用的数据（例如文件内容用 Artifact/路径/hash，不复制进 Task Memory）；
- 不为每个 Agent 建独立记忆表；先按 Project/Task 共享 + 权限过滤；
- 不为了“自动”引入复杂的消息总线；现有回调足够。

### 15.5 结构归类

**必须新增：**

- `works.acceptance_criteria_json/version/updated_at`；
- `planner_threads` + `planner_messages.thread_id`（Phase 3，但设计已定）；
- `task_memories`；
- `task_checkpoints`（含 evidence/side-effect 完整性字段）；
- `task_side_effects`（Phase 1D 实现，Phase 1B 先定契约）；
- `model_context_windows`。

**可以复用：**

- Work / Assignment / Execution / AgentSession；
- Artifact / ArtifactVersion（checksum、不可变版本）；
- Worktree / NodeRun / WorkflowRun / TeamTaskRun / TeamTaskMessage；
- ExecutionLog / AuditLog（原始证据与审计）；
- `execution_logs` 的 structured tool_use 作为副作用/文件证据来源，但不替代状态账本。

**可以延后：**

- Project Memory 写入策略与 UI（Phase 3）；
- Planner Thread 自动轮换（Phase 3 后）；
- 完整外部副作用对账/幂等（Phase 4）；
- 按文件查询的 `checkpoint_files` 规范化表（当前 JSON 足够）。

**不应新增：**

- 第二套调度器、执行引擎、事件总线；
- `task_memory_versions`（Checkpoint 已承担历史）；
- `agent_memories` / `team_memories`（先复用 Agent/Work/Team 现有结构）；
- 重复保存 Artifact 完整内容；
- 把聊天摘要当任务事实的“memory summary 表”。

---

## 16. 代码证据索引

- Session/Execution 创建：`apps/core/src/services/execution-service.ts:522-581`
- Session 结束：`apps/core/src/services/execution-service.ts:1132-1139`
- Planner 启动/等待：`apps/core/src/services/planner-chat-service.ts:397-423`
- Planner action schema 无 projectId：`apps/core/src/services/planner-chat-service.ts:27-34`
- Planner Prompt/40 条历史：`apps/core/src/services/planner-chat-service.ts:426-479`
- 团队任务创建/验收标准丢弃：`apps/core/src/services/team-collaboration-service.ts:143-166`
- 团队队长/成员启动：`apps/core/src/services/team-collaboration-service.ts:728-805`
- 队长/成员 Prompt：`apps/core/src/services/team-collaboration-service.ts:856-906`
- 团队线程最近 30 条：`apps/core/src/services/team-collaboration-service.ts:1093-1098`
- 工作流节点启动：`apps/core/src/workflow/execution-bridge.ts:204-210`
- 工作流终态/重试：`apps/core/src/workflow/execution-bridge.ts:224-308`、`:434-446`
- ReworkPolicy 幂等键：`apps/core/src/db/migrations.ts:528-546`
- Session 表：`apps/core/src/db/migrations.ts:64-74`、`:211-230`
- Execution 表：`apps/core/src/db/migrations.ts:77-95`、`:456-490`
- Planner/Team 消息表：`apps/core/src/db/migrations.ts:1028-1104`；`planner_messages` 无 `project_id/thread_id`
- Works 无验收标准列：`apps/core/src/db/migrations.ts:146-161`
- 当前无 `task_memories/task_checkpoints/task_side_effects/model_context_windows`：全仓搜索无对应表/服务
- Artifact 表/不可变版本：`apps/core/src/db/migrations.ts:611-660`
- Session 仓储：`apps/core/src/db/repositories/session-repository.ts`
- Execution 仓储：`apps/core/src/db/repositories/execution-repository.ts`
- Claude Code args/resume：`packages/runtime-cli/src/claude-code/args.ts:7-25`
- Claude Code capabilities：`packages/runtime-cli/src/claude-code/capabilities.ts:15-25`
- CodeBuddy capabilities：`packages/runtime-cli/src/codebuddy/capabilities.ts`
- Codex/Gemini/Grok/Antigravity capabilities：对应 `packages/runtime-cli/src/*/capabilities.ts`
- SDK resume 类型：`packages/runtime-sdk/src/types.ts:46-60`
- Daemon 启动参数未透传 resume：`apps/daemon/src/runtime/execution-manager.ts:165-175`
- Protocol ExecutionStartParams 无 resume：`packages/protocol/src/methods/execution.ts:13-22`
- 本地只读样本：37 Sessions / 37 Executions / 585,484 logs / 127,892,621 bytes；31 个 Session 无 assignment，6 个有 assignment

> 说明：以上行号基于 2026-11-08 当前工作区；工作区包含未提交改动，后续代码变化需要重新核对。

---

## 17. CTO 决策落实对照

| CTO 决策 | 落实位置 |
|---|---|
| Provider Resume 分阶段：Phase 1 Checkpoint、Phase 2 Resume | §0、§3.2、§5.4、§11 Phase 1B/1C/2、§10 #9/#10 |
| Planner 项目级 Thread，旧消息迁移不删除 | §3.1、§4.2、§7.5、§8.1、§10 #13/#16 |
| 验收标准 Work + Task Memory 双层保存 | §4.3、§6.1、§7.2、§7.6、§8.2、§10 #1/#2 |
| Checkpoint 失败按风险分级 | §7.3、§9.2、§10 #7/#8、§11 Phase 1D |
| Token 软 70% / 硬 85%，窗口来源可追溯 | §5.3、§6.3、§7.8、§10 #4/#5/#6 |
| 全自动管理，无手动 Session 控制 | §0、§4、§5.1、§8、§10 #18、§15 |
| Phase 1A 不依赖 Planner Thread | §0、§7.5、§8.5、§11 Phase 1A、§10 #21/#22/#28 |
| SideEffectRef 契约先于 Ledger 实现 | §7.7、§9.4、§11 Phase 1B/1D、§10 #23/#24/#25/#29 |
| Checkpoint 文件/Artifact 一致性 | §7.3、§9.6、§10 #20/#26/#27 |

**Phase 1A 无阻塞性未决决策；Phase 1B 可启动，但 `verified` 判定前需确认文件/Artifact 一致性范围。Phase 1C/1D 前需确认风险分级矩阵、上下文窗口来源和日志保留参数。**
