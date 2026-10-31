# 工作流定义与执行语义

版本：V1.5（基于 v1.0.0 Development Baseline 的 D-017、D-024～D-027 修订）\
本文件是 Workflow Engine 的规范性要求。

## 1. 核心模型

工作流是一个有向无环图（DAG），由节点、边、分支和运行实例构成。**MVP 画布节点只有 7 种**（见第 2 节）；MVP 无任何循环节点，返工由 Workflow Engine 内建的 ReworkPolicy 实现（见第 10 节），不得通过任意图边形成无限循环，设计器必须拒绝含环定义的发布。

- WorkflowTemplate：可复用模板。
- WorkflowVersion：不可变发布版本。
- WorkflowRun：一次运行。
- BranchRun：分支运行状态。
- NodeRun：节点执行实例。
- Approval：人工决策实例。
- ReworkRequest：引擎内建返工实例（非画布节点）。

## 2. 节点类型（MVP：7 种）

### Start
工作流唯一入口。每个 WorkflowVersion 必须有且仅有一个 Start 节点；运行从 Start 启动并写入 workflow.started 事件。发布含多个或零个 Start 的定义必须被拒绝。

### AgentTask
执行 Agent 任务。配置（schemaVersion 1）：
- `assignmentSelector`：`{ workRole, agentProfileId? }` —— **定义层只存角色选择器**，不存 `agentId`、不存 `assignmentId`、不存 `workId`。WorkflowTemplate 跨 Work 复用，运行期在目标 Work 的 active Assignment 中按 `workRole`（有 `agentProfileId` 时再按 `agent_id`）解析；解析失败或命中多个时不启动，且**不自动创建 Assignment**。
- `taskPrompt`：必填，1–20,000 字符，纯文本，**不做变量插值**
- `inputArtifactRefs`：`{ nodeKey, artifactName? }[]`，默认 `[]`。`nodeKey` 必须是**祖先**节点；`artifactName` 必须在该祖先的 `artifacts` 中声明；省略时要求该祖先只声明 1 个 Artifact
- `artifacts`：`{ name, type, required }[]`，默认 `[]`。`name` 1–64 且节点内唯一；`type` ∈ `markdown` / `text` / `code` / `image` / `other`；`required` 默认 `true`
- `workingDirectoryPolicy`：`work_root` | `worktree`，默认 `work_root`。**定义层只校验枚举值**；「目标 Work 是否配置 repository_path」属阶段 4 运行期约束，不参与发布校验
- `outputContract`：`{ profile, fields? }`，默认 `{ profile: "generic", fields: [] }`
  - `generic`：`fields` 最多 20 项，每项 `{ name, type: string|number|boolean|string_array, required }`
  - `test_result`：固定 5 字段，缺一不可——`pass`(boolean)、`failureReason`(string)、`relatedTasks`(string_array)、`impactScope`(string)、`relatedArtifacts`(string_array)
  - **输出不符合契约 → 任务 failed，不触发返工**（PRD §5.8）
- `timeoutSeconds`：可选，默认取 `settings.defaults.timeoutSeconds`，取值 60–86400
- `retryPolicy.maxAttempts`：可选，默认取 `settings.defaults.maxAttempts`，取值 1–3；NodeRun 级执行重试，**与返工 ReworkPolicy 是两个概念**（见第 10 节）

**schemaVersion 1 不包含以下三项**（原基线的配置项，本版删除；依据见条目末）：
- `permissionProfile`：工具权限已在 Agent 级配置（D-019），任务级再配一套会与 Agent 级冲突。
- `completionCriteria`：成功口径 = 进程 exit 0 且 `outputContract` 满足，无需独立配置。
- `humanGates`：人工参与统一由**独立的 HumanApproval 节点**表达（见下节）；两套并存没有正当性。

### HumanApproval
等待用户决策的**独立节点**（不是 AgentTask 的内置门禁）。配置（schemaVersion 1）：
- `target`：`{ nodeKey, phase: "before_execute" | "after_execute" }` —— 被审批的 AgentTask 与时点。
  - `before_execute`：**审批节点位于任务上游**（审批 → … → 任务）；
  - `after_execute`：**审批节点位于任务下游**（任务 → … → 审批）。
- `reworkTargetNodeKey`：可选，默认 `target.nodeKey`；必须是 `agent_task`，且是 target 或本节点上游。request_changes 时 ReworkRequest 指向该任务。
- `instructions`：可选，默认空串，≤2000 字符；展示给审批人的说明。
- `decisions`：**不可配置**，固定为 approve / request_changes / reject（D-015）。
- **无 `timeout` 字段、无超时自动决策**：等待无限期，重启后恢复 pending；等待时长只用于展示与排序。

MVP 决策集合与行为（决策 D-015）：

| 决策 | 行为 |
|---|---|
| approve | 审批通过，当前分支继续 |
| reject | 审批不通过，当前分支暂停，**不自动返工**，等待用户后续决策 |
| request_changes | 要求修改，**必须填写修改意见**并关联返工任务（创建 ReworkRequest）；返工完成后重新进入本节点，形成新一轮审批记录 |

- `before_execute`：approval 状态为 pending 期间，不得创建对应 AgentTask 的 Execution。
- `after_execute`：被审批任务 succeeded 且 Artifact 版本持久化后才发起审批；审批页展示对应 Artifact 版本。
- 审批记录挂在 **HumanApproval 节点的 NodeRun** 上；被审批任务的 NodeRun 通过 `approvals.target_node_run_id` 追溯（DATABASE §2.7）。
- request_changes 触发的返工遵守 ReworkPolicy 的轮次上限（默认 2 轮，不含首次）；超限暂停分支进入人工处理。
- 每轮审批生成独立 Approval 记录；历史决策不可被覆盖。
- MVP 不支持的其他决策（take_over、cancel）与多级审批策略为后续版本。

### Condition
对经过 Schema 验证的上下文进行条件判断。**禁止执行任意 JavaScript / eval，不存表达式文本**：条件以结构化 **predicate AST** 表达（括号由树结构表达），存进节点 `config.predicate`。

**AST 形态（schemaVersion 1）**（深度 ≤10，节点总数 ≤50）：

| 节点 | 结构 |
|---|---|
| 比较 | `{ kind: "comparison", op: "==" \| "!=" \| ">" \| ">=" \| "<" \| "<=" \| "in", left: Operand, right: Operand }` |
| 逻辑 | `{ kind: "logical", op: "and" \| "or", operands: Expr[] }`（2–5 项） |
| 取反 | `{ kind: "not", operand: Expr }` |
| 操作数 | `{ kind: "field", path: string }` 或 `{ kind: "literal", value: Literal }` |
| 字面量 | string（≤200）/ 有限 number / boolean / null；**数组仅用于 `in`**（2–50 项，元素同类型） |

类型规则：`>` / `>=` / `<` / `<=` 只接受 number；`null` 只允许出现在 `==` / `!=`；`in` 的左侧必须是字段、右侧必须是字面量数组。**不做隐式类型转换**——类型不匹配按求值异常处理（见下）。

**可读字段路径白名单**（白名单之外在**发布校验**即拒绝，归入 `expression_invalid`）：
- `nodes.<nodeKey>.status`：取值 `succeeded` / `failed` / `cancelled` / `rejected` / `changes_requested` / `skipped`
- `nodes.<nodeKey>.attempt`：整数
- `nodes.<nodeKey>.output.<field>`：`<field>` 必须是该节点 `outputContract` 声明过的**顶层**字段；不支持嵌套路径

MVP **不支持** `workflow.*`、`work.*` 及任意其他路径。

**假分支的两种表达**（`config.falseBranch`）：
- `"edge"`（默认）：必须有一条 `when=false` 出边；
- `{ kind: "rework", reportNodeKey }`：不产生画布后继，由引擎按 `reportNodeKey` 的结构化报告创建 ReworkRequest —— 返工是引擎内建能力（D-011），**不能画成回边**（D-010 禁止环）。`reportNodeKey` 必须是 `agent_task`，其 `outputContract.profile` 必须是 `test_result`，且该节点必须是本 Condition 的**上游**。

真分支必须恰有一条 `when=true` 出边；`when` 只允许出现在 condition 节点的出边上，每条 condition 出边都必须带 `when`。

**求值异常不按 false 处理**：字段缺失、字段类型与字面量不匹配、节点未产出该字段时，Condition 节点进入 **failed** 并记录原因（运行期求值失败，不是发布期 violation），不静默路由。MVP 典型用途：判断测试结果（pass/fail）以决定进入验收还是触发 ReworkRequest。

### ParallelSplit
创建多个逻辑分支。**分支标识放在出边上**：每条出边必须带 `branchKey`（同一 split 内唯一），运行期分支实例标识为 `<splitNodeKey>/<branchKey>`——由定义直接派生、稳定可复现，不依赖画布坐标或数组下标。

- `config.strategy`：可选，默认 `fan_out_all`，schemaVersion 1 **仅此取值**（所有出边同时激活）。
- 出度 ≥ 2；出边不得带 `when`（条件路由只属于 Condition）。
- **MVP 不支持嵌套并行**：并行区域内不得再出现 `parallel_split`（发布校验拒绝，归入 `branch_invalid`）。
- 每个 `branchKey` 必须能到达配对的 join（可达性校验），否则拒绝发布。

### Join
等待**配对 split** 的各分支达到 Join Policy。

- `config.pairWith`：必填，必须指向一个 `parallel_split` 节点；该 split 的**每个** `branchKey` 都必须存在通往本 join 的路径（分支可达性），且一个 split 只能配一个 join、一个 join 只能配一个 split（配对唯一性）。
- 入度 ≥ 2；入边不得带 `when`。

Join Policy（`config.policy`，必填，默认 `all_success`，schemaVersion 1 **仅一个取值**）：
- `all_success`：全部分支成功（schemaVersion 1 唯一取值）
- `all_terminal` / `quorum`：属后续版本，schemaVersion 1 不支持（定义中出现即发布校验拒绝）

Join 必须按配置策略等待，不可提前放行：分支 paused 时继续等待；任一分支 failed / cancelled 则 join failed，**不自动返工**。

### End
结束**所在分支**。MVP 只有一种结束语义：**成功结束**——schemaVersion 1 的 End **不提供 `outcome` 字段**；failed / cancelled 是引擎状态，不由 End 表达。

- End 置 succeeded 后，其所在分支结束（该分支不再启动新节点）。
- **WorkflowRun 进入 completed 的条件是「没有任何 active 分支」**，而不是「走过某一个 End」：多分支场景下，必须等全部分支离开 active 状态（completed / failed / cancelled）后，WorkflowRun 才置 completed 并写入 `workflow.completed` 事件。
- **允许多个 End**（发布校验要求「至少一个 End」，不限制上限）；多个 End 各自结束自己所在分支，任一 End 不单独决定整个 WorkflowRun 的终态。

**后续版本节点**（不进 MVP，画布不提供）：HumanInput（V1.1）、HumanTakeover（V1.2）、Wait、RetryLoop、ArtifactReview（作为独立节点；MVP 中交付物审批经 HumanApproval 的 after_execute 场景实现）。

### 定义校验与 violations（schemaVersion 1）

**两个入口，同一套规则**：
- `workflow.version.validate`：只校验、不落库，成功返回 `{ valid: boolean, violations: Violation[] }`。
- `workflow.version.publish`：事务内重新校验；不通过返回错误码 `INVALID_PARAMS`，`detail.violations` 与 `validate` 返回的数组**结构完全一致**（信封与 `detail` 见 ARCHITECTURE §7.1）。

**violations 报全部、不短路**：一次校验收集全部问题再返回，UI 才能一次高亮所有错误位置。

**Violation 结构**：`{ violation, nodeKey?, edgeKey?, message }`。`violation` 取闭集值；`nodeKey` / `edgeKey` 用于定位（全局性问题可缺省）；`message` 面向人，不参与程序分支。

**闭集（16 项，冻结；实现不得新增）**：

| 分组 | violation | 含义 |
|---|---|---|
| 图结构 | `start_invalid` | 无 Start 或多个 Start；Start 入度非 0 |
| 图结构 | `end_invalid` | 无 End；End 出度非 0 |
| 图结构 | `unreachable_node` | 存在从 Start 不可达的节点 |
| 图结构 | `cycle` | 图含环 |
| 图结构 | `edge_invalid` | 端点不存在 / 自环 / 重复边 / 边字段与端点类型不符 |
| 图结构 | `key_duplicate` | 节点 key 或边 key 重复 |
| 图结构 | `degree_invalid` | 非 End 节点出度为 0；非 Start 节点入度为 0 |
| 节点配置 | `node_config_invalid` | `config` 结构或取值非法（含未知字段） |
| 节点配置 | `agent_task_invalid` | `assignmentSelector` / `inputArtifactRefs` / `outputContract` 非法 |
| 节点配置 | `approval_invalid` | `target` / `reworkTargetNodeKey` / 审批方向非法 |
| 节点配置 | `expression_invalid` | predicate AST 结构、深度、字面量或字段路径非法 |
| 节点配置 | `condition_invalid` | Condition 出边与 `falseBranch` 配置不一致 |
| 节点配置 | `branch_invalid` | split/join 的分支标识、配对、嵌套或可达性非法 |
| 节点配置 | `settings_invalid` | `settings` 或 `schemaVersion` 取值非法 |
| 版本与并发 | `version_conflict` | 版本号冲突（`unique(template_id, version)`） |
| 版本与并发 | `cas_failed` | 发布 CAS 状态更新失败（并发发布同一 draft） |

**图校验规则 → violation 映射**（规则来源见 PM 的节点语义表；本表只规定产出哪一项）：

| # | 规则 | violation |
|---|---|---|
| 1 | 有且仅有一个 Start；Start 入度 0、出度 ≥1 | `start_invalid` |
| 2 | 至少一个 End；End 出度 0、入度 ≥1 | `end_invalid` |
| 3 | 所有节点从 Start 可达 | `unreachable_node` |
| 4 | 图无有向环 | `cycle` |
| 5 | 边端点存在；禁自环；禁重复边（source + target + when 相同） | `edge_invalid` |
| 6 | 节点 key / 边 key 全图唯一；`config` 按类型严格校验（未知字段拒绝） | `key_duplicate` / `node_config_invalid` |
| 7 | 非 End 节点出度 ≥1；非 Start 节点入度 ≥1 | `degree_invalid` |
| 8 | Condition：恰好 1 条 `when=true` 出边；`falseBranch` 与 `when=false` 出边一致；无其他出边；`when` 只出现在 Condition 出边 | `condition_invalid` |
| 9 | ParallelSplit / Join：`branchKey` 唯一、配对唯一、分支可达、禁嵌套 | `branch_invalid` |
| 10 | AgentTask：`assignmentSelector.workRole` 非空；`inputArtifactRefs` 指向祖先且已声明；`outputContract` 合法 | `agent_task_invalid` |
| 11 | HumanApproval：`target.nodeKey` 必须是 `agent_task`；`before_execute` 要求 target 在本节点下游可达，`after_execute` 要求在上游可达；`reworkTargetNodeKey` 合法 | `approval_invalid` |
| 12 | `schemaVersion` 与 `settings` 取值范围合法；未知版本明确报错 | `settings_invalid` |

`version_conflict` 与 `cas_failed` 只在发布阶段产生（并发与持久化冲突），不属于图校验规则。

**`UNKNOWN_NODE_TYPE` 不在闭集内**：未知节点类型是**错误码**（`RpcErrorCode` 的第 15 个取值），由 Schema 解析阶段直接拒绝；校验器内部**不产生** violation，两者不得混用。

## 3. 节点状态

建议状态：
- blocked：依赖未满足
- ready：满足依赖，可调度
- running：执行中
- waiting_approval：等待人工审批
- waiting_input：等待人工输入
- waiting_checkpoint：等待检查点处理
- paused：暂停
- succeeded：成功
- changes_requested：要求修改
- rejected：拒绝
- failed：失败
- cancelled：取消
- skipped：跳过
- reconciliation_required：状态待核对

**MVP 启用状态子集（D-017 明确，消除悬空引用）**：blocked、ready、running、waiting_approval、paused、succeeded、changes_requested、rejected、failed、cancelled、skipped、reconciliation_required。`waiting_input`、`waiting_checkpoint` 随 Human Input/Checkpoint（V1.1）启用，MVP 不产生这两个状态；schema 保留全量枚举以支持后续版本扩展。

状态迁移必须由 Workflow Engine 状态机校验，UI 不可直接写状态。

## 4. Branch 状态

- active
- paused
- blocked
- completed
- failed
- cancelled

### 分支暂停语义（产品已确认）
暂停一个分支：
1. 原子地将 BranchRun 标记为 paused。
2. 禁止该分支启动新的 NodeRun。
3. 该分支已有运行中的 Execution 按 Provider 能力执行安全中断策略。
4. 其他 BranchRun 不受影响。
5. 不应自动暂停共享节点或其他分支上的节点。
6. 如果某个 NodeRun 同时依赖多个分支，必须按显式依赖/所有权策略处理，不能猜测归属。
7. 恢复时重新计算依赖；仅符合条件的节点进入 ready。
8. Join 必须等待其要求的全部分支条件满足。

执行中任务策略：
- native interrupt + resume：使用原生暂停/恢复。
- interrupt only：中断并保存上下文，之后新建执行尝试。
- no interrupt：允许当前步骤结束后不再推进；或根据用户策略取消进程。
- 不支持安全暂停时，UI 必须说明实际动作和风险。

### 审批等待与分支暂停（决策 D-012/D-015）
Human Approval 等待期间只暂停当前分支（分支进入 paused 或等效等待状态），其他并行分支继续执行。approve 后当前分支继续；reject 后当前分支保持暂停，等待用户后续决策（不自动返工）；request_changes 后当前分支等待关联 ReworkRequest 完成。

### Work 级暂停与终止
- 暂停 Work：Work 下所有 BranchRun 不再启动新 NodeRun；运行中 Execution 按 Provider 能力按分支暂停语义处理；恢复时重新计算依赖。Work 暂停等价于对其全部分支的暂停，但不改变各分支自身的暂停状态记录。
- 终止 Work：终态且不可逆。所有未终结 WorkflowRun 置 cancelled、运行中 Execution 按取消策略停止、pending 审批置 cancelled（系统取消路径，非用户审批决策，见 DATABASE §2.7）；已完成的节点、审批和 Artifact 记录保留。终止需用户确认并写入审计。

## 5. 人工参与配置

MVP：人工参与由**独立的 Human Approval 节点**表达（不是节点上的隐式开关），节点通过 `target { nodeKey, phase }` 关联被审批任务（见第 2 节）：
- before_execute：审批节点位于被审批任务上游，pending 期间不得创建该任务的 Execution
- after_execute：审批节点位于被审批任务下游，任务 succeeded 且 Artifact 版本落库后才发起审批

后续版本扩展（不进 MVP）：
- duringExecute：执行中检查点
- requireInput：等待人工输入
- allowTakeover：人工接管
- manualRouting：人工选择下游分支

审批决策（MVP 全集）：approve / request_changes / reject（行为见第 2 节 HumanApproval）。

所有审批关联到 NodeRun 和具体 ArtifactVersion（若有），并保存意见、决策人、时间和结果。审批操作必须幂等：对已进入终态的 Approval 重复提交决策返回定义错误且不产生任何状态迁移、不重复触发返工。

## 6. 依赖与调度规则

节点启动前必须满足：
- 所有 required predecessor 满足条件。
- 所属 BranchRun 为 active。
- 所属 WorkflowRun 为 running。
- 人工执行前门禁已通过。
- Agent/Provider 可用。
- Agent 并发限制未超。
- 工作目录锁/资源锁允许。
- 所需输入 Artifact 可用且版本明确。

调度器只将状态从 blocked 推进到 ready；启动器再根据资源和权限决定是否执行。

## 7. 示例流程：产品研发

```text
Start
  |
AgentTask: Product Manager — PRD
  |
ParallelSplit
  |--------------------------------------|
  |                                      |
AgentTask: UI Design            AgentTask: Backend Dev
  |                                      |
HumanApproval (after_execute, UI V1)     Artifact: Backend API
  |  approve → 继续当前分支               |
  |  request_changes → ReworkRequest     |
  |    （返工后重新进入本审批节点）          |
  |                                      |
AgentTask: Frontend Dev（approve 后才启动） |
  |                                      |
  |--------------------------------------|
                  |
        Join(all_success)
                  |
        AgentTask: Testing（输出结构化测试结果）
                  |
        Condition（测试结果 pass/fail）
          | pass                    | fail
          v                         v
   AgentTask: Product        ReworkRequest（引擎内建，
   Acceptance                只返工失败任务；完成后自动重测；
          |                  超 2 轮暂停分支转人工）
   HumanApproval (Final)
          |
        End
```

注意：
- UI Design 和 Backend Dev 在 PRD 完成后并行。
- UI 审批只阻塞 UI 分支；Backend Dev 不等待 UI 审批。
- Frontend Dev 在 UI 审批 approve 前必须保持 blocked。
- UI V1→V2 的修改循环由 request_changes + ReworkRequest 承载，不使用画布回边。
- Testing 等待前端与后端均成功（Join all_success）。
- 测试失败由引擎创建 ReworkRequest（非画布路由）；只返工失败任务；返工完成自动重测；超过 2 轮暂停分支转人工。
- 产品验收后仍需用户最终审批（HumanApproval after_execute）。

## 8. 事件与可靠性

每次状态迁移写入 WorkflowEvent。事件应具有唯一 eventId，以支持幂等处理。

核心事件包括：
- workflow.started / paused / resumed / completed / failed
- branch.paused / branch.resumed / branch.completed
- node.ready / started / checkpoint / waiting_approval / succeeded / failed / cancelled
- approval.requested / approved / changes_requested / rejected / taken_over
- rework.requested / rework.started / rework.completed / rework.exhausted（超限）
- artifact.created / artifact.versioned
- execution.started / interrupted / exited / crashed

（版本归属：`checkpoint` 与 `taken_over` 事件随 Checkpoint（V1.1）/Human Takeover（V1.2）能力启用，MVP 不产生；其余事件 MVP 启用。）

## 9. 恢复规则

Core 启动后：
1. 读取未终结的 WorkflowRun。
2. 读取 BranchRun、NodeRun、Execution、ReworkRequest 状态。
3. 向 Daemon 查询执行句柄状态。
4. 按 executionId 对账。
5. 对确认仍运行的进程恢复事件订阅。
6. 对确认已结束的进程处理最终结果。
7. 对无法确认的状态标记 reconciliation_required。
8. 不可对不幂等任务盲目重跑。
9. 恢复 ReworkRequest 轮次统计与 pending 审批状态，不允许恢复后重复返工或重复审批。

## 10. 失败、重试与返工

两个不同层次的概念，不得混用：

### 10.1 NodeRun 级执行重试（retryPolicy）
- 每个 AgentTask 可定义 maxAttempts。
- 每次重试生成新的 NodeRun attempt 或明确的 attempt 记录，保留之前日志和产物。
- 重试必须说明输入 Artifact 版本。
- 外部副作用任务默认不自动重试，除非有幂等键或用户批准。

### 10.2 任务返工（ReworkRequest / ReworkPolicy，引擎内建，MVP 核心）
- 触发源：Human Approval 的 request_changes 决策（必填意见+关联返工任务），或测试节点结构化结果判定失败。
- ReworkRequest 状态机：requested → in_rework → completed（自动重测）｜cancelled（人工处理取消）｜exhausted（超限，分支已暂停转人工）。
- 轮次：按被返工任务统计 round（1 起），unique(被返工任务, round) 作为幂等键；持久化，重启后不得丢失或重复计数。
- 默认最多 2 轮（不含首次执行）；以每任务每轮一条 ReworkRequest 记账。
- 超限：暂停相关分支，写入 rework.exhausted 事件，进入人工处理；人工可选继续返工（重置轮次须显式授权并审计）、接管动作或终止。
- 范围：只返工明确失败的任务及其必要下游；无关成功任务不得重复执行。
- 完成后：自动重新触发测试（或回到触发返工的 Human Approval 节点重新审批）。
- 每轮保留：执行记录（新 attempt）、Artifact 版本、测试报告/审批意见，全部不可覆盖。
- 约束：任意图边不得形成无限循环；返工不得伪装成通用 Loop/Retry 节点；全程写入审计。
