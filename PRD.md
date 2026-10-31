# 产品需求文档（PRD）

版本：V1.4（基于 v1.0.0 Development Baseline 的修订）\
状态：开发基线（待基线冻结验收）  
产品名称：Agent Team Workspace（暂定名）

## 1. 产品概述

Agent Team Workspace 是一款运行在 macOS 本地的 AI Agent 员工团队管理与协作平台。用户创建和管理具有独立身份、角色、技能和执行引擎的 Agent，组建长期团队，让团队同时承接多个独立工作，并通过可视化、自定义工作流协调 Agent 执行、交付、审批和返工。

产品不是单纯聊天客户端，也不是固定三 Agent 的工作流工具。它是一个以人为最终决策者的本地 AI 团队管理系统。

## 2. 核心产品原则（已确认）

1. **分支独立暂停**：暂停指定工作流分支时，其他分支继续运行。暂停分支不再启动新的节点；正在执行的进程按执行器能力安全中断、完成当前步骤或取消并保存恢复信息。
2. **任意节点可人工参与**：每个工作流节点均可配置执行前确认、执行中检查点、执行后审批、人工输入、人工接管或人工分支决策。
3. **执行方式开放**：第一版接入本地 CLI；架构为未来协议接入预留统一适配层。CLI、ACP、A2A、MCP 职责不同，不可视为同类执行器。
4. **Antumi 作为 UI/UX 参考**：参考其导航、工作区、任务交互、检查器、终端/文件面板和快捷操作；自行实现本产品的组织、项目、工作流和人机协作模型。不得未经核实直接复制代码。
5. **人是最终负责人**：用户是团队老板和最终审批者，不需要固定的“团队负责人 Agent”。
6. **对象生命周期独立**：Agent、Team、Work、Workflow Template 各自独立，不因某个项目结束而销毁。
7. **多项目并行**：一个 Team 可承接多个 Work；一个 Agent 可参与多个 Work。不同 Work 的会话上下文和工作区隔离。
8. **流程不写死**：用户可创建、编辑、版本化和复用工作流模板。

## 3. 目标用户与主要场景

### 目标用户
希望在个人 Mac 上管理多个本地 AI 编程/工作 Agent，并通过可视化方式组织任务和人工审批的个人用户。

### 核心场景
- 用户创建产品经理、UI 设计师、前端、后端、测试等 Agent。
- 用户组建长期产品研发团队。
- 团队同时负责多个项目。
- 用户为不同项目选择不同工作流。
- Agent 按依赖关系并行执行任务。
- 关键阶段等待用户审核；不通过时返工。
- 用户可暂停一个分支而不影响其他分支。
- 用户查看实时日志、终端、文件、交付物和历史事件。

## 4. 核心领域对象

- **AgentProfile**：AI 员工的长期身份、角色、提示词、技能、权限和默认执行器配置。
- **RuntimeProvider**：本机 CLI 或未来协议运行时的接入实现。
- **Team**：长期组织。
- **TeamMember**：Agent 与 Team 的成员关系及团队职责。
- **Work**：独立工作/项目，拥有目标、上下文、文件和工作区。
- **Assignment**：Agent 参与某个 Work 的关系，定义工作角色和范围。
- **Task**：可独立追踪的任务（MVP 中由用户手动创建/指派给 Assignment 作轻量任务记录；工作流执行产生的是 NodeRun，不强制映射 Task）。
- **ReworkRequest**：引擎内建返工请求及轮次记录（非画布节点）。
- **WorkflowTemplate / WorkflowVersion**：用户可复用的工作流模板及不可变版本。
- **WorkflowRun**：某个 Work 的一次工作流执行实例。
- **BranchRun**：并行分支的运行实例及独立暂停状态。
- **NodeRun**：某个工作流节点在一次运行中的实例。
- **Approval**：人工审批、意见和决策记录（MVP 决策集：approve/request_changes/reject）。
- **Artifact**：正式交付物及版本。
- **AgentSession / Execution**：Agent 会话与具体进程执行记录。
- **Worktree**：Git 隔离工作目录。
- **WorkflowEvent / AuditLog**：状态事件和审计记录。

## 5. 功能需求

### 5.1 工作台
- 展示所有 Work 的状态、活跃任务、异常和最近活动。
- 展示待处理审批和需要人工决策的事项（含等待时长，按等待时长排序；MVP 应用内通知，macOS 系统通知延后 V1.1）。
- 展示 Agent 当前状态与负载。
- 支持从通知直接跳转到对应 Work、NodeRun 或 Artifact。

### 5.2 Agent 员工管理
- 创建、编辑、停用和归档 Agent。
  - 停用只阻止新的 Execution，不中断已运行的任务；重新启用后恢复创建新任务的能力。
- 配置名称、角色、描述、系统提示词、技能、工具权限、默认运行时和并发上限。
- **工具权限（最小模型）**：每个 Agent 可配置允许使用的工具与禁止使用的工具；工具名由 Provider 定义，Agentra 不校验其有效性。
  - 允许清单是唯一授权来源；禁止清单优先于允许清单；两者交集在保存时必须被拒绝。
  - 允许清单为空表示权限未配置：启动执行必须被拒绝并返回固定错误码，且不创建 Execution；既有 Agent 升级后未配置时同样拒绝，不得默认全开。
  - UI 必须展示当前配置；执行时必须展示本次实际生效的权限。
  - 明确不做：复杂权限矩阵、动态授权中心、工具级审批流、工具发现 / 枚举、通配符、按 Work / 节点覆盖、Team 继承。
- 发现本机已安装的受支持 CLI，显示路径、版本、可执行性、认证/登录状态（只显示可验证信息）。
- 认证配置入口：创建 Agent 时检测 CLI 认证状态，未认证时引导用户完成 CLI 登录；任务启动因认证失败被拦截时提示重新登录（凭据由 CLI 自身管理，Agentra 不存储）。引导方式为展示可复制的安装 / 登录命令与说明，不提供应用内登录流程。
- Agent 身份与运行时 Provider 分离。
- 同一 Agent 可在多个 Work 中有独立 Assignment、Session 和工作目录。

### 5.3 团队管理
- 创建、编辑、归档 Team。
- 添加/移除 Agent 成员。
- 配置成员的团队职责和权限。
- Team 可参与多个 Work。
- 不将 Team 生命周期绑定到 Work。

### 5.4 工作管理
- 创建、编辑、归档 Work。
- 设置目标、描述、优先级、项目根目录、仓库和团队。
- 将 Agent 分配到 Work，生成 Assignment。
- 每个 Work 有独立上下文、任务、会话、交付物和日志。
- 支持 Git Worktree 隔离并发代码任务。
- 支持暂停、恢复和终止整个 Work（暂停 Work 后所有分支不再启动新 NodeRun；终止为终态且不可逆；并发冲突行为见验收 A-19：同目录争用返回 WORKDIR_LOCKED 提示，Worktree 隔离时不阻塞）。

### 5.5 工作流设计器
MVP 画布节点（7 种，决策 D-010）。类型标识与 DATABASE §2.5 的 MVP type 白名单逐字一致：

| 展示名 | 类型标识（snake_case） |
|---|---|
| Start（系统结构节点，唯一入口） | `start` |
| Agent Task | `agent_task` |
| Parallel Split | `parallel_split` |
| Join | `join` |
| Human Approval | `human_approval` |
| Condition | `condition` |
| End | `end` |

设计器支持节点拖拽、连线、配置面板、校验、保存、复制模板和发布新版本。模板版本发布后不可原地修改；修改应生成新版本。画布节点面板仅提供上述 7 种；发布含未知节点类型的定义被拒绝。

后续版本节点（不进 MVP）：Human Input（V1.1）、Human Takeover（V1.2）、Wait、Retry/Loop、Artifact Review（独立节点）、人工选择条件分支（V1.1）。

### 5.6 工作流执行引擎
- 依据依赖和条件将节点从 Blocked 推进至 Ready。
- 调度器根据 Agent 可用性、并发限制和资源冲突启动任务。
- 支持并行分支和汇合。
- 支持分支级暂停/恢复。
- 支持节点失败、驳回、返工和人工升级（返工由引擎内建 ReworkPolicy 实现，见 5.7 与 WORKFLOW §10）。
- 所有关键状态持久化。
- 应用重启后可恢复未完成的工作流状态。
- 节点结果持久化成功后才能触发下游节点。

失败处理（MVP）：
- 任务失败后进入失败终态，呈现失败原因、attempt 历史、失败日志入口。
- 返工轮次超出上限（默认 2 轮）后暂停相关分支，进入人工处理；用户可选择继续返工、人工接管（动作而非节点）或终止。
- CLI 不可用或未认证时，启动任务被拦截并给出明确提示。
- 任务超时按失败处理，记录超时事件并进入上述失败终态流程。

### 5.7 人工参与
MVP 人工参与 = 单一 Human Approval 原语（决策 D-012/D-015）：
- Before Execute：执行前确认（审批 pending 期间不得启动该节点）。
- After Execute：执行后审批（查看交付物后决策）。

审批决策集合（MVP 全集，三种）：

| 决策 | 行为 |
|---|---|
| approve | 审批通过，当前分支继续 |
| request_changes | 要求修改，必须填写修改意见并关联返工任务（创建 ReworkRequest）；返工完成后重新进入原审批节点，形成新一轮审批记录 |
| reject | 审批不通过，当前分支暂停，不自动返工，等待用户后续决策 |

- 所有 request_changes 触发的返工遵守 ReworkPolicy 轮次上限（默认 2 轮，不含首次）；超限暂停分支进入人工处理。
- 审批等待期间只暂停当前分支，其他分支继续。
- 审批状态持久化，重启后恢复待审批状态；审批操作幂等，历史决策不可覆盖。
- 每次决策记录操作者、时间、意见、关联 Artifact 版本和后续动作。
- 后续版本：Human Input（V1.1）、Checkpoint（V1.1）、人工选择条件分支（V1.1）、Human Takeover（V1.2）、多级审批（V1.2）。

### 5.8 Agent 执行与实时交互
- 第一版支持本机 CLI Provider，先接入 Claude Code（决策 D-014），验证后再扩展 Codex。
- 自动发现、能力声明和启动前健康检查。
- 实时输出、状态、错误和权限请求。
- 统一 start/sendMessage/interrupt/resume/cancel/status 接口。
- 对不支持原生暂停/恢复的 Provider，明确降级为安全中断、保存上下文、重新启动；不可伪造能力。
- Desktop 不直接管理 CLI 进程。
- **执行前明示**：启动执行前必须展示 ① 当前执行采用无人值守模式（执行期间不弹出权限询问）；② 本次实际生效的工具权限；③ 当前版本不呈现 CLI 权限请求（阶段 5 前）。不设置确认弹窗，但用户必须在启动前能看到上述信息；执行详情保留同样的信息。
- **AgentTask 输出契约**：AgentTask 节点可声明结构化输出要求（outputContract），输出经 Schema 校验后供 Condition 节点与返工机制使用。测试类任务必须输出：pass/fail、失败原因、关联任务、影响范围、相关 Artifact。输出不符合契约时任务按失败处理，不触发返工。
- **开发者执行控制台（非 MVP 产品功能）**：阶段 1 在开发构建中提供直接选择 Agent 并输入 prompt 启动单次执行的调试入口，仅用于工程验收与排障。该入口不是产品功能：其产生的 Execution 不归属任何 Work / Assignment（`assignment_id` 与 `node_run_id` 均为空），不得出现在工作台、审批中心、Artifact 或审计产品视图中；产品内的正式执行必须遵循 Team / Work / Assignment 归属，不允许任何入口产生绕过 Work 边界的游离执行。发布构建不包含该页面与导航入口（硬约束，dev-only 构建开关），构建开关与打包产物检查见 DEVELOPMENT_PLAN 阶段 6（验收 A-22）。

### 5.9 交付物管理
- 交付物有类型、路径/存储位置、版本、创建者、关联节点和校验状态。
- 保留历史版本，不覆盖已审核版本；返工与重新提交均产生新版本。
- 支持 Markdown、文本、代码文件、图片和常见文档引用。
- 支持 Diff/预览（按文件类型逐步实现）。
- 下游节点通过显式 Artifact 引用读取上游成果，不依赖聊天记录猜测。

### 5.10 监控与审计
- 展示 Agent 实时状态、任务状态和日志。
- 记录节点开始、结束、失败、暂停、恢复、审批、返工等事件。
- 审计高风险工具调用和权限变更。
- 日志支持按 Work、Agent、Execution、时间筛选。
- 审计日志覆盖：审批决策、返工触发、备份/恢复操作（含 actor/action/target）。

### 5.11 数据备份与恢复（MVP，决策 D-013）
- 用户手动创建备份，可导出到指定目录。
- 备份包含全部业务数据、ReworkRequest、Agentra 托管的 Artifact 文件、执行日志/事件/审计记录和带 SHA-256 校验值的 Manifest；不包含外部 Git 仓库、CLI 程序、API Key/Token、缓存。
- 备份完整性校验（损坏检测），备份失败不得呈现为成功。
- 恢复前先校验备份完整性并展示备份版本/时间/内容；恢复前自动备份当前数据；恢复使用原子替换，失败可回滚；恢复后完整性复查、工作流状态对账（不重复执行副作用任务）、外部项目路径缺失提示。

## 6. 核心示例工作流：产品研发

1. 产品经理输出 PRD、功能清单、接口需求和验收标准。
2. PRD 完成后并行启动 UI 设计和后端研发。
3. UI 提交设计 V1，进入人工审批（After Execute）。
4. 用户以 request_changes 要求修改时，引擎创建 ReworkRequest，UI 分支返工并重新提交 V2，然后重新进入同一审批节点；前端在此期间保持 Blocked。
5. 后端不受 UI 审批影响，独立开发并提交 API 文档/代码。
6. 用户批准 V2 后，启动前端研发。
7. 前端与后端均完成后，Join（all_success）节点放行测试。
8. 测试失败时，引擎按 ReworkPolicy 创建返工（只返工失败任务，不重新执行无关成功任务），返工完成后自动重新测试；超过 2 轮上限暂停分支，进入人工处理。
9. 测试通过后，产品经理验收。
10. 最后由用户进行最终审批。

返工机制说明：MVP 无 Retry/Loop 画布节点；返工由 Workflow Engine 内建 ReworkPolicy 实现（详见 WORKFLOW §10），测试 Agent 输出结构化测试结果（pass/fail、失败原因、关联任务、影响范围、相关 Artifact）。

## 7. 非功能需求

- macOS 本地优先，数据默认保存在本机（数据根目录 `~/Library/Application Support/agentra`，支持环境变量覆盖；运行状态与数据库不放外置项目盘）。
- 关键任务状态和审批记录可靠持久化。
- 数据备份与恢复按 5.11 节（MVP 手动备份）。
- 进程隔离、权限最小化和高风险操作确认。
- 无人值守执行必须在启动前明示（无人值守、本次生效的工具权限、权限请求不呈现），不得让用户误以为可以在执行中实时审批工具调用。
- Desktop、Core、Daemon 解耦。
- 工作流定义和协议使用版本化 Schema。
- 关键业务模块具备单元/集成测试。
- 日志可追踪、可诊断。
- 审批等待时长在工作台展示并按等待时长排序（MVP）；macOS 系统通知延后（V1.1）。
- Work 级暂停语义：暂停 Work 后所有分支不再启动新 NodeRun；终止 Work 为终态且不可逆（MVP 提供，终态语义详见 WORKFLOW）。
- Work 优先级字段仅作展示与排序，不参与 MVP 调度决策。
- 数据存放位置在设置中可见；卸载清理与跨机器迁移（导出/导入）延后。
- 自动更新机制延后（记录为决策项）；MVP 手动下载更新。
- UI 参考 Antumi 的信息密度和操作方式，但确保本产品功能清晰。

## 8. V1 MVP 范围

必须完成：
1. macOS 桌面应用骨架。
2. Desktop/Core/Daemon 通信。
3. SQLite 持久化。
4. Agent 创建和本地 CLI 接入（先 Claude Code）。
5. Team 和 Work 管理。
6. Assignment 和独立工作目录。
7. 可视化工作流设计器（7 种节点：Start、Agent Task、Parallel Split、Join、Human Approval、Condition、End）。
8. 工作流执行引擎：依赖调度、并行分支、Join(all_success)、分支级暂停/恢复、Condition 路由、End 终态。
9. Human Approval 原语：执行前确认、执行后审批、approve/request_changes/reject 三种决策、审批意见与记录、幂等、重启恢复。
10. ReworkRequest/ReworkPolicy：测试失败与 request_changes 触发的定向返工、自动重测、2 轮上限、超限转人工。
11. 审批通过、要求修改（request_changes）、拒绝（reject）与重新提交。
12. 实时日志与交付物（版本化）。
13. 数据备份与恢复（手动备份、SHA-256 Manifest 校验、安全恢复）。
14. 重启后恢复工作流状态（含待审批与返工状态）。

延后：
- 完整 A2A 网络协作。
- 远程 Agent 集群。
- 多用户在线协作。
- 模板市场。
- 高级可视化分析。
- 任意第三方插件生态。
- Human Input（V1.1）、Checkpoint（V1.1）、人工选择条件分支（V1.1）、Human Takeover（V1.2）、多级审批（V1.2）。
- 定时自动备份/保留策略（V1.1）、云端/增量备份、跨设备迁移（V1.2）。
- Wait 定时等待、Artifact Review 独立节点、Retry/Loop 画布节点。
- 开发者执行控制台的产品化（不作为 MVP 交付入口；发布构建不包含，见 D-018）。

## 9. MVP 验收标准（编号化）

- A-01 建立 5 个 Agent Profile（产品、UI、前端、后端、测试），数据库各有一条 active 记录。
- A-02 创建 1 个 Team 和 1 个 Work，Work 关联 Team 且成员齐全。
- A-03 「产品经理」AgentTask 节点状态变为 succeeded，产生 ≥1 条 ArtifactVersion（artifact_type=markdown），且其后继 ParallelSplit 节点进入 ready。
- A-04 UI 和后端并行启动：两个 AgentTask 的 Execution 均在 ParallelSplit 完成后创建。
- A-05 UI V1 等待人工审批：审批记录 status=pending，UI 分支无后续节点启动。
- A-06 用户以 request_changes 要求 UI 修改：必填意见成立，生成 ReworkRequest（trigger_type=request_changes），UI 重新提交 V2（新 Artifact 版本，旧版本保留）。
- A-07 request_changes 返工完成后重新进入原审批节点，形成新一轮（round=2）审批记录；前端始终保持 Blocked。
- A-08 UI 等待期间后端可独立完成：后端 AgentTask succeeded 与 UI 审批状态无关。
- A-09 用户批准 V2（approve）后前端才启动：approve 前前端 AgentTask 无 Execution；approve 后创建。
- A-10 前后端均完成后测试才启动：Join（all_success）在前端与后端 AgentTask 均 succeeded 前不放行。
- A-11 测试失败能返工并重新测试（按 ReworkPolicy 场景 B/C/D）：测试 Agent 输出结构化失败结果后，仅对应失败任务生成新 ReworkRequest 并返工；返工完成后自动重测（测试节点生成新 attempt）；全程不超过 2 轮（不含首次）。
- A-12 连续返工超过 2 轮后进入人工处理：分支暂停、rework.exhausted 事件、人工处理入口可用。
- A-13 产品经理验收产生 approval 记录（status=approved，含 decided_by/decided_at/comment）。
- A-14 随后最终审批 HumanApproval 节点进入 waiting_approval，用户决策 approved 后 End 节点置 succeeded，WorkflowRun 置 completed 并写入 workflow.completed 事件。
- A-15 暂停 UI 分支时后端继续工作：暂停后 UI 分支无新 NodeRun 进入 running，后端分支不受影响。
- A-16 完全退出应用（Desktop/Core/Daemon）并重新启动后：workflow_runs/branch_runs/node_runs 状态与重启前一致；pending 审批仍为 pending 且可继续决策；已决策审批记录字段不变；无任何 Execution 被重复执行。
- A-17 数据备份与恢复按决策 D-013 验收 8 项（DEVELOPMENT_PLAN 阶段 5.5 B1-B8）全部通过。
- A-18 修改已发布模板时强制生成新版本，原版本不可变。
- A-19 并发冲突可感知：两个 Work 指向同一非 Worktree 目录时第二次启动返回 WORKDIR_LOCKED 并提示；同一 Agent 达到并发上限时第二个任务排队不启动（上限释放后自动调度）。
- A-20 Work 级暂停/恢复：暂停 Work 后其所有分支无新 NodeRun 进入 running，恢复后仅依赖满足的节点进入 ready；其他 Work 不受影响。
- A-21 Work 级终止：确认后所有未终结 WorkflowRun 置 cancelled、pending 审批置 cancelled（系统取消路径）、运行中 Execution 停止；已完成节点/审批/Artifact 记录保留；终止操作写入 audit_logs；再次操作该 Work 提示已终态。
- A-22 发布构建不含开发者执行控制台：打包产物中 (1) 不存在该页面与导航入口；(2) 不暴露可直接创建游离 Execution 的 IPC / API；(3) 直接请求无法绕过 UI 限制创建无 Work / Assignment 归属的 Execution；(4) 阶段 6 的自动化检查断言 (1)–(3) 全部为真。
- A-23 工具权限最小模型生效：① 未配置允许工具的 Agent 启动执行被拒绝并返回 `AGENT_TOOLS_NOT_CONFIGURED`，且不创建 Execution（既有 Agent 升级后未配置时同样被拒）；② 保存时拒绝非法配置：`allow ∩ deny` 冲突、重复项、单项超长（>200 字符）或超量（各 >100 项）均被 API 拒绝；③ 禁止清单中的工具即使同时出现在允许清单也不可用（deny 优先）；④ Agent 表单与列表可见当前配置，允许清单为空时有明确提示；⑤ 执行记录包含本次实际生效策略（`execution_logs` 的 `execution.tool_policy`），且「保存 → 读取 → Core → Daemon → CLI 参数」五段一致。
