# 产品决策记录（ADR-lite）

版本：V1.1（修订版，基线冻结前）

## 已确认决策

### D-001：本地桌面应用
- 决策：以 macOS 本地独立桌面软件为首要目标。
- 影响：本地数据库、进程管理、文件访问和 CLI 接入是核心能力。

### D-002：Antumi UI/UX 参考
- 决策：以 Antumi 作为主要 UI 和交互参考。
- 参考范围：导航、工作区布局、任务/会话交互、右侧检查器、终端/文件面板、分屏和快捷操作。
- 限制：不因模仿 Antumi 而限制本产品的 Team/Work/Workflow/Approval 模型；代码复用前核实许可证和版权义务。
- 补充（2026-10-30 核实）：Antumi 源码位于 `/Volumes/MacExt SSD/Self Work/antumi-main`（GitHub flyhero/antumi），**Apache License 2.0**，复用合规；但其不含工作流引擎，本产品 Workflow Engine 需自研。

### D-003：Agent 是长期员工
- 决策：AgentProfile 生命周期独立于 Work。
- 影响：Assignment、Session、Execution 需要按 Work 隔离。

### D-004：Team 是长期组织
- 决策：Team 可承接多个 Work。
- 影响：Team 与 Work 多对多关联。

### D-005：Work 独立
- 决策：每个 Work 有独立上下文、任务、文件、会话、日志和工作区。

### D-006：工作流由用户自定义
- 决策：不写死三 Agent 或固定研发流程。
- 影响：提供可视化设计器、模板版本和执行引擎。

### D-007：分支独立暂停
- 决策：暂停指定分支，其他分支继续。
- 影响：运行时需要 BranchRun 独立状态和分支调度策略。

### D-008：任意节点人工参与
- 决策：任何节点可配置人工参与。
- 影响：人工门禁是 Workflow Engine 通用能力，不是单一审批页面功能。
- 补充：MVP 通过显式 Human Approval 节点实现人工参与（见 D-012）；长期原则不变。

### D-009：CLI 与未来协议开放
- 决策：第一版本地 CLI，架构预留协议接入。
- 影响：Runtime SDK 与 Protocol Adapter 分离；MCP/A2A/ACP 不混为同类执行器。

## 已确认决策（2026-10-30 PM 评审后裁定，D-010 ～ D-015）

### D-010：MVP 工作流节点范围为 7 种
- 决策：MVP 画布节点唯一交付范围 = Start、Agent Task、Parallel Split、Join、Human Approval、Condition、End（6 业务节点 + Start 系统结构节点）。
- 后续版本：Human Input（V1.1）、Checkpoint（V1.1）、人工选择条件分支（V1.1）、Human Takeover（V1.2）、多级审批（V1.2）；Retry/Loop 节点不作为画布节点交付（返工由引擎内建，见 D-011）。
- 约束：执行引擎节点类型必须可扩展，不得将节点类型写死在执行引擎中；画布节点面板仅提供 7 种 MVP 节点，发布含未知节点类型的定义必须被拒绝（UNKNOWN_NODE_TYPE）。
- 影响：PRD §5.5/§8、WORKFLOW §2、DEVELOPMENT_PLAN 阶段 3 统一按此口径。

### D-011：测试返工 = 引擎内建 ReworkPolicy，非画布节点
- 决策：MVP 支持测试失败后的有限次数返工和重新测试；返工属于 Workflow Engine 内置执行能力（ReworkRequest + ReworkPolicy），不是画布节点，不得伪装成通用 Loop/Retry 节点。
- 规则：
  1. 测试 Agent 必须输出结构化测试结果（pass/fail、失败原因、关联任务、影响范围、相关 Artifact）。
  2. 测试失败后 Workflow Engine 创建 ReworkRequest。
  3. 返工只针对明确失败的任务，不重新执行无关的成功任务。
  4. 返工完成后自动重新触发测试。
  5. 默认最多 2 轮返工（不含首次测试）。
  6. 超出返工次数后暂停相关工作流分支，进入人工处理；人工可选择继续返工、人工接管或终止。
  7. 每一轮返工必须保留执行记录、Artifact 版本和测试报告。
- 技术约束：任意图边不得形成无限循环；Rework 幂等、持久化、故障恢复、执行审计；返工次数精确统计（重启后不得无限重试）；只重启受影响任务及必要下游。
- 验收场景 A-G 落于 DEVELOPMENT_PLAN 阶段 4（mock Provider 确定性验收），阶段 6 真实 CLI 复验。

### D-012：MVP 人工参与 = 单一 Human Approval 原语
- 决策：MVP 只实现一种人工交互原语：Human Approval。支持执行前人工确认、执行后人工审批、审批决策、审批意见、审批人/时间/结果记录、审批等待期间的分支级暂停、系统重启后恢复待审批状态。以上是同一原语的不同使用场景，不扩展为多套独立人工交互机制。
- 后续版本：Human Input（V1.1）、Human Takeover（V1.2）、Checkpoint（V1.1）、人工选择条件分支（V1.1）、多级审批及复杂审批策略（V1.2）。
- 执行语义：审批等待只暂停当前分支，其他并行分支继续；审批拒绝后暂停当前分支等待用户后续决策；审批状态持久化、操作幂等并保留审计记录。
- 与 ReworkPolicy 的配合：返工超限后通过人工决策处理；MVP 不要求 Human Takeover 节点。

### D-013：MVP 数据备份与恢复（手动）
- 决策：数据库备份与恢复纳入 MVP 必须交付范围。MVP 实现本地手动备份、备份完整性校验（SHA-256 Manifest）和手动恢复；不做云端备份、增量备份和定时自动备份。
- 备份范围（含）：Agent/Team/TeamMember 配置、Work/Assignment/Task 数据、WorkflowTemplate/Version、WorkflowRun/BranchRun/NodeRun、Approval、ReworkRequest、Artifact 元数据及 Agentra 托管的 Artifact 文件、执行日志/工作流事件/审计记录、备份清单（版本信息+文件校验值）。
- 备份范围（不含）：外部 Git 仓库和项目源代码、Agent CLI 程序、API Key/登录 Token 等敏感凭据、缓存及临时文件。恢复后必须检查外部项目路径是否存在并提示。
- 实现要求：SQLite WAL 一致性备份、备份后完整性检查、备份失败不得报成功；恢复前完整性校验并展示备份版本/时间/内容、恢复前自动备份当前数据、恢复时停止数据库写入、原子替换、失败可回滚、恢复后完整性复查、防止恢复后重复执行外部副作用任务。
- 后续版本：定时自动备份、备份保留策略、备份历史管理（V1.1）；云端备份、增量备份、跨设备迁移（V1.2）。
- 验收 8 项落于 DEVELOPMENT_PLAN 阶段 5.5。

### D-014：首个 CLI Provider = Claude Code
- 决策：先接入 Claude Code 做通端到端（发现→健康检查→启动→输出→中断→取消），架构验证后再接入 Codex。
- 影响：Runtime SDK 抽象以 Claude Code 为首个真实参照；本机已确认 claude 2.1.312 可用。

### D-015：Human Approval 决策集合 = approve / request_changes / reject
- 决策（对 D-012 的补充修正）：MVP 审批决策集合统一为三种。
- 行为定义：
  | 决策 | 行为 |
  |---|---|
  | `approve` | 审批通过，当前分支继续 |
  | `reject` | 审批不通过，当前分支暂停，不自动返工 |
  | `request_changes` | 要求修改，必须填写修改意见并关联返工任务（创建 ReworkRequest） |
- request_changes 返工完成后，重新进入原 Human Approval 节点，形成新一轮审批记录；所有 request_changes 返工遵守 D-011 的最多 2 轮限制，超限暂停分支等待人工处理。
- QA 必须验证 11 项场景（approve 继续 / reject 暂停且不自动返工 / request_changes 必填意见 / 必须关联返工任务 / 仅指定任务返工无关分支不受影响 / 返工后重新进入原审批节点 / 每轮审批独立记录不可覆盖 / 遵守 2 轮限制 / 超限暂停分支 / 重启恢复待审批及返工状态 / 重复提交审批不重复返工），落于 DEVELOPMENT_PLAN 阶段 5。

## 暂定事项（实施前需验证，不可当作已确认事实）

1. ~~Antumi 当前仓库的准确技术栈、模块边界、可复用代码和许可证适用范围。~~ **已核实（2026-10-30）**：Apache-2.0，pnpm monorepo（core/daemon/desktop/protocol 等），core 用 node:sqlite+zod，daemon 用 node-pty，desktop 用 electron-vite；无工作流引擎。
2. Claude Code 与 Codex 当前版本的 CLI 参数、结构化输出、会话恢复、取消和权限请求能力。（部分核实：Claude Code stream-json 双向 + `--permission-prompt-tool stdio` + `control_request interrupt` 原生中断；Codex 用 `codex app-server` JSON-RPC over stdio。阶段 1 实测后从本清单移除。）
3. ~~是否第一版同时接入 Claude Code 与 Codex，还是先接一个做通端到端。~~ **已裁定（D-014）**：先接 Claude Code。
4. 是否采用 Electron，还是在环境验证后比较 Tauri；当前方案以 Electron 为推荐基线。
5. 具体 UI 组件库、图标库和工作流画布版本。
6. ~~数据根目录、自动备份频率和保留策略。~~ **部分裁定（D-013）**：备份为手动，频率策略不适用；数据根目录（`~/Library/Application Support/agentra`，支持环境变量覆盖）与备份保留策略细节在阶段 0/1 实施时确认。
7. 复杂循环、定时触发、外部 Webhook 和多团队参与一个 Work 的优先级。

## 决策变更规则

如需改变已确认原则，Agent 必须：
- 说明冲突和影响；
- 给出替代方案；
- 等待用户确认；
- 更新本文件和相关设计文档。

## 基线冻结记录

- **v1.0.0 Development Baseline**
- 冻结日期：2026-10-30
- 冻结文档：PRD.md、ARCHITECTURE.md、DATABASE.md、WORKFLOW.md、DEVELOPMENT_PLAN.md、AGENTS.md、DECISIONS.md、README.md（版本头 V1.1）
- 冻结基线提交：b7a0110 及其后续一致性微修
- 冻结前置检查（已全部满足）：
  - PM 评审全部问题关闭：Blocker 1 项（B1）、Major 7 项（M1-M7）、Minor 10 项——经 D-010～D-015 六项决策裁定并在文档中落地
  - 六项决策派生验收 41 项全部落位（QA 复验逐条核对）
  - 前轮 13 处不可测验收措辞全部改写为可判定断言（PRD §9 编号化 A-01…A-21）
  - QA 复验残留 2 项 Major 已修复并经增量点验通过（commit b7a0110）
  - 跨文档口径一致：审批决策集三值 9 处、7 节点白名单 6 处、幂等键定义、阶段归属（A-G→阶段 4、11 项→阶段 5、B1-B8→阶段 5.5）均一致
  - 无未经用户批准的 MVP 范围扩张
- 冻结后规则：修改本基线内 MVP 需求须走正式变更申请（更新 DECISIONS.md 并经用户批准）。冻结后首个文档修订批次统一处理 QA 残留 Minor 清单（复验报告所列 9 项，均为措辞/注释级）。
