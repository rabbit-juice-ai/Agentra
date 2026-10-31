# 技术架构设计

版本：V1.3（基于 v1.0.0 Development Baseline 的 D-016～D-023 修订）  
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
| 数据访问 | node:sqlite（Node 内置）+ Repository/DAL | 无 ORM；迁移用 PRAGMA user_version；Core 统一访问（D-016） |
| Validation | Zod | DTO、事件、配置校验 |
| Desktop-Core | WebSocket + JSON-RPC（或等价版本化 RPC） | 统一协议 |
| Core-Daemon | Unix Domain Socket + NDJSON/RPC | macOS 本地 IPC |
| Terminal | xterm.js + node-pty | 终端体验 |
| Git | Git CLI + Worktree | 隔离并行工作 |
| Tests | Vitest + Playwright | 单元、集成和 E2E |
| Package Manager | pnpm | Monorepo |

具体版本在初始化时选择当前稳定且相互兼容的版本，并锁定 lockfile；不要在文档中硬编码未经验证的版本号。

**运行时基线（Agentra 实测，2026-10-30；裁定 D-017）**：生产 Core 经 `ELECTRON_RUN_AS_NODE` 运行于锁定版本的 Electron，不单独假设 Node 版本；版本对应关系：**Electron 45.1.0 ↔ 内置 Node 24.22.1**（实测）。`ELECTRON_RUN_AS_NODE=1` 模式下 node:sqlite 建表、参数化写入、WAL、`VACUUM INTO` 备份、`PRAGMA integrity_check` 全部通过；本次实测未观察到 ExperimentalWarning，但不推定其他 Node 24 / Electron 版本或打包态行为。开发/测试最低 Node ≥ 22.13（实测 22.23.2；Node 22 下有 ExperimentalWarning，不强制升级 Node 24）。验证分层：阶段 1 当前 Electron 运行环境的 SQLite 基本集成验证；阶段 5.5 备份恢复完整 8 项验收（VACUUM INTO 快照验证不能代替）；阶段 6 完整打包态复验。

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
- 统一 Repository/Data Access Layer：所有业务数据库读写经 Core；Daemon 不访问业务数据库（决策 D-016）。

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

Packages 建议（状态列区分已落地包与规划包；新增包须在此登记，已废弃包保留行并标注原因）：

| 包 | 职责 | 状态 |
|---|---|---|
| `shared` | 数据根目录与路径、结构化日志、ID 生成等基础工具 | 已实现 |
| `protocol` | RPC DTO、事件 Schema、版本 | 已实现 |
| `runtime-sdk` | 统一运行时接口与能力模型 | 已实现 |
| `runtime-cli` | CLI Provider（当前为 Claude Code） | 已实现 |
| `domain-types` | 共享领域类型 | 计划中（未排期；当前共享类型由 `protocol` 的 DTO 承担） |
| `workflow-schema` | 工作流定义与验证 | 计划中（阶段 3） |
| `runtime-acp` | ACP Provider | 计划中（阶段 7） |
| `protocol-mcp` | MCP 工具接入 | 计划中（阶段 7） |
| `protocol-a2a` | A2A 接入 | 计划中（阶段 7） |
| `ui` | 共享 UI 组件 | 计划中（阶段 3 起按需抽取） |

依赖声明须与代码实际引用一致：仅用于 workspace 链接或构建顺序、代码中并不 import 的包列入 `devDependencies`（例如 Core 对 `@agentra/daemon`——Core 通过文件路径拉起 Daemon，不引用其代码）；测试运行所需的工具必须在被测包自身声明（例如 desktop 的 `vitest`），不得依赖根目录的提升。

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

**能力声明口径（阶段 1 修订）**：capabilities 描述**当前适配器可被调用方使用的能力**，不是底层 CLI 的原始能力。声明 `native` / `emulated` 必须有可执行实现路径；声明 `unsupported` 的能力不得提供可用路径，调用必须返回 `CAPABILITY_UNSUPPORTED` 且不改变执行状态。该不变式由能力一致性测试守护（`packages/runtime-cli/src/capabilities-consistency.test.ts`），声明与实现锚点必须一一对应。

**类型归属（阶段 1 修订）**：`packages/runtime-sdk` 是运行时类型的**唯一来源**——`RuntimeInfo`、`RuntimeProvider` 接口与能力模型均在 SDK 定义；`packages/protocol` 只做 Zod schema 包装并保留编译期护栏（`satisfies`），不得重定义同一形状。持久化的 Provider 记录在 protocol 中命名为 `RuntimeProviderRecord`，与 SDK 的 `RuntimeProvider` 接口区分。

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

**命名分层说明（Minor 处理，D-017）**：本节事件名为**协议层**命名（RPC/事件信封，供跨进程传输与去重）；WORKFLOW.md §8 的事件清单为**领域语义层**（面向业务状态）。两套命名在 `packages/protocol` 中集中定义映射，例如 `approval.decided`（协议层，带 decision 字段）对应 `approval.approved / approval.changes_requested / approval.rejected`（领域层）；`workflow.node.completed` 对应 `node.succeeded`。实现时以协议层 schema 为准，领域事件由 Core 在写入 workflow_events 时派生。

### 7.1 错误码与协议版本（阶段 1 修订）

- **错误码唯一来源**为 `packages/protocol/src/envelope.ts` 的 `RpcErrorCode`，共 14 个：`PARSE_ERROR`、`INVALID_PARAMS`、`METHOD_NOT_FOUND`、`VERSION_MISMATCH`、`NOT_READY`、`INTERNAL`、`CLI_UNAVAILABLE`、`CLI_NOT_AUTHENTICATED`、`CAPABILITY_UNSUPPORTED`、`EXECUTION_NOT_FOUND`、`AGENT_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`AGENT_TOOLS_NOT_CONFIGURED`（U3：Agent 的 allow 为空时启动执行返回该码且不创建 Execution）、`WORKDIR_LOCKED`（阶段 2：两个 Work 争用同一非 Worktree 目录时返回；B2 先声明，行为在 B3 工作目录锁生效）。
- **适配器错误码必须先映射再跨进程**：Runtime SDK 的 `RuntimeErrorCode` 与协议错误码同名，但 SDK 多出的 `RUNTIME_ERROR` 在协议层没有对应值，统一映射为 `INTERNAL` 并保留原始 message；不为此扩展协议枚举。
- **协议版本号唯一来源**为 `PROTOCOL_VERSION`（`packages/protocol/src/version.ts`），禁止字面量。RPC 信封、健康响应与 Core/Daemon 的 pid 文件均引用该常量；健康响应的 `protocolVersion` 以字面量类型校验，版本不匹配的响应必须被拒绝而不是宽松接受。

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

**Git Worktree（阶段 2 落地）**
- 创建：在 `works.repository_path` 上执行 `git worktree add -b <branch> <path>`，工作树落在 Agentra 数据目录的 `worktrees/<workId>/<branch>`，不往用户仓库里写文件。
- 记录：`worktrees` 表保留 work、assignment、分支、`base_commit` 与状态；清理后置 `removed` + `removed_at`，不物理删行。
- 清理必须显式确认：API 要求 `confirm=true`，未确认直接拒绝且无副作用；UI 提供二次确认。

**工作目录锁（阶段 2 落地）**
- 键是**实际工作目录的绝对路径**（`path.resolve` 后），不是 Work id —— 两个 Work 指向同一非 Worktree 目录时必须冲突，Worktree 各自独立目录则天然不冲突。
- 运行态存于 `workdir_locks` 表；执行启动前获取，执行进入终态（exited / cancel / 对账判 crashed / 启动失败）时按 execution_id 释放。
- 冲突返回 `WORKDIR_LOCKED`，且**不创建 Execution**。
- 回收：行内记 `holder_pid` 与 `boot_id`（开机身份）。跨开机无条件回收（pid 会被复用，只判 pid 存活会永久锁死目录）；同一次开机内按 pid 存活判定。

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
- **执行工作目录的根集合边界（阶段 2）**：Core 在启动执行时声明 `allowedRoots`（scratch 根、worktrees 根、`works.root_path`），Daemon 校验实际工作目录必须落在这些根之内，并在创建目录前先做 `realpath`（含最近已存在祖先）判定，挡住符号链接逃逸；目录创建后再 `realpath` 复核一次。该检查只约束「Core 把执行放到哪个目录」，**不是文件系统沙箱**——Agent 进程本身仍可访问其他目录。

**工具权限最小模型（U3，阶段 1 收尾）**：
- 权限配置存于 `agent_profiles.tool_permissions_json`（`{version:1, allow[], deny[]}`），不建独立权限表；`deny` 优先于 `allow`，同一工具不得同时出现在两个清单，冲突在写入时拒绝。
- **空 `allow` = 未配置 = 拒绝执行**：`execution.start` 返回 `AGENT_TOOLS_NOT_CONFIGURED` 且不创建 Execution。既有 Agent 升级后未配置时同样拒绝，不得默认全开。
- **强制点在 Core**：Core 读取 Agent 配置后随启动参数传给 Daemon，Daemon 原样转成 CLI 参数；UI 只负责展示，不作为权限判定依据。
- **`dontAsk` 的含义**：`--permission-mode dontAsk` 只表示 CLI 不弹出权限询问，**不代表工具默认获准**；实际授权范围完全由 allow / deny 决定，本版本不呈现 CLI 的权限请求（阶段 5 引入）。
- 每次启动把生效策略写入 `execution_logs` 的 `execution.tool_policy` 系统日志（不新增表或列），供审计与排障。

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

**日志文件的写入权归启动方**：Core 与 Daemon 分别由各自的 launcher 以 stdio 重定向写入 `<role>.log`，logger 本身只写 stderr。两处同时写同一文件会让每行重复，禁止；在前台直接运行（`pnpm dev:*`）时日志落在终端，这是期望行为。

## 13. 测试策略

- 单元测试：状态机、依赖判断、条件表达式、权限校验、ReworkPolicy 轮次统计与幂等键。
- 集成测试：Core-DB、Core-Daemon IPC、Runtime Provider。
- E2E：创建 Work、运行工作流、人工审批、暂停分支。
- 故障测试：Core 重启、Daemon 重启、CLI 崩溃、重复事件、ReworkRequest 恢复（轮次不丢不重）。
- 备份专项：WAL 并发写入时的一致性备份、备份损坏检测、恢复失败回滚、恢复后完整性复查与副作用防重。
- 安全测试：路径穿越、命令注入、未经授权的工具调用。
