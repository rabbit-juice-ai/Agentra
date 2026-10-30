# 工作流定义与执行语义

版本：V1.0  
本文件是 Workflow Engine 的规范性要求。

## 1. 核心模型

工作流是一个有向图（DAG 为基础），由节点、边、分支和运行实例构成。V1 的循环通过显式 Retry/Loop 节点实现，不能允许任意图循环造成无限执行。

- WorkflowTemplate：可复用模板。
- WorkflowVersion：不可变发布版本。
- WorkflowRun：一次运行。
- BranchRun：分支运行状态。
- NodeRun：节点执行实例。
- Approval：人工决策实例。

## 2. 节点类型

### AgentTask
执行 Agent 任务。配置：
- agentId / assignment role
- taskPrompt
- inputArtifactRefs
- workingDirectoryPolicy
- permissionProfile
- outputContract
- completionCriteria
- timeout
- retryPolicy
- humanGates

### HumanApproval
等待用户批准、要求修改、拒绝或接管。

### HumanInput
等待用户提交文字、参数或文件。

### HumanTakeover
将任务交给用户手动处理；用户提交结果后恢复流程。

### Condition
对经过 Schema 验证的上下文进行条件判断。禁止执行任意 JavaScript/eval。条件语言应采用受限表达式或预定义运算符。

### ParallelSplit
创建多个逻辑分支。每个分支创建独立 BranchRun 或映射到已有 BranchRun。

### Join
等待指定上游分支/节点达到 Join Policy。

Join Policy：
- all_success：全部成功
- all_terminal：全部进入终态
- quorum：达到指定数量（后续版本）
V1 建议先实现 all_success。

### Wait
等待明确事件、人工输入或外部条件。定时等待可后续实现。

### RetryLoop
在最大次数和允许的目标节点范围内重试。必须保留每次 NodeRun attempt 历史。

### ArtifactReview
对指定 ArtifactVersion 执行审批。

### End
结束当前工作流或分支。

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

## 5. 人工参与配置

任意节点可配置：
- beforeExecute：启动前审批
- duringExecute：执行中检查点
- afterExecute：执行后审批
- requireInput：等待人工输入
- allowTakeover：允许人工接管
- manualRouting：人工选择下游分支

审批决策：
- approve：放行
- request_changes：要求修改并回到指定节点/路径
- reject：拒绝并按拒绝路径处理
- take_over：交给人处理
- cancel：取消当前审批请求（需权限）

所有审批关联到 NodeRun 和具体 ArtifactVersion（若有），并保存意见和时间。

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
Product Manager: PRD
  |
Parallel Split
  |-----------------------------|
  |                             |
UI Design                    Backend Dev
  |                             |
Artifact V1                    Backend Artifact
  |
Human Approval
  | approved
  v
Frontend Dev
  |                             |
  |-----------------------------|
                |
          Join(all_success)
                |
             Testing
                |
       Condition(test result)
          | pass      | fail
          v           v
       Product     Route to responsible
       Acceptance  Frontend/Backend/Product
          |
      Human Final Approval
          |
          End
```

注意：
- UI Design 和 Backend Dev 在 PRD 完成后并行。
- UI 审批只阻塞 UI 分支的 Frontend Dev。
- Backend Dev 不等待 UI 审批。
- Frontend Dev 在 UI 审批通过前必须保持 blocked。
- Testing 等待前端与后端均成功。
- 测试失败根据报告路由返工，重试次数有限；超过上限升级给用户。
- 产品验收后仍需用户最终审批。

## 8. 事件与可靠性

每次状态迁移写入 WorkflowEvent。事件应具有唯一 eventId，以支持幂等处理。

核心事件包括：
- workflow.started / paused / resumed / completed / failed
- branch.paused / branch.resumed / branch.completed
- node.ready / started / checkpoint / waiting_approval / succeeded / failed / cancelled
- approval.requested / approved / changes_requested / rejected / taken_over
- artifact.created / artifact.versioned
- execution.started / interrupted / exited / crashed

## 9. 恢复规则

Core 启动后：
1. 读取未终结的 WorkflowRun。
2. 读取 BranchRun、NodeRun、Execution 状态。
3. 向 Daemon 查询执行句柄状态。
4. 按 executionId 对账。
5. 对确认仍运行的进程恢复事件订阅。
6. 对确认已结束的进程处理最终结果。
7. 对无法确认的状态标记 reconciliation_required。
8. 不可对不幂等任务盲目重跑。

## 10. 失败与重试

- 每个 AgentTask 可定义 maxAttempts。
- 每次重试生成新的 NodeRun attempt 或明确的 attempt 记录，保留之前日志和产物。
- 重试必须说明输入 Artifact 版本。
- 超出重试次数后走人工升级路径。
- 外部副作用任务默认不自动重试，除非有幂等键或用户批准。
