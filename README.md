# Agent Team Workspace — 开发文档包

版本：V1.5（基于 v1.0.0 Development Baseline 的修订）\
目标平台：macOS 本地桌面应用  
产品形态：本地 AI Agent 团队协作与自主任务规划平台  
产品面（2026-11-06，D-028/D-029/D-030）：用户只面对 项目 → 任务 → 群聊 → 计划/执行 → 审批/返工；工作流引擎是内部执行内核，模板/版本/画布与原始启动入口已移除。  
规划可以独立于任务，完成后转为任务或项目；也可以在任务群聊里直接规划、批准并启动执行。  
任务详情以群聊为主，概览/团队/交付物/设置位于右侧；群聊支持 @ Agent 协作。  
Provider 通过 Runtime SDK 接入：当前支持 Claude Code、Codex、Gemini CLI 的自动发现（Codex/Gemini 为单回合 headless）。
UI/UX 参考：Antumi（参考交互与布局；源码 Apache-2.0，复用需保留版权与许可声明；其无工作流引擎，本产品 Workflow Engine 自研）

## 给本地 AI 编程 Agent 的启动说明

请先完整阅读本目录中的文档，再开始任何代码修改：

1. `PRD.md`：产品范围与用户需求
2. `ARCHITECTURE.md`：系统架构与技术边界
3. `DATABASE.md`：核心数据模型
4. `WORKFLOW.md`：工作流语义、状态机、暂停/恢复和人工参与规则
5. `AGENTS.md`：所有参与开发的 AI Agent 必须遵守的工程规则
6. `DEVELOPMENT_PLAN.md`：分阶段实施任务和验收标准
7. `DECISIONS.md`：已确认的产品决策和暂定事项

## 最重要的开发原则

- 不要一次性生成整个产品。严格按 `DEVELOPMENT_PLAN.md` 分阶段实施。
- **基线冻结前不得启动业务代码开发**：先完成文档修订与一致性检查，经用户批准冻结为 v1.0.0 Development Baseline 后再动工。
- 每个阶段先检查当前仓库状态，再提出实施计划；得到用户确认后再进行大规模修改。
- 每个任务必须包含代码、测试、运行验证和简短交付说明。
- 不得把业务逻辑放进 React 页面。
- 不得让 Desktop 直接启动或管理 Agent CLI。
- 工作流执行状态必须持久化；UI 关闭不能导致任务状态丢失。
- 暂停某个分支不能影响其他分支。
- 内部执行图节点仅 7 种（Start、Agent Task、Parallel Split、Join、Human Approval、Condition、End）；不再提供用户画布。返工由引擎内建 ReworkPolicy 实现，不是执行图节点。
- MVP 人工参与 = 单一 Human Approval 原语（决策集：approve / request_changes / reject）。
- MVP 含手动备份与恢复（SHA-256 Manifest 校验、原子替换、失败回滚）。
- 任意节点可以配置人工参与，但不能绕过人工审批门禁。
- 不得假定 CLI 支持安全暂停或原会话恢复，必须探测能力并实现降级策略。
- A2A、MCP、ACP 是不同职责的协议/能力，不可混为一种执行引擎。
- 第一版优先实现可靠的本地 CLI 执行（先 Claude Code）和工作流 MVP；协议扩展先预留清晰边界。

## 建议第一条任务指令

“请阅读仓库根目录下的设计文档包中的全部文件，检查当前仓库和本机环境。先不要编写业务代码。请输出：1）当前环境检查结果；2）与文档要求的差距；3）第一阶段实施计划；4）风险和需要我确认的事项。等待我确认后再开始。”
