# 产品决策记录（ADR-lite）

版本：V1.3（含冻结后变更记录 D-016～D-023）

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

### D-016：数据库访问方案 = node:sqlite（冻结后正式变更，2026-10-30）
- 决策：Agentra v1.0 MVP 数据库访问方案确定为 SQLite + Node.js 内置 `node:sqlite`；**不引入 Drizzle ORM**。
- 约束：
  - Core 统一管理数据库访问，Daemon 不直接访问业务数据库。
  - 建立统一 Repository/Data Access Layer。
  - 自行实现版本化迁移机制（`PRAGMA user_version` 递增，MIGRATIONS 数组，可重复执行）。
  - 使用参数化 SQL、事务和 WAL；迁移、备份、恢复、并发与异常恢复必须可测试。
- Agentra 自身兼容性验证（2026-10-30 实测，非引用 Antumi 结论）：
  | 验证项 | 结果 |
  |---|---|
  | 纯 Node 22.23.2 | node:sqlite 建表/参数化写入/WAL/`VACUUM INTO`/`integrity_check` 全部通过（有 ExperimentalWarning） |
  | Electron 45.1.0 + `ELECTRON_RUN_AS_NODE=1` | 内置 Node 24.22.1，同一脚本全部通过；本次实测未观察到 ExperimentalWarning（不推定其他版本/打包态行为） |
  | WAL 并发备份 | 写入进程 3 秒写 54,914 行期间 `VACUUM INTO` 快照一致（12,600 行），备份 integrity ok |
  | 版本对应关系 | Electron 45.1.0 ↔ 内置 Node 24.22.1（实测） |
  | 最低版本 | 开发/测试 Node ≥ 22.13；生产 Core 运行于锁定版本 Electron 的内置 Node，不单独假设 Node 版本 |
  | 验证分层 | 阶段 1：当前 Electron 运行环境的基本 SQLite 集成验证；阶段 5.5：备份恢复完整 8 项验收（快照验证不能代替）；阶段 6：完整打包态复验 |
- 文档同步（本轮已完成）：DATABASE.md V1.2（头部与设计原则）、ARCHITECTURE.md V1.2（技术栈表、运行时基线、Core 职责）、DEVELOPMENT_PLAN.md V1.2（阶段 1 任务注明 node:sqlite）；DEVELOPMENT_PLAN 中无 Drizzle 安装步骤（已检查）。
- 变更性质：冻结后经用户批准的正式变更（变更申请记录于本条）；v1.0.0 基线继续有效，本次修订内容已于 2026-10-30 经用户逐项追认（U1，见「逐项追认记录」），不做重新冻结。
- 遗留风险：node:sqlite 在 Node 22 标记 experimental（API 可能变化）——通过固定 Electron/Node 版本与 Repository 层隔离缓解；备份/恢复的完整验收在阶段 5.5 执行；打包态行为在阶段 6 复验。

### D-017：阶段 1 数据库方案与未决问题裁定（2026-10-30，用户裁定）
1. 开发环境最低 Node.js 版本 ≥ 22.13，**不因 ExperimentalWarning 强制升级 Node 24**。
2. 生产环境使用**锁定版本 Electron 内置的 Node.js**，不单独假设 Node 版本；版本对应关系明确记录：**Electron 45.1.0 ↔ 内置 Node 24.22.1**（实测）。
3. 必须验证 `ELECTRON_RUN_AS_NODE` 模式下 node:sqlite 的实际兼容性（验证结果见 D-016；本次实测未观察到 ExperimentalWarning，但不得推定为 Node 24 必然无警告）。
4. **阶段 1** 必须完成当前 Electron 运行环境的基本 SQLite 集成验证；**完整打包态复验放在阶段 6**。
5. **备份恢复完整 8 项验收放在阶段 5.5**；当前 VACUUM INTO 验证不能代替完整验收。
6. 冻结后 Minor 9 项逐项分类：涉及架构、数据一致性、安全或验收标准的必须在本次修订批准前处理；非关键优化进入 Minor Backlog。

**Minor 9 项处理清单（D-017 附件）**：

| # | Minor 项 | 分类 | 处理结论 |
|---|---|---|---|
| 1 | WORKFLOW §3 节点状态 MVP 子集悬空引用 | 验收标准 | ✅ 本次修订已处理（已追认，U1）：WORKFLOW §3 明确列出 MVP 启用状态子集（waiting_input/waiting_checkpoint 为 V1.1） |
| 2 | Join Policy all_terminal 未标注归属 | 验收标准 | ✅ 本次修订已处理（已追认，U1）：WORKFLOW §2 标注 all_terminal 为后续版本 |
| 3 | 事件命名双轨（ARCHITECTURE §7 vs WORKFLOW §8）未声明映射 | 架构 | ✅ 本次修订已处理（已追认，U1）：ARCHITECTURE §7 增加协议层/领域层命名映射说明 |
| 4 | AGENTS §1 / README "docs 文档包" 路径引用与实际（根目录）不符 | 非关键（文档卫生） | ✅ 本轮处理（U1 批准，2026-10-30）：改为「仓库根目录的设计文档」，不移动文件 |
| 5 | 节点展示名 ↔ 类型标识（snake_case）对应说明缺失 | 非关键（命名说明） | ✅ 本轮处理（U1 批准，2026-10-30）：PRD §5.5 补展示名 ↔ 类型标识对照表 |
| 6 | D-010 "引擎节点类型可扩展" 无验收条款 | 架构/验收标准 | ✅ 本次修订已处理（已追认，U1）：DEVELOPMENT_PLAN 阶段 4 增加节点类型注册表任务与验收 |
| 7 | D-011 规则 7 测试失败路径缺"历史轮次不可覆盖"断言 | 验收标准 | ✅ 本次修订已处理（已追认，U1）：DEVELOPMENT_PLAN 阶段 4 验收新增数据库断言 |
| 8 | 阶段 5 A15 依赖阶段 5.5 产物（顺序倒挂） | 验收标准 | ✅ 本次修订已处理（已追认，U1）：A15 注明备份/恢复审计断言在阶段 5.5 执行（B9） |
| 9 | CLI 不可用/未认证拦截无验收断言 | 验收标准 | ✅ 本次修订已处理（已追认，U1）：DEVELOPMENT_PLAN 阶段 1 验收新增 |

处理统计：**9 项均已处理**——7 项随本次修订落地并于 2026-10-30 经用户逐项追认（U1）；2 项（#4、#5）经 U1 批准改为本轮处理，不再进入 Minor Backlog。

**本裁定于 2026-10-30 经用户逐项追认（U1），但仍不等于批准基线冻结，也不等于批准正式业务代码开发；阶段 1 代码尚未通过验收，仍需 P2 七项验收、QA 独立验收与用户最终批准。**

## 逐项追认记录（D-016 / D-017，2026-10-30，用户 U1）

用户 U1 批准逐项追认 D-016 / D-017，不整体追认、不重新冻结。逐项处置如下：

| 追认对象 | 处置 | 状态 |
|---|---|---|
| D-016 决策本体（SQLite + `node:sqlite`，不引入 Drizzle） | 追认 | 已生效 |
| D-016 文档同步（DATABASE V1.2 头部与设计原则、ARCHITECTURE V1.2 技术栈表/运行时基线/Core 职责、DEVELOPMENT_PLAN V1.2 阶段 1） | 追认文档落地文本 | 已生效 |
| D-016「不做重新冻结」 | 追认 | 已生效 |
| D-016 遗留风险（Node 22 experimental；阶段 5.5 / 6 验证） | 保留并更新状态：阶段 1 已部分验证（构建冒烟 + Electron SQLite 验证脚本；脚本 skip 问题随阶段 1 收尾修正），完整验证仍在阶段 5.5 / 6 | 有效 |
| D-017 版本基线 3 条（Node ≥ 22.13；Electron 45.1.0 ↔ 内置 Node 24.22.1；`ELECTRON_RUN_AS_NODE` 验证） | 追认文档落地文本 | 已生效 |
| D-017 验证分层（阶段 1 / 5.5 / 6） | 追认，并补充：阶段 1 验收第 7 项的 Electron SQLite 脚本不得 skip，必须真实执行 | 已生效 |
| D-017 Minor #1 / #2 / #3 / #6 / #7 / #8 / #9 | 追认 | 已生效 |
| D-017 Minor #4 / #5 | 由 Minor Backlog 改为本轮处理 | 本轮处理 |
| D-017「不等于批准正式业务代码开发」 | 状态更新：P0 工程修复已授权并完成；阶段 1 代码尚未验收 | 有效 |

**追认不等于阶段 1 通过验收**：阶段 1 仍需 P2 七项验收、QA 独立验收与用户最终批准。

## 已确认决策（2026-10-30 设计变更清单裁定，D-018 ～ D-023）

### D-018：开发者执行控制台 = 开发者调试脚手架（2026-10-30，用户 U2）

- 决策：执行控制台定位为开发者调试脚手架，不是 MVP 产品功能入口；采用 dev-only 构建开关。
- 约束：
  - 发布构建不包含执行控制台页面与导航入口。
  - 不暴露可直接创建游离 Execution 的 IPC / API；不得通过直接请求绕过 UI 限制。
  - 控制台产生的 Execution 不归属 Work / Assignment，不得进入工作台、审批中心、Artifact 或审计产品视图。
  - 产品内正式执行必须遵循 Team / Work / Assignment 归属，不允许任何入口产生绕过 Work 边界的游离执行。
  - 阶段 6 对打包产物执行自动化检查（PRD A-22）。
- 文档同步：PRD §5.8 / §8 / §9；DEVELOPMENT_PLAN 阶段 6。

### D-019：工具权限最小模型（2026-10-30，用户 U3）

- 决策：MVP 实现最小工具权限模型；每个 Agent 配置允许工具与禁止工具，执行前强制应用。
- 约束：
  - 存储使用 `agent_profiles.tool_permissions_json` 单列（含版本字段，Zod 校验），不建立独立权限表。
  - 空 allow 列表拒绝启动，返回固定错误码，不创建 Execution。
  - 禁止项优先于允许项；allow 与 deny 冲突在写入时拒绝。
  - 旧 Agent 升级后未完成权限配置时拒绝执行，不得默认全开。
  - 保存、读取、Core 到 Daemon 传递及 CLI 参数必须一致；UI 展示本次实际生效权限。
  - 补充空 allow、禁止冲突、旧 Agent 未配置、正常授权四类测试。
- 明确不做：复杂权限矩阵、动态授权中心、工具级审批流、工具发现 / 枚举、通配符、按 Work / 节点覆盖、Team 继承。
- 文档同步：PRD §5.2 / §5.8 / §7 / §9；DATABASE §2.1；DEVELOPMENT_PLAN 阶段 1 收尾（随 C1 落地）。

### D-020：无人值守执行的产品口径与 UI 明示（2026-10-30，用户 U5）

- 决策：阶段 1 执行暂用 `dontAsk` 无人值守模式；启动前必须明示执行策略。
- 约束：
  - 启动前显示：① 当前执行采用无人值守模式；② 本次实际生效的工具权限；③ 当前版本不呈现 CLI 权限请求。
  - 不增加确认弹窗，但必须保证用户在启动前能看到上述信息。
  - 权限请求的呈现归阶段 5 审批中心，不提前到阶段 1。
- 文档同步：PRD §5.8 / §7；DEVELOPMENT_PLAN 阶段 1（随 C2 落地）。

### D-021：阶段 1 收尾范围与 Q5 / Q6 判定（2026-10-30，用户 U4）

- 决策：认证引导、停用 Agent、maxConcurrency 标注三项均按「原决策的实现补全」处理，不新增产品能力。
- 约束：
  - Provider 认证引导只展示可复制的安装 / 登录命令，不做应用内登录（凭据由 CLI 管理）。
  - Agent 停用只阻止新 Execution，不中断已运行任务；重新启用后恢复创建新任务能力。
  - maxConcurrency 标注「阶段 2 生效」或暂时隐藏，不得让用户误以为已生效。
- 文档同步：PRD §5.2（补两句）；DEVELOPMENT_PLAN 阶段 1（随 A4 落地）。

### D-022：阶段 2 外键迁移与数据保全（2026-10-30，用户 U6）

- 决策：阶段 2 通过迁移为 `agent_sessions.assignment_id` 补外键；`executions.node_run_id` 的外键顺延阶段 3 / 4。
- 约束：
  - 迁移时孤儿引用置 NULL 并写审计日志。
  - 阶段 2 必须有数据保全与失败回滚测试。
  - 阶段 2 不得宣称全部外键约束已完成。
- 文档同步：DATABASE §2.4；DEVELOPMENT_PLAN 阶段 2（随 A2 落地）。

### D-023：文档治理与版本策略（2026-10-30，用户 U1）

- 决策：D-016 / D-017 逐项追认，不整体追认、不重新冻结；本批决策（D-018 ～ D-023）按正式决策记录流程建立。
- 约束：
  - V1.3 只能在全部批准的文档变更落地并交叉检查完成后升级，不得提前标记。
  - 本轮不动版本头；版本升级由 CTO 在交叉检查后统一处理。
  - 冻结后任何 MVP 需求变更继续走正式变更申请（更新本文件并经用户批准）。
- 影响：在 V1.3 升级前，文档版本号不代表本轮变更已全部落地。

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
- 冻结后规则：修改本基线内 MVP 需求须走正式变更申请（更新 DECISIONS.md 并经用户批准）。冻结后首个文档修订批次统一处理 QA 残留 Minor 清单（复验报告所列 9 项；分类与处理以 D-017 附件表为准）。
- 冻结后变更记录：
  - D-016（2026-10-30 经用户批准）：数据库访问方案定为 node:sqlite（无 ORM）——DATABASE.md / ARCHITECTURE.md / DEVELOPMENT_PLAN.md 升级为 V1.2；v1.0.0 基线其余内容不变，未重新冻结（修订内容已于 2026-10-30 经用户逐项追认，见「逐项追认记录」）。
  - D-017（2026-10-30 经用户裁定）：阶段 1 数据库方案与未决问题裁定；Minor 9 项中 7 项已随本次修订处理并经用户逐项追认、2 项（#4 docs 路径引用、#5 节点命名映射说明）经 U1 批准改为本轮处理。
  - Minor Backlog：本轮无遗留项（#4、#5 已按 U1 改为本轮处理）。
  - **V1.3 统一升版（2026-10-30，D-023）**：全部 8 份设计文档版本头统一为 V1.3（此前 PRD / README / AGENTS 为 V1.1，ARCHITECTURE / DATABASE / DECISIONS / DEVELOPMENT_PLAN / WORKFLOW 为 V1.2）。本轮有实质内容变更的是 **PRD、ARCHITECTURE、DATABASE、AGENTS、DEVELOPMENT_PLAN、DECISIONS、README**（7 份）；**WORKFLOW 本轮无内容变更，仅随基线统一升版**。内容变更对应决策 D-016～D-023 与批次 1–3 的文档修订（D1–D5、B1/B3/B5/B6/B7 条款、C1/C2/A4 收尾）。版本头升版不改变任何正文语义，v1.0.0 基线继续有效，未重新冻结。
