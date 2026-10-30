# 技术架构设计

版本：V1.1（修订版，基线冻结前）  
目标：macOS 本地桌面应用

## 1. 架构原则

1. 模块化单体优先，不在 V1 拆微服务。
2. Desktop、Core、Daemon 三层进程职责分离。
3. Desktop 不直接启动或管理 Agent CLI。
4. Core 是业务规则、工作流调度和持久化的权威来源。
5. Daemon 负责本地进程、PTY 和运行时生命周期。
6. 所有跨进程通信使用版本化协议和 Schema 校验。
7. 工作流引擎必须持久化，不能依赖前端内存状态。
8. Provider 能力必须显式声明；不支持的能力不能伪装。
9. 所有执行都限定在明确的工作目录和权限范围内。
10. 协议适配器不能反向侵入 Workflow Engine 业务逻辑。

## 2. 推荐技术栈

| 层 | 技术 | 备注 |
|---|---|---|
| Desktop | Electron | macOS 桌面外壳 |
| UI | React + TypeScript | Antumi 风格交互参考 |
| UI 组件 | Tailwind CSS + shadcn/ui | 可按仓库实际情况调整 |
| Workflow Canvas | React Flow | 画布、节点和连线 |
| Core | Node.js + TypeScript | 业务服务 |
| Daemon | Node.js + TypeScript | 进程宿主 |
| Database | SQLite | 本地持久化 |
| ORM | Drizzle | Schema/Migration |
| Validation | Zod | DTO、事件、配置校验 |
| Desktop-Core | WebSocket + JSON-RPC（或等价版本化 RPC） | 统一协议 |
| Core-Daemon | Unix Domain Socket + NDJSON/RPC | macOS 本地 IPC |
| Terminal | xterm.js + node-pty | 终端体验 |
| Git | Git CLI + Worktree | 隔离并行工作 |
| Tests | Vitest + Playwright | 单元、集成和 E2E |
| Package Manager | pnpm | Monorepo |

具体版本在初始化时选择当前稳定且相互兼容的版本，并锁定 lockfile；不要在文档中硬编码未经验证的版本号。

## 3. 三层进程职责

### 3.1 Desktop
负责：
- 导航、工作台、任务和聊天 UI。
- Agent/Team/Work 管理界面。
- 工作流画布和配置面板。
- 审批中心。
- 终端、文件和 Diff 展示。
- 通过 Core API 发起操作、订阅事件。

禁止：
- 直接 spawn Agent CLI。
- 直接写业务数据库（除非明确设计为只读/迁移工具；正常业务访问必须经过 Core）。
- 在前端自行推导并修改工作流真实状态。

### 3.2 Core
负责：
- AgentProfile、Team、Work、Assignment 等领域服务。
- Workflow Template/Version/Run 管理。
- 状态机、依赖计算、调度器。
- 人工审批、人工输入、人工接管。
- Artifact 管理和事件持久化。
- 权限校验、审计日志。
- 与 Daemon 通信并消费执行事件。
- 对 Desktop 提供版本化 RPC/API。

Core 是工作流运行状态的唯一权威写入者。

### 3.3 Daemon
负责：
- CLI Provider 启动、停止、状态采集。
- PTY 和终端会话。
- stdout/stderr/structured events 采集。
- 进程退出、崩溃和孤儿进程检测。
- Provider 能力探测。
- 运行时恢复协调。
- 通过 IPC 向 Core 汇报事件。

Daemon 不决定工作流下游节点是否启动；它只报告执行事实。Core 决定工作流状态迁移。

## 4. 模块边界

Core 建议模块：
- agent
- runtime-registry
- team
- work
- assignment
- task
- workflow-definition
- workflow-runtime
- scheduler
- approval
- rework（ReworkRequest/ReworkPolicy：引擎内建返工调度，见 WORKFLOW §10）
- artifact
- worktree
- backup（备份与恢复：WAL 一致性备份、Manifest、恢复预检/回滚）
- event
- audit
- database
- rpc

Packages 建议：
- protocol：RPC DTO、事件 Schema、版本
- domain-types：共享领域类型
- workflow-schema：工作流定义与验证
- runtime-sdk：统一运行时接口
- runtime-cli：CLI Provider
- runtime-acp：未来 ACP Provider
- protocol-mcp：MCP 工具接入
- protocol-a2a：未来 A2A 接入
- ui：共享 UI 组件

## 5. Agent Runtime 抽象

建议接口（示意，实施时补充严格类型和错误模型）：

```ts
interface RuntimeProvider {
  id: string;
  discover(): Promise<RuntimeInfo[]>;
  inspect(config: RuntimeConfig): Promise<RuntimeHealth>;
  start(config: StartExecutionConfig): Promise<ExecutionHandle>;
  sendMessage(executionId: string, message: RuntimeMessage): Promise<void>;
  interrupt(executionId: string): Promise<InterruptResult>;
  resume(executionId: string, checkpoint?: string): Promise<ExecutionHandle>;
  cancel(executionId: string): Promise<void>;
  getStatus(executionId: string): Promise<ExecutionStatus>;
  subscribe(executionId: string, listener: RuntimeEventListener): Unsubscribe;
}
```

Provider 应声明 capabilities：
- streaming
- structuredEvents
- interrupt
- resume
- checkpoint
- permissionRequests
- sessionPersistence
- workingDirectory
- toolControl

能力状态应至少区分：
- native：原生支持
- emulated：由适配器模拟/降级
- unsupported：不支持

禁止把“停止后重新启动”标记成“原生恢复”。

## 6. 协议职责边界

- CLI：本地命令行进程接入方式。
- ACP：Agent 与客户端/宿主之间的交互协议，是否可用取决于具体 Agent 实现。
- MCP：模型/Agent 使用工具和资源的协议，不是工作流调度协议。
- A2A：Agent 间发现、任务委派和协作通信协议，不替代本地进程宿主。
- 内部 Workflow API：系统自己的工作流状态、任务依赖和人工审批协议。

第一版以内部 Workflow API + CLI Provider 为主。MCP/A2A/ACP 先定义边界，不要求同时落地。

## 7. RPC 与事件

所有 RPC 请求包含：
- requestId
- protocolVersion
- method
- params

所有事件包含：
- eventId
- protocolVersion
- eventType
- occurredAt
- aggregateType
- aggregateId
- payload
- correlationId
- causationId（可选）

事件必须支持去重。Core 收到 Daemon 重复事件时不得重复推进节点。

建议事件：
- runtime.execution.started
- runtime.execution.output
- runtime.execution.permission_requested
- runtime.execution.completed
- runtime.execution.failed
- runtime.execution.interrupted
- workflow.node.ready
- workflow.node.started
- workflow.node.completed
- workflow.node.failed
- workflow.branch.paused
- workflow.branch.resumed
- approval.requested
- approval.decided
- artifact.created

## 8. 工作流执行与事务边界

关键顺序：
1. Core 在事务中创建 NodeRun/Execution 记录并标记启动意图。
2. Core 请求 Daemon 启动进程。
3. Daemon 返回运行句柄和实际启动结果。
4. Core 持久化结果并更新状态。
5. Daemon 发送执行事件，Core 去重后处理。
6. Core 在事务中保存 NodeRun 结果、Artifact 引用和 WorkflowEvent。
7. 提交事务后才调度下游节点。

不得在数据库事务未提交时就向下游发送“已完成”事件。

### 审批服务与 Workflow Engine 的交互
- beforeExecute 门禁：Approval pending 期间引擎不得创建对应 AgentTask 的 Execution。
- 审批决策（approve/request_changes/reject）由 approval 模块接收、校验幂等后，事务内写入 Approval 终态并通知 workflow-runtime。
- request_changes：同一事务内创建 ReworkRequest（trigger_type=request_changes，含必填意见与关联返工任务）；返工完成后引擎将流程引导回原 Human Approval 节点进入下一轮审批（round+1）。
- reject：分支暂停，不自动返工，等待用户后续决策。
- 审批服务不直接修改 NodeRun/BranchRun 状态；状态迁移全部经引擎状态机。

### 返工调度（ReworkPolicy）
- workflow-runtime 内的 rework 职责：接收触发源（request_changes / 测试结构化失败结果）、按幂等键创建 ReworkRequest、调度被返工任务的新 attempt、完成后自动重测、轮次统计与超限（暂停分支转人工）。
- 返工轮次持久化于 rework_requests 表，重启后恢复且不得重复计数。

## 9. 崩溃恢复

启动时：
- Core 检查未终结的 WorkflowRun、BranchRun、NodeRun 和 Execution。
- Daemon 扫描自己管理的进程/会话。
- Core 与 Daemon 按 executionId 对账。
- 能恢复的会话恢复订阅。
- 无法确认状态的执行标记为 `reconciliation_required`，不要自动重复执行可能有副作用的任务。
- 由恢复策略或用户决定重试、接管或标记失败。

## 10. 文件与工作区

建议数据根目录可配置，默认放在用户 Library/Application Support 下，避免把应用资源目录当数据目录。

建议分层：
- app-data：SQLite、配置、日志。
- workspaces：Work 项目目录。
- artifacts：归档交付物或引用。
- backups：备份包（manifest.json + database.db + artifacts/；见 DATABASE §2.10）。
- runtime：临时 socket、pid、状态文件。

每个 Work 使用独立目录。并行代码任务优先使用 Git Worktree；非 Git 项目使用独立子目录或显式互斥锁。

## 11. 安全模型

- Electron renderer 开启 contextIsolation，禁用不必要的 Node 集成。
- Preload 暴露最小白名单 API。
- Core/Daemon IPC 限制本机用户权限，校验消息来源。
- Provider 启动参数使用参数数组，不拼接 shell 字符串。
- 默认限制 Agent 的工作目录和文件权限。
- 高风险工具操作需审批策略。
- 凭据不写入日志、工作流定义或普通数据库明文。
- Agent 输出是非可信数据，不得作为系统指令执行。
- 所有文件路径规范化并检查是否越过允许目录。
- 审计权限请求、批准、拒绝和执行结果。

## 12. 可观测性

每条日志和事件尽量带：
- workId
- workflowRunId
- branchRunId
- nodeRunId
- agentId
- assignmentId
- executionId
- correlationId

日志应支持结构化存储和按关联 ID 查询。敏感内容需脱敏。

## 13. 测试策略

- 单元测试：状态机、依赖判断、条件表达式、权限校验、ReworkPolicy 轮次统计与幂等键。
- 集成测试：Core-DB、Core-Daemon IPC、Runtime Provider。
- E2E：创建 Work、运行工作流、人工审批、暂停分支。
- 故障测试：Core 重启、Daemon 重启、CLI 崩溃、重复事件、ReworkRequest 恢复（轮次不丢不重）。
- 备份专项：WAL 并发写入时的一致性备份、备份损坏检测、恢复失败回滚、恢复后完整性复查与副作用防重。
- 安全测试：路径穿越、命令注入、未经授权的工具调用。
