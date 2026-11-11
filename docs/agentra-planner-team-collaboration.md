# Agentra Planner 聊天室与团队协作实现

- 日期：2026-11-07
- 范围：Planner 独立聊天室、团队任务卡、队长持续负责、成员执行、升级链、任务状态
- 决策：团队任务以 Multica 式线程协作为主路径；Plan/审批/DAG 保留给结构化交付
- 不在范围：独立收件箱、Provider 凭据管理、Slack/Lark 等外部平台集成

## 1. 产品模型

```text
老板
 ↕  Planner 聊天室（唯一需要盯的地方）
Planner（独立 AI 幕僚长）
 ↕  升级 / 决策回流
团队队长（PM / CTO）
 ↕  拆解、分派、验收、成员提问
团队成员
```

- 老板只和 Planner 讨论目标；讨论结果变成“团队任务卡”。
- 老板确认任务卡后，任务发给团队，队长开始持续负责。
- 成员遇到问题先找队长；队长能决定的直接决定，超界升级 Planner。
- Planner 能决定的直接决定；需要老板拍板的回到 Planner 聊天室。
- 不建独立收件箱：所有升级、提问、任务卡确认都在 Planner 聊天室或团队任务线程里。

## 2. 角色权限

| 角色 | 可以 | 不可以 |
|---|---|---|
| 老板 | 目标、优先级、最终验收、确认任务卡/团队、组织调整 | 日常执行细节 |
| Planner | 讨论、提议团队/任务卡、处理队长升级、向老板提问 | 未经确认直接改组织/改任务；不执行任务 |
| 队长 | 拆子任务、分派/改派、重试、子任务验收、成员问题裁决、升级 Planner | 改任务目标/验收/团队归属；不执行成员任务 |
| 成员 | 执行子任务、向队长提问 | 给别人分派、改任务范围 |

## 3. 数据模型（迁移 v29 / v30）

### works 扩展

- `collaboration_mode`：`workflow` | `team`，旧任务默认 `workflow`
- `owner_team_id`：团队任务唯一归属团队
- `issue_status`：`triage | backlog | in_progress | review | done`
- `assignee_agent_id`：当前负责人（团队任务默认为队长）

Work 生命周期 `status`（draft/active/...）继续保留；`issue_status` 是团队任务看板状态，两者分离。

### planner_messages

单聊室持久化消息：`author_type(user/planner/system)`、`content`、`action_json`、`action_status(proposed/applied/rejected)`、`execution_id`、`related_work_id`。

### team_task_messages

团队任务线程：`work_id`、`author_type(user/leader/member/planner/system)`、`kind(message/decision/escalation/run/status)`、`metadata_json`、`execution_id`。

### team_task_subtasks

队长拆出的子任务：`work_id`、`title`、`description`、`assignee_agent_id`、`status(pending/running/review/done/blocked)`。

### team_task_runs

线程运行队列：`work_id`、`agent_id`、`role(leader/member)`、`trigger_message_id`、`subtask_id`、`status(queued/running/succeeded/failed/cancelled)`、`execution_id`。

### team_task_run_steps（v30）

执行记录：`run_id`、`work_id`、`step_key`（工具调用 id）、`name`、`summary`、`created_at`。
每次 Bash/Read/Edit 等工具调用持久化为一条步骤，线程可回看；实时阶段通过 WebSocket
事件立即显示，轮询只用于补状态。

约束：

- 每个 Work 最多一个 running run；
- 每个 Work 最多一个 queued run（running 时允许再排一个）；
- 评论在运行中默认排队/合并；`steer` 注入当前运行，`restart` 取消后重开。

## 4. 核心流程

### 4.1 Planner 讨论与任务卡

1. 老板在 Planner 聊天室发言。
2. `PlannerChatService` 把团队、成员、Agent、最近对话注入 Planner 提示词。
3. Planner 返回 JSON：`reply` + 可选 `action`：
   - `create_team_task`：团队、标题、目标、验收、可选工作目录；
   - `create_team`：使用已有 Agent 建团队；
   - `create_team_with_agents`：一次创建队长/成员 Agent 并建团队；
     - 队长必须是 analyze；
     - 成员可为 analyze/edit；
     - Provider 可指定，也可由 Core 选择默认健康 Provider。
4. 消息以 `proposed` 保存；老板在 UI 确认后才执行。
5. 确认 `create_team_task` 后，Core 创建 `collaboration_mode='team'` 的 Work、绑定团队、激活任务、写入初始线程消息，并启动队长。

### 4.2 队长拆解

1. 队长以 `startSystem` 无工具运行，读取任务、团队指引、成员花名册、已有子任务、最近线程。
2. 输出 JSON：
   ```json
   {
     "reply": "...",
     "subtasks": [{"title": "...", "description": "...", "assigneeAgentId": "..."}],
     "completeSubtaskIds": [],
     "decision": null,
     "escalateToPlanner": false,
     "plannerQuestion": null
   }
   ```
3. Core 校验成员、团队、非队长、子任务去重后写入 `team_task_subtasks`。
4. Core 按顺序启动第一个 pending 子任务对应的成员运行。

### 4.3 成员执行与队长验收

1. 成员以普通 `ExecutionService.start` 在任务工作目录执行；Core 自动确保同 workRole 的 Assignment。
2. 成员输出 JSON：`{"reply","blocked","question"}`。
3. 完成后子任务进入 `review`，队长自动收到“请验收”运行。
4. 队长输出 `completeSubtaskIds` 标记完成；全部完成后 Work `issue_status` 进入 `review`。
5. 老板可在任务线程直接“标记完成/标记待验收/重新打开”。

### 4.4 升级链

- 成员 `blocked` 或有问题 → 队长运行。
- 队长 `escalateToPlanner=true` → `PlannerChatService.escalateFromTeam`：
  - 在 Planner 聊天室写入“团队升级”消息；
  - Planner 处理后在聊天室回复；
  - 回复同时写回团队任务线程（kind=decision），并启动队长继续处理。
- Planner 需要老板拍板 → 直接在 Planner 聊天室回复；老板继续讨论。
- 不创建独立收件箱。

### 4.5 评论/steering

`teamTask.comment` 支持：

| mode | 行为 |
|---|---|
| `normal` | 有运行则排队/合并；无运行则启动 |
| `steer` | 注入当前运行；无运行则排队 |
| `after_run` | 排到当前运行之后 |
| `restart` | 取消当前运行并重开 |
| `skip` | 只留言，不触发 |

## 5. 接口

### Planner

- `planner.chat.get` → 消息列表
- `planner.chat.send` → 老板发言并等待 Planner 回复
- `planner.action.apply` → 确认执行 proposed action；可覆盖任务工作目录
- `planner.action.reject` → 取消提议

### 团队任务

- `teamTask.get` → Work、线程消息、子任务、运行、activeRun
- `teamTask.comment` → 评论 + 触发模式
- `teamTask.setStatus` → triage/backlog/in_progress/review/done
- `work.files.list` → 只读列出团队任务工作目录中的交付文件（深度 3、最多 200 个，跳过依赖/隐藏/符号链接）

## 6. UI

- 新增「Planner」导航页：持久聊天、任务卡/团队卡确认、工作目录确认、升级消息；聊天区填满可用高度，Planner 和老板消息带头像。
- Core 启动时自动创建/校正默认 Planner Agent（优先 Claude Code + `sonnet`），老板不需要先手动创建。
- 设置页改为分类布局：运行时 / Planner / 个人 / 数据 / 关于。
  - Planner 分类可配置 Planner Agent 的名字、头像、Provider 和模型；
  - 个人分类可配置老板自己的名字和头像（emoji 或上传图片），只保存在本机；
  - 模型候选来自 Provider 当前配置（`runtime.provider.models`），读取失败时回退内置目录；
  - 保存后 Planner 聊天、规划、团队升级都会使用新配置。
- 任务详情：`collaborationMode='team'` 时使用 `TeamTaskChatPanel`：
  - 顶部“当前谁在做什么”：当前运行成员/子任务；
  - 成员状态收进标题行，用圆点展示：灰色空闲、绿色运行中、黄色待验收、红色阻塞；
  - 子任务只显示标题、负责人和状态，技术描述默认折叠；已完成子任务不再置顶；
  - 队长派工以 `@成员` 消息出现，随后成员运行；
  - Agent 用第一人称像真人一样沟通：成员收到派工后回复“收到，@队长…”，完成后回复“@队长 已完成…，请查收”；队长验收时回复“收到，@成员…我来验收”；
  - 不再生成“成员开始处理子任务。”“成员已完成子任务，请队长验收。”这类流程播报；旧数据中的此类消息在 UI 中隐藏；
  - 老板消息右对齐、带头像，类似微信群聊；成员/队长消息左对齐并显示各自头像；名字只显示 Agent 名，不追加“队长/成员”；
  - 成员运行开始时先发“收到，@队长…”回执，完成后回报结果；
  - 执行中使用 Core WebSocket 事件实时显示“思考中 / 正在使用工具 / 正在输入”，
    不等待轮询；Agentra 使用 WebSocket 而不是 SSE，因为 Core 与 Desktop 已有双向事件通道；
  - 每次工具调用（Bash/Read/Edit 等）写入执行记录；右侧「执行记录」tab 按运行分组展示全部步骤；
  - 长时间运行产生的日志超过 8MB 时，仍优先提取最终 result 作为成员报告，不因日志体积丢失结论；
  - Core 启动时会从执行结果回填旧版本降级为“成员已完成本轮处理。”的成员报告；
  - 聊天记录默认精简到 100 字以内，每条消息的「详情」展示完整正文和该次运行的 Bash/Read/Edit 日志；
  - 「详情」只在正文被截断或该次运行有工具日志时出现，并放在消息头同一行，不额外占一行；
  - 历史成员运行在 Core 启动时从执行日志回填工具步骤，旧任务的「详情」也能看到运行日志；
  - 消息只渲染可读 `reply`，不会把原始 JSON 直接铺在页面上；
  - 任务状态、团队、当前运行；
  - @成员、触发模式选择、标记验收/完成。
  - 团队任务的「交付物」tab 只读列出工作目录中的交付文件（跳过 node_modules/.git/隐藏文件/符号链接）；
  - 任务列表卡片整卡可点开详情，不再显示状态、根目录、打开按钮或团队/岗位数量；只保留项目与团队（或首个岗位）信息；
  - 任务详情右上角用图标切换右侧边栏；运行中的 Agent 行提供「查看更多」和停止图标；
  - 团队任务的「团队」tab 只展示队长与所属团队，成员状态在任务标题行查看；一个团队任务只归属一个团队，Core 拒绝再关联其他团队；
  - 任务详情尽量一屏显示：页面与右侧面板不出现滚动条，任务说明折叠为单行摘要，聊天记录在聊天区内滚动；
- `workflow` 任务继续使用原 Plan/DAG 任务视图。

## 7. 安全与边界

- Planner/队长使用内部 `startSystem`，`allow:[]`，禁止 Bash/写入；Planner 可使用 native 或 emulated toolControl 的 Provider（不支持 unsupported），队长必须使用 native toolControl。
- Planner/队长不直接改库；所有动作由 Core 校验后执行。
- 成员仍是普通 Agent，按自身 accessMode 工具权限执行。
- 队长不能把子任务分给自己；成员必须是团队 active 成员。
- 任务目标/验收/团队归属不在队长修改范围；越界走 Planner。
- 旧 `collaboration_mode` 默认 `workflow`，不自动把旧任务改成团队任务。

## 8. 验证

- `pnpm test`：100 文件 / 877 用例通过（含 Planner/Team 协作新增测试）
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过
- 真实桌面端 E2E（临时数据目录）：
  - Planner 真实 Claude Code 对话 → 提议团队任务卡；
  - 老板确认 → 创建团队任务；
  - 队长真实拆出两个子任务并分派；
  - BE 成员真实执行完成，队长验收并标记 done；
  - FE 成员继续执行；
  - 支持 restart/steer 评论（实测 restart 成功重开队长运行）。

## 9. 尚未完成

- 独立收件箱（按产品决定不建，折叠进聊天）。
- 团队页成员“当前任务/负载”可视化。
- 任务看板按 issue_status 分列（目前卡片展示 issue_status，列仍按 Work 生命周期）。
- 队长运行超时/自动重试策略；目前失败由线程消息暴露，老板/队长可重启。
- Planner 聊天多会话、消息编辑/重发、附件。
- 外部平台集成（Slack/Lark）、wakeups、automation。
