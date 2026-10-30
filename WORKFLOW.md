# 工作流定义与执行语义

版本：V1.2（基于 v1.0.0 Development Baseline 的 D-017 修订）  
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
执行 Agent 任务。配置：
- agentId / assignment role
- taskPrompt
- inputArtifactRefs
- workingDirectoryPolicy
- permissionProfile
- outputContract（输出契约：经 Schema 验证的结构化输出要求；测试类任务必须含 pass/fail、失败原因、关联任务、影响范围、相关 Artifact 字段）
- completionCriteria
- timeout
- retryPolicy（NodeRun 级执行重试，maxAttempts；与任务返工 ReworkPolicy 是两个概念，见第 10 节）
- humanGates（MVP：beforeExecute / afterExecute 两种，经 Human Approval 原语实现）

### HumanApproval
等待用户决策。MVP 决策集合与行为（决策 D-015）：

| 决策 | 行为 |
|---|---|
| approve | 审批通过，当前分支继续 |
| reject | 审批不通过，当前分支暂停，**不自动返工**，等待用户后续决策 |
| request_changes | 要求修改，**必须填写修改意见**并关联返工任务（创建 ReworkRequest）；返工完成后重新进入本节点，形成新一轮审批记录 |

- beforeExecute 使用场景：approval 状态为 pending 期间，不得创建对应 AgentTask 的 Execution。
- afterExecute / ArtifactReview 使用场景：等待用户查看交付物并决策。
- request_changes 触发的返工遵守 ReworkPolicy 的轮次上限（默认 2 轮，不含首次）；超限暂停分支进入人工处理。
- 每轮审批生成独立 Approval 记录；历史决策不可被覆盖。
- MVP 不支持的其他决策（take_over、cancel）与多级审批策略为后续版本。

### Condition
对经过 Schema 验证的上下文进行条件判断。禁止执行任意 JavaScript/eval。条件语言采用受限表达式或预定义运算符。条件为真/假分别路由到预期后继；无匹配后继时节点进入 failed（不静默跳过）。MVP 典型用途：判断测试结果（pass/fail）以决定进入验收还是触发 ReworkRequest。

### ParallelSplit
创建多个逻辑分支。每个分支创建独立 BranchRun 或映射到已有 BranchRun。

### Join
等待指定上游分支/节点达到 Join Policy。

Join Policy：
- all_success：全部成功（MVP 实现）
- all_terminal：全部进入终态（后续版本）
- quorum：达到指定数量（后续版本）

Join 必须按配置策略等待，不可提前放行。

### End
结束当前工作流或分支。End 置 succeeded 后 WorkflowRun 进入 completed 并写入 workflow.completed 事件。

**后续版本节点**（不进 MVP，画布不提供）：HumanInput（V1.1）、HumanTakeover（V1.2）、Wait、RetryLoop、ArtifactReview（作为独立节点；MVP 中交付物审批经 HumanApproval 的 afterExecute 场景实现）。

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

MVP：任意节点可配置的人工门禁经 Human Approval 原语实现，支持：
- beforeExecute：启动前审批（pending 期间不得创建 Execution）
- afterExecute：执行后审批

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
HumanApproval (afterExecute, UI V1)     Artifact: Backend API
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
- 产品验收后仍需用户最终审批（HumanApproval afterExecute）。

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
