import { z } from 'zod'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  TaskMemoryRecord,
  TaskMemoryRepository,
} from '../db/repositories/task-memory-repository'
import type { WorkRecord } from '../db/repositories/work-repository'

const MemorySource = z
  .object({
    type: z.enum(['work', 'message', 'execution', 'artifact', 'test', 'user', 'planner']),
    id: z.string().min(1),
  })
  .strict()

const MemoryItem = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1).max(4000),
    verification: z.enum(['verified', 'inferred', 'pending']),
    source: MemorySource,
    updatedAt: z.string().min(1),
  })
  .strict()

const FileChange = z
  .object({
    path: z.string().min(1).max(4096),
    change: z.enum(['created', 'modified', 'deleted']),
    source: MemorySource.nullable().default(null),
  })
  .strict()

const TestResult = z
  .object({
    name: z.string().min(1).max(500),
    status: z.enum(['passed', 'failed', 'skipped']),
    at: z.string().min(1),
    source: MemorySource.nullable().default(null),
  })
  .strict()

export const TaskMemorySourceSchema = MemorySource
export const TaskMemoryItemSchema = MemoryItem

export const TaskMemorySchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    objective: z.string(),
    acceptanceCriteria: z
      .object({
        workVersion: z.number().int().min(1),
        workUpdatedAt: z.string().min(1),
        items: z.array(MemoryItem).max(20),
      })
      .strict(),
    constraints: z.array(MemoryItem).max(100),
    completed: z.array(MemoryItem).max(200),
    inProgress: z.array(MemoryItem).max(100),
    decisions: z.array(MemoryItem).max(100),
    tests: z.array(TestResult).max(200),
    files: z.array(FileChange).max(500),
    issues: z.array(MemoryItem).max(200),
    blockers: z.array(MemoryItem).max(100),
    nextActions: z.array(MemoryItem).max(100),
    openQuestions: z.array(MemoryItem).max(100),
    updatedAt: z.string().min(1),
  })
  .strict()
export type TaskMemory = z.infer<typeof TaskMemorySchema>
export type TaskMemoryItem = z.infer<typeof MemoryItem>

export type TaskMemoryServiceDeps = {
  db: Database
  memories: TaskMemoryRepository
  audit?: AuditRepository
  now?: () => string
}

/**
 * Task Memory 是 Work 的当前快照，不是聊天摘要。
 * Phase 1A 只做 Work/验收标准 seed 与刷新；Checkpoint 在 Phase 1B 才引入。
 */
export class TaskMemoryService {
  private readonly now: () => string

  constructor(private readonly deps: TaskMemoryServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  get(workId: string): TaskMemory | null {
    const record = this.deps.memories.get(workId)
    return record ? TaskMemorySchema.parse(JSON.parse(record.memoryJson)) : null
  }

  getVersion(workId: string): number | null {
    return this.deps.memories.get(workId)?.version ?? null
  }

  /** 由 WorkService 在创建 Work 的同一事务内调用；不要在此方法内再开事务。 */
  ensureForWorkInTransaction(work: WorkRecord): TaskMemory {
    const existing = this.deps.memories.get(work.id)
    if (existing) return TaskMemorySchema.parse(JSON.parse(existing.memoryJson))
    const now = this.now()
    const memory = this.buildMemory(work, now)
    const record = this.toRecord(work, memory, 1, now, now)
    this.deps.memories.insertIfMissing(record)
    const inserted = this.deps.memories.get(work.id)
    if (!inserted) throw new Error(`task memory insert failed: ${work.id}`)
    return TaskMemorySchema.parse(JSON.parse(inserted.memoryJson))
  }

  /** 新 Execution 前调用：确保 Work 验收标准快照是最新版本。 */
  refreshForWork(work: WorkRecord, source = 'execution_start'): TaskMemory {
    return transaction(this.deps.db, () => this.refreshForWorkInTransaction(work, source))
  }

  /** 在既有事务内刷新；WorkService 更新验收标准时使用。 */
  refreshForWorkInTransaction(work: WorkRecord, source = 'work_update'): TaskMemory {
    const existingRecord = this.deps.memories.get(work.id)
    if (!existingRecord) return this.ensureForWorkInTransaction(work)
    const existing = TaskMemorySchema.parse(JSON.parse(existingRecord.memoryJson))
    if (existing.acceptanceCriteria.workVersion >= work.acceptanceCriteriaVersion) {
      return existing
    }
    const now = this.now()
    const memory: TaskMemory = {
      ...existing,
      objective: work.objective,
      acceptanceCriteria: {
        workVersion: work.acceptanceCriteriaVersion,
        workUpdatedAt: work.acceptanceCriteriaUpdatedAt ?? now,
        items: this.acceptanceItems(work, now),
      },
      updatedAt: now,
    }
    const record = this.toRecord(
      work,
      memory,
      existingRecord.version + 1,
      existingRecord.createdAt,
      now,
    )
    if (!this.deps.memories.updateAcceptanceSnapshot(record)) {
      const concurrent = this.deps.memories.get(work.id)
      if (!concurrent) throw new Error(`task memory disappeared: ${work.id}`)
      return TaskMemorySchema.parse(JSON.parse(concurrent.memoryJson))
    }
    this.deps.audit?.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'task_memory.acceptance_snapshot_refreshed',
      targetType: 'work',
      targetId: work.id,
      details: {
        fromWorkVersion: existing.acceptanceCriteria.workVersion,
        toWorkVersion: work.acceptanceCriteriaVersion,
        source,
      },
      now,
    })
    return memory
  }

  private buildMemory(work: WorkRecord, now: string): TaskMemory {
    return {
      schemaVersion: 1,
      taskId: work.id,
      objective: work.objective,
      acceptanceCriteria: {
        workVersion: work.acceptanceCriteriaVersion,
        workUpdatedAt: work.acceptanceCriteriaUpdatedAt ?? now,
        items: this.acceptanceItems(work, now),
      },
      constraints: [],
      completed: [],
      inProgress: [],
      decisions: [],
      tests: [],
      files: [],
      issues: [],
      blockers: [],
      nextActions: [],
      openQuestions: [],
      updatedAt: now,
    }
  }

  private acceptanceItems(work: WorkRecord, now: string): TaskMemoryItem[] {
    return work.acceptanceCriteria.map((statement, index) => ({
      id: `ac-${index + 1}`,
      statement,
      verification: 'verified' as const,
      source: { type: 'work' as const, id: work.id },
      updatedAt: work.acceptanceCriteriaUpdatedAt ?? now,
    }))
  }

  private toRecord(
    work: WorkRecord,
    memory: TaskMemory,
    version: number,
    createdAt: string,
    updatedAt: string,
  ): TaskMemoryRecord {
    return {
      workId: work.id,
      version,
      memoryJson: JSON.stringify(memory),
      acceptanceCriteriaSnapshotJson: JSON.stringify(
        memory.acceptanceCriteria.items.map((item) => item.statement),
      ),
      acceptanceCriteriaWorkVersion: memory.acceptanceCriteria.workVersion,
      acceptanceCriteriaWorkUpdatedAt: memory.acceptanceCriteria.workUpdatedAt,
      summary: '',
      createdAt,
      updatedAt,
    }
  }
}

/** Phase 1A 的最小 Prompt 片段；Phase 1B 的 ContextBuilder 会替换它。 */
export function renderTaskMemoryForPrompt(memory: TaskMemory | null): string {
  if (!memory) return '(no task memory)'
  const renderItems = (items: TaskMemoryItem[]): string =>
    items.length === 0
      ? '(none)'
      : items
          .map(
            (item) =>
              `- [${item.verification}] ${item.statement} (source: ${item.source.type}:${item.source.id})`,
          )
          .join('\n')
  const renderTests = (tests: TaskMemory['tests']): string =>
    tests.length === 0
      ? '(none)'
      : tests
          .map(
            (test) =>
              `- [${test.status}] ${test.name} at ${test.at}${test.source ? ` (source: ${test.source.type}:${test.source.id})` : ''}`,
          )
          .join('\n')
  const renderFiles = (files: TaskMemory['files']): string =>
    files.length === 0
      ? '(none)'
      : files
          .map(
            (file) =>
              `- [${file.change}] ${file.path}${file.source ? ` (source: ${file.source.type}:${file.source.id})` : ''}`,
          )
          .join('\n')
  return [
    `Objective: ${memory.objective || '(none)'}`,
    `Acceptance criteria (Work v${memory.acceptanceCriteria.workVersion}):\n${renderItems(
      memory.acceptanceCriteria.items,
    )}`,
    `Constraints:\n${renderItems(memory.constraints)}`,
    `Completed:\n${renderItems(memory.completed)}`,
    `In progress:\n${renderItems(memory.inProgress)}`,
    `Decisions:\n${renderItems(memory.decisions)}`,
    `Tests:\n${renderTests(memory.tests)}`,
    `Files:\n${renderFiles(memory.files)}`,
    `Issues:\n${renderItems(memory.issues)}`,
    `Blockers:\n${renderItems(memory.blockers)}`,
    `Next actions:\n${renderItems(memory.nextActions)}`,
    `Open questions:\n${renderItems(memory.openQuestions)}`,
  ].join('\n')
}
