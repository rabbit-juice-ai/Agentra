# 开发计划与任务清单

版本：V1.0  
开发策略：小步迭代、每阶段可运行、每阶段可验收

## 阶段 0：仓库与环境检查、Monorepo 骨架

### 任务
- [ ] 检查 macOS、Node.js、pnpm、Git、目标 CLI 环境。
- [ ] 检查现有仓库和用户文件。
- [ ] 初始化 pnpm workspace（如仓库尚未初始化）。
- [ ] 建立 apps/desktop、apps/core、apps/daemon。
- [ ] 建立 packages/protocol、packages/shared。
- [ ] 配置 TypeScript strict、lint、format、test。
- [ ] 建立 docs 和基础 README。
- [ ] 建立最小 Electron + React 窗口。
- [ ] 建立 Core 健康检查服务。
- [ ] 建立 Daemon 健康检查服务。
- [ ] Desktop 能通过 IPC/RPC 读取 Core 健康状态。

### 验收
- Mac 可启动桌面应用。
- Core 和 Daemon 是独立进程。
- Desktop 能显示 Core/Daemon 状态。
- 关闭 Desktop 不会错误终止 Core/Daemon。
- 类型检查、lint、基础测试通过。

## 阶段 1：数据库和 Agent Runtime

### 任务
- [ ] SQLite 初始化和 Migration 机制。
- [ ] 实现 AgentProfile CRUD。
- [ ] 实现 RuntimeProvider Registry。
- [ ] CLI 自动发现（先实现一个 Provider，再扩展第二个）。
- [ ] 展示 CLI 路径、版本、可执行性和健康状态。
- [ ] 定义 Runtime SDK。
- [ ] 启动 Agent 进程。
- [ ] 收集 stdout/stderr/结构化事件。
- [ ] 支持发送消息（按 Provider 能力）。
- [ ] 支持 cancel/interrupt。
- [ ] 保存 Session 和 Execution。
- [ ] UI 展示实时输出和执行状态。

### 验收
- 创建两个 Agent Profile。
- 至少成功接入并验证一个本地 CLI。
- 能启动任务、看到输出、完成和取消。
- 进程异常退出可被识别。
- 不支持的能力有明确标识。

## 阶段 2：Team、Work、Assignment 和工作区

### 任务
- [ ] Team CRUD。
- [ ] TeamMember 管理。
- [ ] Work CRUD。
- [ ] WorkTeam 关联。
- [ ] Assignment 创建/暂停/完成。
- [ ] Agent Session 绑定 Assignment。
- [ ] Work 独立工作目录。
- [ ] Git Worktree 创建/列举/清理（清理必须确认）。
- [ ] Agent 并发限制。
- [ ] 工作目录锁和冲突检测。

### 验收
- 一个 Team 同时参与两个 Work。
- 一个 Agent 参与两个 Work。
- 两个 Work 的会话、文件和工作目录隔离。
- 并发冲突能阻止危险的重复写入或给出明确提示。

## 阶段 3：Workflow Definition 与设计器

### 任务
- [ ] Workflow Schema + Zod 校验。
- [ ] Workflow Template CRUD。
- [ ] Workflow Version draft/publish。
- [ ] React Flow 画布。
- [ ] AgentTask 节点。
- [ ] HumanApproval 节点。
- [ ] HumanInput 节点。
- [ ] ParallelSplit 节点。
- [ ] Join 节点。
- [ ] Condition 节点。
- [ ] End 节点。
- [ ] 节点配置面板。
- [ ] 连线和依赖校验。
- [ ] 保存、复制、版本发布。
- [ ] 画布导入/导出定义 JSON。

### 验收
- 用户能设计并保存“PRD → UI/后端并行 → UI 审批 → 前端 → Join → 测试”的流程。
- 无效图（缺少入口、断裂依赖、循环不合法等）不能发布。
- 发布版本不可原地修改。

## 阶段 4：Workflow Engine 和分支调度

### 任务
- [ ] WorkflowRun 创建。
- [ ] BranchRun 创建与状态机。
- [ ] NodeRun 创建与状态机。
- [ ] DAG 依赖计算。
- [ ] Ready Queue。
- [ ] Agent 并发调度。
- [ ] ParallelSplit 执行。
- [ ] Join(all_success) 执行。
- [ ] 分支独立暂停。
- [ ] 分支恢复和依赖重算。
- [ ] 执行器中断降级策略。
- [ ] 事件去重。
- [ ] Core 重启恢复和 Daemon 对账。
- [ ] 失败与有限重试。

### 验收
- UI 分支暂停时后端分支继续运行。
- UI 审批未通过时前端不启动。
- Join 等待 UI 前端与后端都完成。
- 重启 Core 后状态可恢复或明确进入待核对状态。
- 不会因重复事件重复启动同一个节点。

## 阶段 5：人工协作和交付物

### 任务
- [ ] Approval 请求和决策 API。
- [ ] 审批中心 UI。
- [ ] Before Execute 门禁。
- [ ] During Execute checkpoint。
- [ ] After Execute 审批。
- [ ] Request Changes 回退路径。
- [ ] Reject 路径。
- [ ] Human Input。
- [ ] Human Takeover。
- [ ] Artifact 创建和版本化。
- [ ] Artifact 预览和下载/打开。
- [ ] Artifact Review。
- [ ] 审计日志。
- [ ] 通知和待处理事项。

### 验收
- UI V1 被要求修改。
- UI V2 重新提交。
- 用户批准 V2。
- 前端随后启动。
- 两个版本和全部审批意见保留。

## 阶段 6：真实项目 MVP E2E

### 任务
- [ ] 建立产品研发模板。
- [ ] 建立五个示例 Agent Profile。
- [ ] 创建示例 Team 和 Work。
- [ ] 执行 PRD → UI/Backend 并行。
- [ ] UI 审批和返工。
- [ ] 后端独立交付。
- [ ] UI 批准后前端启动。
- [ ] 前后端 Join。
- [ ] 测试执行和失败返工。
- [ ] 产品经理验收。
- [ ] 用户最终审批。
- [ ] 关闭/重启应用恢复测试。
- [ ] 编写用户操作说明。

### 验收
完整通过 PRD 中的 MVP 验收场景。

## 阶段 7：协议扩展（非 MVP 阻塞项）

- [ ] 评估 ACP 的具体 Provider 兼容性。
- [ ] MCP Client/Server 工具接入。
- [ ] A2A Agent Card/Task/Message 适配。
- [ ] 协议身份、权限和信任边界。
- [ ] 外部 Agent 超时、重试和取消策略。
- [ ] 协议能力测试套件。

不得为了协议完整性延迟核心本地 CLI + Workflow MVP。

## 阶段 8：Antumi 风格交互完善

- [ ] 左侧导航和工作区布局。
- [ ] 工作/任务看板。
- [ ] Agent 对话和任务详情。
- [ ] 右侧 Inspector。
- [ ] 终端面板。
- [ ] 文件树和 Diff。
- [ ] 分屏和快捷键。
- [ ] 全局搜索。
- [ ] 实时活动时间线。
- [ ] 深色/浅色主题（按设计优先级）。

## 每个任务的 Definition of Done

- [ ] 满足需求和验收标准。
- [ ] 类型检查通过。
- [ ] 相关测试通过。
- [ ] 没有明显安全回归。
- [ ] 数据库 Migration 已提供（如需要）。
- [ ] 日志和错误处理清楚。
- [ ] 文档已更新。
- [ ] 交付说明列出实际测试命令和结果。
