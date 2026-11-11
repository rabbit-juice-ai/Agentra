# Phase 1A 验收归档：Task Memory + Work 验收标准持久化

- 归档日期：2026-11-09
- 阶段状态：CTO 阶段验收通过
- 边界：本阶段只落地 Work 验收标准与 Task Memory；未启动 Phase 1B/1C/1D
- Git：`main` / HEAD `9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`；保留未提交工作区，未 commit

## 1. 阶段范围

1. Work 验收标准正式持久化
2. Task Memory 数据结构与服务
3. Work 与 Task Memory 关联
4. 验收标准版本管理
5. 创建任务时保存验收标准
6. 新 Execution 获取当前验收标准版本
7. 数据库迁移、测试与审计

明确未实现：Checkpoint、Session Resume、Token 预算、ContextBuilder、Side Effect Ledger、`task_checkpoints`、`task_side_effects`、`model_context_windows`。

## 2. 数据库迁移

迁移版本：**v31 `work_acceptance_and_task_memory`**

`works` 新增：

- `acceptance_criteria_json TEXT NOT NULL DEFAULT '[]'`
- `acceptance_criteria_version INTEGER NOT NULL DEFAULT 1`
- `acceptance_criteria_updated_at TEXT`

新增 `task_memories`：

- `work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE`
- `version`、`memory_json`
- `acceptance_criteria_snapshot_json`
- `acceptance_criteria_work_version`
- `acceptance_criteria_work_updated_at`
- `summary`、`created_at`、`updated_at`

旧 Work 迁移后：验收标准 `[]`、版本 `1`、更新时间 `NULL`；不伪造历史验收标准。

## 3. 实现摘要

- `WorkService.create` 保存验收标准，并在同一事务内初始化 Task Memory。
- `WorkService.updateAcceptanceCriteria`：内容不变不递增版本；变化时同一事务内完成 Work 更新、版本递增、Task Memory 刷新与审计。
- 审计 `work.acceptance_criteria_changed`：from/to 版本、来源、时间、变更前后标准。
- Task Memory 刷新审计 `task_memory.acceptance_snapshot_refreshed`。
- `acceptance_criteria_version` 乐观并发控制；并发旧版本更新不会覆盖新版本。
- `ExecutionService` 在绑定 Work 的新执行启动前刷新 Task Memory。
- `TeamCollaborationService` 每次团队运行前重新读取 Work 并刷新 Task Memory；Leader/Member Prompt 注入正式验收标准与 Task Memory。
- Planner 创建团队任务支持 `projectId`，Core 校验项目存在且未归档；缺省使用 `prj-default`。
- 协议 Work DTO 与 `WorkCreateParams` 暴露验收标准字段。

## 4. 测试与门禁

实际执行：

- 定向测试：7 个文件 / 136 用例通过
- 全量测试：`pnpm test` → 102 文件 / 897 用例全部通过
- `pnpm typecheck` → 通过
- `pnpm lint` → 退出码 0，6 个既有 optional-chain warning，无 error
- `pnpm build` → 通过，发布构建检查通过

覆盖的 20 项验收点包括：创建保存、初始化、初始版本、修改递增、未修改不递增、事务回滚一致性、审计、无效/缺省项目、Planner 透传、Leader/Member Prompt、新 Execution 当前版本、过期刷新、旧 Work 不伪造、并发乐观锁、Work/Project 隔离、旧数据迁移完整、现有团队协作与执行回归。

## 5. 线上 v31 迁移记录

迁移前：

- 数据库：`~/Library/Application Support/agentra/agentra.db`
- `user_version=30`
- Works：2
- Executions：37（全部终态，无 pending/running/queued）
- `task_memories` 表：不存在

迁移前备份：

- Backup ID：`bak-a43451f6-05d6-4449-82b9-ad07f3233209`
- 包路径：`~/Library/Application Support/agentra/backups/bak-a43451f6-05d6-4449-82b9-ad07f3233209`
- 外置副本：`/Volumes/MacExt SSD/AgentraBackups/phase1a-pre-v31-20261109-063210`
- `database.db` SHA-256：`35d260a2ff012697718b8b3debfa26c3b6b636c8bbbcaa9606c34fe69e38c98b`
- 大小：276,934,656 bytes
- Manifest SHA 与实际 SHA 一致；副本与源文件逐字节一致
- `PRAGMA integrity_check`：`ok`
- 备份内 `user_version=30`、Works=2、Executions=37、无 `task_memories`

迁移执行：

- 使用新版本 Core 的 `migrate()`
- `fromVersion=30` → `toVersion=31`
- 应用迁移：`work_acceptance_and_task_memory`
- 迁移后 `PRAGMA integrity_check=ok`
- `PRAGMA foreign_key_check`：0 违规

迁移后核对：

- 旧 Works 仍为 2 条，名称/状态/项目归属不变
- 两个旧 Work：`acceptance_criteria_json='[]'`、`acceptance_criteria_version=1`、`acceptance_criteria_updated_at=NULL`
- `task_memories` 表存在，当前 0 行；旧 Work 在下次执行启动时安全创建
- 无 active Executions

应用启动验证：

- 新 Core PID 51944，`core.health` 返回 `status=ok`、`protocolVersion=1`
- `work.list` 返回 2 个旧 Work，新字段 `acceptanceCriteria=[]`、版本 1、更新时间 `null`
- Electron 窗口标题 `Agentra`，renderer 正常运行
- 启动日志 `database ready fromVersion=31 toVersion=31 applied=[]`
- 无启动 error；仅出现预期的 boot 阶段 `skip daemon recovery while core is not normal` warning

## 6. 工作区与 Git 状态

- 分支：`main`
- HEAD：`9a2c60a5ab1e28a32a5d93f44e4e4b8aa5d71d9f`
- 未 commit、未 reset、未 clean、未 checkout、未 stash、未删除未跟踪文件
- 归档时工作区：76 个条目 = 47 modified + 29 untracked（不含本归档文件）
- Phase 1A 新增文件：
  - `apps/core/src/db/repositories/task-memory-repository.ts`
  - `apps/core/src/services/task-memory-service.ts`
  - `apps/core/src/services/task-memory-service.test.ts`
- Phase 1A 修改的既有未跟踪文件：
  - `apps/core/src/services/planner-chat-service.ts`
  - `apps/core/src/services/planner-chat-service.test.ts`
  - `apps/core/src/services/team-collaboration-service.ts`
  - `apps/core/src/services/team-collaboration-service.test.ts`

## 7. 已知边界与后续

- 验收标准编辑的 RPC/UI 入口未在本阶段实现；修改能力当前在 Core 服务层，Planner 创建路径已完整持久化。该缺口不阻塞 Phase 1A 验收，应作为独立任务安排。
- Task Memory 当前自动填充 objective 与验收标准；约束、决策、测试、文件、问题等切片结构已具备，待后续阶段填充。
- Phase 1B 未授权、未启动。进入 Phase 1B 前需先完成设计门禁：文件/Artifact/测试证据绑定、Worktree 基线、哈希与版本一致性、降级策略、恢复失败保护。
