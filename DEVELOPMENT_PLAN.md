# 开发计划与任务清单

版本：V1.2（基于 v1.0.0 Development Baseline 的 D-016 修订）  
开发策略：小步迭代、每阶段可运行、每阶段可验收  
前置：阶段「产品文档修订与基线冻结」完成并经用户批准后，才进入阶段 0 及后续业务开发。

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
- 关闭 Desktop 窗口 30 秒后，Core 与 Daemon 进程 PID 不变且健康检查 RPC 返回成功。
- 类型检查、lint、基础测试通过。

## 阶段 1：数据库和 Agent Runtime

### 任务
- [ ] SQLite 初始化和 Migration 机制（node:sqlite + `PRAGMA user_version` 版本化迁移 + Core 统一 Repository/DAL，决策 D-016）。
- [ ] 实现 AgentProfile CRUD。
- [ ] 实现 RuntimeProvider Registry。
- [ ] CLI 自动发现（先实现 Claude Code Provider，验证后再扩展 Codex）。
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
- 通过已接入 Provider 启动最小任务：executions 记录 started→succeeded、exit_code=0、execution_logs 捕获 ≥1 条 stdout；UI 显示的路径/版本/健康状态与 runtime_providers 表一致。
- 能启动任务、看到输出、完成和取消。
- kill -9 执行进程后 10 秒内 executions.status 变为 failed/crashed，并写入 execution exited/crashed 事件。
- capabilities_json 中不支持能力值=unsupported；对 unsupported 的 interrupt 发起请求必须返回定义的错误码且不改变 Execution 状态。

## 阶段 2：Team、Work、Assignment 和工作区

### 任务
- [ ] Team CRUD。
- [ ] TeamMember 管理。
- [ ] Work CRUD。
- [ ] WorkTeam 关联。
- [ ] Assignment 创建/暂停/完成。
- [ ] Work 级暂停/恢复（暂停后所有分支不再启动新 NodeRun，语义见 WORKFLOW §4）。
- [ ] Work 级终止（终态不可逆：未终结 WorkflowRun 置 cancelled、运行中 Execution 按取消策略停止、pending 审批置 cancelled——系统取消路径；需用户确认并写审计）。
- [ ] Agent Session 绑定 Assignment。
- [ ] Work 独立工作目录。
- [ ] Git Worktree 创建/列举/清理（清理必须确认）。
- [ ] Agent 并发限制。
- [ ] 工作目录锁和冲突检测。

### 验收
- 一个 Team 同时参与两个 Work。
- 一个 Agent 参与两个 Work。
- 两个 Work 的会话、文件和工作目录隔离。
- 同一 Agent 达到 max_concurrency 时第二个任务进入排队且不启动进程；上限释放后自动调度。
- 两个 Work 指向同一非 Worktree 目录时第二次启动返回 WORKDIR_LOCKED；Worktree 隔离时不阻塞（对应 PRD 并发冲突产品行为）。

## 阶段 3：Workflow Definition 与设计器

### 任务
- [ ] Workflow Schema + Zod 校验（节点类型白名单：Start、AgentTask、ParallelSplit、Join、HumanApproval、Condition、End 共 7 种）。
- [ ] Start 节点定义（唯一入口校验）。
- [ ] Workflow Template CRUD。
- [ ] Workflow Version draft/publish。
- [ ] React Flow 画布。
- [ ] AgentTask 节点。
- [ ] HumanApproval 节点。
- [ ] ParallelSplit 节点。
- [ ] Join 节点。
- [ ] Condition 节点。
- [ ] End 节点。
- [ ] 节点配置面板。
- [ ] 连线和依赖校验。
- [ ] 保存、复制、版本发布。
- [ ] 画布导入/导出定义 JSON。

### 验收
- 在画布上仅使用 7 种 MVP 节点搭建 "Start→AgentTask(PRD)→ParallelSplit→UI/后端→HumanApproval→Frontend→Join(all_success)→Testing→Condition→End" 模板；保存后 definition_json 通过 Zod 校验且节点/边数量与图一致；publish 成功生成 workflow_versions 记录。
- 以下三类无效图发布必须被拒绝并返回定义的错误码：(1) 无 Start 入口或多个 Start；(2) 存在入度为 0 的非 Start 节点；(3) 存在有向环。
- definition_json 含未知节点类型时发布被拒绝并返回 UNKNOWN_NODE_TYPE；画布节点面板仅提供 7 种 MVP 节点。
- 发布版本不可原地修改（修改已发布模板强制生成新版本）。
- Condition 节点条件表达式含任意 JS 时被 Zod 校验拒绝（禁 eval）。

## 阶段 4：Workflow Engine、分支调度与返工

### 任务
- [ ] WorkflowRun 创建。
- [ ] BranchRun 创建与状态机。
- [ ] NodeRun 创建与状态机。
- [ ] DAG 依赖计算。
- [ ] Ready Queue。
- [ ] Agent 并发调度。
- [ ] ParallelSplit 执行。
- [ ] Join(all_success) 执行。
- [ ] Condition 执行（受限表达式判断、pass/fail 路由、无匹配分支进 failed）。
- [ ] End 执行（WorkflowRun → completed + workflow.completed 事件）。
- [ ] 分支独立暂停。
- [ ] 分支恢复和依赖重算。
- [ ] 暂停时运行中进程按 Provider 能力处理（三档策略）。
- [ ] ReworkRequest/ReworkPolicy 状态机（requested → in_rework → completed｜cancelled｜exhausted）。
- [ ] 结构化测试结果解析（outputContract 校验；失败解析→测试节点 failed，不触发返工）。
- [ ] 按失败任务定向返工（只重启受影响任务及必要下游）。
- [ ] 返工完成后自动重测。
- [ ] 轮次上限（默认 2 轮不含首次）与超限暂停分支转人工。
- [ ] 幂等键 unique(target_node_run_id, round) 防重。
- [ ] 执行器中断降级策略。
- [ ] 事件去重。
- [ ] Core 重启恢复和 Daemon 对账（含 ReworkRequest 轮次恢复、pending 审批恢复）。
- [ ] 失败与有限重试（NodeRun 级 maxAttempts）。

### 验收
- UI 分支暂停时后端分支继续运行。
- UI 审批未通过（未 approve）时前端不启动。
- Join 等待 UI 前端与后端都完成。
- 重启后对每个未终结 WorkflowRun：要么状态与重启前一致，要么标记 reconciliation_required 且在 UI 可见；两种情况下均无副作用重复（executions 无重复 external_execution_id，节点启动事件不重复）。
- 不会因重复事件重复启动同一个节点。
- 分支恢复后仅满足依赖的节点进入 ready；Join 仍等待全部条件。
- 暂停分支对该分支运行中 Execution 按三种 Provider 能力各验证一档：native interrupt+resume / interrupt+保存上下文 / 完成当前步骤后停止推进；暂停后该分支 60 秒窗口内无新 NodeRun 进入 running。
- Condition：给定注入的结构化上下文，真/假分支分别路由正确；条件不匹配任何后继时节点 failed 而非静默。
- End succeeded 后 WorkflowRun 置 completed 并写入 workflow.completed 事件。
- **ReworkPolicy 验收场景 A-G**（mock Provider / 固定输出测试 Agent 做确定性验收；阶段 6 真实 CLI 复验）：
  - A. 测试通过，正常进入下一节点，不创建 ReworkRequest。
  - B. 前端失败：仅前端生成 ReworkRequest 并返工，后端不重新执行。
  - C. 后端失败：仅后端生成 ReworkRequest 并返工，前端不重新执行。
  - D. 前后端都失败：分别创建两条 ReworkRequest，各自独立返工。
  - E. 返工完成后自动重新触发测试（测试节点生成新 attempt）。
  - F. 连续返工超过 2 轮（不含首次）后：分支暂停、rework.exhausted 事件写入、进入人工处理。
  - G. 系统重启后返工状态正确恢复：轮次计数不丢、不重复执行已完成副作用任务、in_rework 的返工不重复创建。
- 结构化测试结果解析失败（不符合 outputContract）时测试节点 failed 并产生明确错误类型，不触发返工。

## 阶段 5：人工审批和交付物

MVP 人工参与范围 = 单一 Human Approval 原语（决策 D-012/D-015）。Human Input、Human Takeover、Checkpoint、人工选择条件分支、多级审批均为后续版本，不得列为 MVP 任务。

### 任务
- [ ] Approval 请求和决策 API（approve / request_changes / reject；幂等；决策人/时间/意见/结果记录）。
- [ ] 审批中心 UI（含等待时长展示与按等待时长排序）。
- [ ] Before Execute 门禁（pending 期间不创建 Execution）。
- [ ] After Execute 审批。
- [ ] request_changes 路径：必填意见、创建 ReworkRequest、返工完成后重新进入原审批节点（round+1）。
- [ ] reject 路径：分支暂停、不自动返工、等待用户后续决策。
- [ ] 审批等待期间分支级暂停语义（只暂停当前分支）。
- [ ] Artifact 创建和版本化（版本不可覆盖）。
- [ ] Artifact 预览和下载/打开。
- [ ] 审计日志（审批决策、返工触发、备份/恢复操作写入 audit_logs，含 actor/action/target）。
- [ ] 失败终态呈现：失败原因、attempt 历史、失败日志入口（对应 PM 评审 M1）。
- [ ] 返工超限人工处理入口（继续返工/接管/终止）。
- [ ] CLI 不可用/未认证时启动任务的拦截提示。

### 验收（决策 D-015 的 11 项场景 + 补充）
- A1. approve 后当前分支正常继续。
- A2. reject 后当前分支暂停，且不会自动触发返工。
- A3. request_changes 必须填写修改意见（空意见被 API 拒绝）。
- A4. request_changes 必须关联具体返工任务（创建 ReworkRequest，含 trigger_approval_id）。
- A5. 仅指定任务返工，无关分支不受影响。
- A6. 返工完成后重新进入原审批节点（新一轮 round 记录）。
- A7. 每轮审批保留独立记录，历史决策不可被覆盖。
- A8. request_changes 触发的返工遵守最多 2 轮限制。
- A9. 超限后暂停相关分支，等待人工处理。
- A10. 系统重启后待审批及返工状态能够正确恢复。
- A11. 重复提交同一审批操作不产生重复返工（幂等 no-op：approvals 仅一条终态记录、NodeRun 仅一次状态迁移、事件不重复）。
- A12. 执行前审批阻塞：配置 beforeExecute 的 AgentTask 在 approval.status=pending 期间不得创建 Execution；approve 后才启动。
- A13. 每条决策记录含 decided_by/decided_at/decision_comment（request_changes 时非空），字段完整性校验。
- A14. UI V1 被要求修改（request_changes）→ UI 提交 V2（新 Artifact 版本）→ 用户批准 V2 → 前端随后启动；两个版本和全部审批意见保留。
- A15. 审批决策、返工触发、备份/恢复操作均可在 audit_logs 中按 actor/action/target 查询。

## 阶段 5.5：备份与恢复（决策 D-013，MVP 必须交付）

依赖：阶段 4 的重启恢复设施、阶段 5 的 Artifact 模块。

### 任务
- [ ] SQLite WAL 一致性备份（VACUUM INTO 或 backup API）。
- [ ] 备份包生成：manifest.json（manifestVersion/createdAt/type/db sha256/artifacts 清单及校验值）+ database.db + artifacts/ 托管文件复制。
- [ ] SHA-256 校验与备份后完整性检查（PRAGMA integrity_check）。
- [ ] 备份失败处理（不得呈现为成功）。
- [ ] 用户手动创建备份、导出到指定目录的 UI 与 API。
- [ ] 恢复预检：选择备份文件后先校验完整性，展示备份版本/时间/内容。
- [ ] 恢复前自动备份当前数据（pre_restore；失败则中止恢复）。
- [ ] 恢复时停止数据库写入、原子替换。
- [ ] 恢复失败回滚。
- [ ] 恢复后完整性复查与工作流状态对账（防重复执行副作用任务）。
- [ ] 外部项目路径缺失检测与提示。
- [ ] backups 表与备份历史记录。

### 验收（决策 D-013 的 8 项）
- B1. 正常备份和导出：manifest 与实际文件一致、sha256 匹配。
- B2. SQLite WAL 并发写入时的一致性备份：备份期间持续写入，备份产物完整可用。
- B3. 备份文件损坏检测：篡改备份包后校验失败并明确报错，不得进入恢复。
- B4. 正常恢复：恢复后业务数据完整（Agent/Work/WorkflowRun/Approval/ReworkRequest 记录与备份时一致）。
- B5. 恢复失败回滚：注入失败后系统回滚到 pre_restore 状态，原数据可用。
- B6. 恢复后数据完整性：PRAGMA integrity_check 通过；待审批/返工状态正确恢复且无副作用重复执行。
- B7. Artifact 文件恢复：托管 Artifact 文件随备份恢复且校验值一致。
- B8. 外部项目目录缺失提示：works.root_path 指向不存在路径时给出明确提示。

## 阶段 6：真实项目 MVP E2E

### 任务
- [ ] 建立产品研发模板（7 种节点 + ReworkPolicy 默认配置）。
- [ ] 建立五个示例 Agent Profile。
- [ ] 创建示例 Team 和 Work。
- [ ] 执行 PRD → UI/Backend 并行。
- [ ] UI 审批（request_changes 返工 V2 → approve）。
- [ ] 后端独立交付。
- [ ] UI 批准后前端启动。
- [ ] 前后端 Join。
- [ ] 测试执行和失败返工（真实 CLI 复验 ReworkPolicy 场景 A-G）。
- [ ] 产品经理验收。
- [ ] 用户最终审批。
- [ ] 完全退出应用（含 Core/Daemon）后重启恢复测试。
- [ ] 编写用户操作说明。

### 验收
- PRD §9 的编号化验收条目（A-01…A-xx）逐条执行并记录通过/失败；"通过"定义为每条编号项的断言全部为真。
- 完全退出 Desktop/Core/Daemon 并重启后：workflow_runs/branch_runs/node_runs 状态与重启前一致；pending 审批仍为 pending 且可继续决策；已决策审批记录字段不变；无任何 Execution 被重复执行。

## 阶段 7：协议扩展（非 MVP 阻塞项）

- [ ] 评估 ACP 的具体 Provider 兼容性。
- [ ] MCP Client/Server 工具接入。
- [ ] A2A Agent Card/Task/Message 适配。
- [ ] 协议身份、权限和信任边界。
- [ ] 外部 Agent 超时、重试和取消策略。
- [ ] 协议能力测试套件。

不得为了协议完整性延迟核心本地 CLI + Workflow MVP。

## 阶段 8：后续版本能力（V1.1 / V1.2，非 MVP）

按决策 D-010/D-012 排期：
- V1.1：Human Input、Checkpoint、人工选择条件分支、定时自动备份、备份保留策略、备份历史管理增强。
- V1.2：Human Takeover、多级审批及复杂审批策略、云端备份、增量备份、跨设备迁移。
- 评估后另定：Wait 定时等待、ArtifactReview 独立节点、Antumi 风格交互深化（左导航/看板/Inspector/终端面板/Diff/分屏/快捷键/全局搜索/时间线/主题）。

## 每个任务的 Definition of Done

- [ ] 满足需求和验收标准。
- [ ] 类型检查通过。
- [ ] 相关测试通过。
- [ ] 没有明显安全回归。
- [ ] 数据库 Migration 已提供（如需要）。
- [ ] 日志和错误处理清楚。
- [ ] 文档已更新。
- [ ] 交付说明列出实际测试命令和结果。
