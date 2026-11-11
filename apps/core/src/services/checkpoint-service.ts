import fs from 'node:fs'
import type { Execution } from '@agentra/protocol'
import { RpcMethodError } from '@agentra/protocol'
import { newId } from '@agentra/shared'
import type { Database } from '../db/database'
import { transaction } from '../db/database'
import type { AgentRepository } from '../db/repositories/agent-repository'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import type { AssignmentRepository } from '../db/repositories/assignment-repository'
import type { AuditRepository } from '../db/repositories/audit-repository'
import type {
  CheckpointRecord,
  CheckpointRepository,
} from '../db/repositories/checkpoint-repository'
import type {
  TeamTaskMessageRepository,
  TeamTaskRunRepository,
} from '../db/repositories/collaboration-repository'
import type { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import type { ExecutionRepository } from '../db/repositories/execution-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { SessionRepository } from '../db/repositories/session-repository'
import type { WorkRecord, WorkRepository } from '../db/repositories/work-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { type ArtifactEvidenceRef, collectArtifactEvidence } from './checkpoint-artifact-evidence'
import {
  collectExplicitFileEvidence,
  collectWorktreeFileEvidence,
  type FileEvidenceCollection,
} from './checkpoint-file-evidence'
import { canonicalJson, hashCheckpointContent } from './checkpoint-hash'
import { evaluateCheckpointRecovery } from './checkpoint-recovery'
import { classifyRisk, extractToolEvents } from './checkpoint-risk'
import {
  type CheckpointEvidence,
  CheckpointEvidenceSchema,
  type CheckpointJson,
  CheckpointJsonSchema,
  type CheckpointKind,
  type CheckpointStatus,
  type CheckpointVerification,
  type EvidenceStatus,
  type FileEvidence,
  type RecoveryEligibility,
  type RiskLevel,
  type SideEffectCompleteness,
  type TestEvidence,
} from './checkpoint-schemas'
import {
  collectAgentTestEvidence,
  computeCodeVersion,
  fileHashesFromEvidence,
} from './checkpoint-test-evidence'
import {
  buildContext,
  ContextBudgetExceededError,
  type ContextBuildResult,
} from './context-builder'
import type { TaskMemoryService } from './task-memory-service'
import type { WorktreeRecord, WorktreeService } from './worktree-service'

export const MAX_CHECKPOINT_ATTEMPTS = 3
const STRUCTURED_LOG_LIMIT = 2000

export type CheckpointCreationOutcome = 'created' | 'existing' | 'failed' | 'skipped'

export type CheckpointCreationResult = {
  outcome: CheckpointCreationOutcome
  checkpointId: string | null
  blocked: boolean
  riskLevel: RiskLevel
  evidenceStatus: EvidenceStatus
  sideEffectCompleteness: SideEffectCompleteness
  reasons: string[]
}

export type CheckpointCreationEvent = CheckpointCreationResult & {
  executionId: string
  checkpointState: 'valid' | 'failed' | null
}

export type RecoveryPlan = {
  checkpointId: string
  workId: string
  seq: number
  kind: CheckpointKind
  acceptanceCriteriaWorkVersion: number
  memoryVersion: number
  sections: ContextBuildResult['sections']
  manifest: ContextBuildResult['manifest']
  warnings: string[]
}

export type RecoveryPlanResult = {
  eligibility: RecoveryEligibility
  plan: RecoveryPlan | null
}

export type CheckpointServiceDeps = {
  db: Database
  checkpoints: CheckpointRepository
  works: WorkRepository
  executions: ExecutionRepository
  sessions: SessionRepository
  assignments: AssignmentRepository
  nodes: NodeRunRepository
  teamRuns: TeamTaskRunRepository
  workflowRuns: WorkflowRunRepository
  artifacts: ArtifactRepository
  logs: ExecutionLogRepository
  audit: AuditRepository
  agents: AgentRepository
  taskMemories: TaskMemoryService
  worktrees: WorktreeService
  teamMessages: TeamTaskMessageRepository
  artifactsRoot: string
  onCheckpointResult?: (event: CheckpointCreationEvent) => void
  now?: () => string
  logger?: { warn(message: string, data?: Record<string, unknown>): void }
}

type ExecutionContext = {
  executionId: string
  work: WorkRecord
  execution: Execution
  session: ReturnType<SessionRepository['get']>
  nodeRun: ReturnType<NodeRunRepository['get']>
  teamRun: ReturnType<TeamTaskRunRepository['getByExecutionId']>
  worktree: WorktreeRecord | null
  source: 'generic' | 'team' | 'node'
}

export class CheckpointService {
  private readonly now: () => string

  constructor(private readonly deps: CheckpointServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  createForExecution(
    executionId: string,
    source: 'generic' | 'team' | 'node' = 'generic',
    kind?: CheckpointKind,
  ): CheckpointCreationResult {
    const context = this.resolveExecutionContext(executionId, source)
    if (!context) {
      return skipped('EXECUTION_NOT_FOUND_OR_NOT_WORK_BOUND')
    }
    if (source === 'generic' && (context.nodeRun || context.teamRun)) {
      return skipped('SPECIALIZED_CHECKPOINT_OWNER')
    }
    if (source === 'node' && !context.nodeRun) return skipped('NODE_RUN_NOT_FOUND')
    if (source === 'team' && !context.teamRun) return skipped('TEAM_RUN_NOT_FOUND')
    if (!isTerminal(context.execution.status)) {
      return skipped('EXECUTION_NOT_TERMINAL')
    }

    const resolvedKind = kind ?? kindForExecutionStatus(context.execution.status)
    const baseDedupeKey = baseKeyForContext(context, resolvedKind)
    const existing = this.deps.checkpoints.getLatestAttempt(context.work.id, baseDedupeKey)
    if (existing?.state === 'valid') {
      this.auditDeduplicated(context.work.id, baseDedupeKey, existing.id)
      const result = resultFromRecord(existing, 'existing', false, [])
      this.emitCheckpointResult(context.execution.id, result, 'valid')
      return result
    }
    if (existing && existing.attemptNo >= MAX_CHECKPOINT_ATTEMPTS) {
      this.auditRetryLimit(context.work.id, baseDedupeKey, existing)
      const result: CheckpointCreationResult = {
        outcome: 'failed',
        checkpointId: existing.id,
        blocked: existing.riskLevel === 'high',
        riskLevel: existing.riskLevel,
        evidenceStatus: existing.evidenceStatus,
        sideEffectCompleteness: existing.sideEffectCompleteness,
        reasons: ['CHECKPOINT_RETRY_LIMIT_REACHED'],
      }
      this.emitCheckpointResult(context.execution.id, result, 'failed')
      return result
    }

    try {
      const result = this.createValidCheckpoint(context, resolvedKind, baseDedupeKey)
      this.emitCheckpointResult(context.execution.id, result, 'valid')
      return result
    } catch (error) {
      const result = this.recordFailure(context, resolvedKind, baseDedupeKey, error)
      this.emitCheckpointResult(context.execution.id, result, 'failed')
      return result
    }
  }

  createFinalDelivery(workId: string, completedAt: string): CheckpointCreationResult {
    const work = this.deps.works.get(workId)
    if (!work) return skipped('WORK_NOT_FOUND')
    const baseDedupeKey = `work:${workId}:final_delivery:${completedAt}`
    const existing = this.deps.checkpoints.getLatestAttempt(workId, baseDedupeKey)
    if (existing?.state === 'valid') {
      this.auditDeduplicated(workId, baseDedupeKey, existing.id)
      return resultFromRecord(existing, 'existing', false, [])
    }
    if (existing && existing.attemptNo >= MAX_CHECKPOINT_ATTEMPTS) {
      this.auditRetryLimit(workId, baseDedupeKey, existing)
      return {
        outcome: 'failed',
        checkpointId: existing.id,
        blocked: existing.riskLevel === 'high',
        riskLevel: existing.riskLevel,
        evidenceStatus: existing.evidenceStatus,
        sideEffectCompleteness: existing.sideEffectCompleteness,
        reasons: ['CHECKPOINT_RETRY_LIMIT_REACHED'],
      }
    }
    try {
      return this.createFinalCheckpoint(work, baseDedupeKey)
    } catch (error) {
      return this.recordFinalFailure(work, baseDedupeKey, error)
    }
  }

  assertCanStart(workId: string): void {
    const failures = this.deps.checkpoints.listLatestFailures(workId, 20)
    const blocking = failures.find((failure) => failure.riskLevel === 'high')
    if (!blocking) return
    throw new RpcMethodError(
      'INVALID_PARAMS',
      `RECOVERY_REQUIRED: work ${workId} has an unresolved high-risk checkpoint failure (${blocking.id}); manual recovery is required`,
      { code: 'RECOVERY_REQUIRED', checkpointId: blocking.id },
    )
  }

  retryPending(limit = 20): void {
    const failures = this.deps.checkpoints.listRetryableFailures(MAX_CHECKPOINT_ATTEMPTS, limit)
    for (const failure of failures) {
      try {
        if (failure.executionId) {
          const source = this.sourceForExecution(failure.executionId)
          this.createForExecution(failure.executionId, source, failure.kind)
        } else if (failure.kind === 'final_delivery') {
          const work = this.deps.works.get(failure.workId)
          if (work) this.createFinalCheckpoint(work, failure.baseDedupeKey)
        }
      } catch (error) {
        this.deps.logger?.warn('checkpoint retry failed', {
          checkpointId: failure.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  getCheckpoint(workId: string, checkpointId?: string): CheckpointRecord | null {
    const record = checkpointId
      ? this.deps.checkpoints.get(checkpointId)
      : this.deps.checkpoints.getLatestValid(workId)
    if (!record || record.workId !== workId) return null
    return record
  }

  getLatestValid(workId: string): CheckpointRecord | null {
    return this.deps.checkpoints.getLatestValid(workId)
  }

  getCheckpointForExecution(executionId: string): CheckpointRecord | null {
    return this.deps.checkpoints.getLatestByExecution(executionId)
  }

  getRecoveryPlan(workId: string, checkpointId?: string): RecoveryPlanResult {
    const work = this.deps.works.get(workId)
    const record = checkpointId
      ? this.deps.checkpoints.get(checkpointId)
      : this.deps.checkpoints.getLatestValid(workId)
    if (!record) {
      return {
        eligibility: {
          status: 'blocked',
          planOnly: true,
          reasonCodes: ['CHECKPOINT_NOT_FOUND'],
          checkpointId: null,
          riskLevel: null,
          evidenceStatus: null,
          sideEffectCompleteness: null,
        },
        plan: null,
      }
    }
    if (!work) {
      return {
        eligibility: {
          status: 'blocked',
          planOnly: true,
          reasonCodes: ['WORK_NOT_FOUND'],
          checkpointId: record.id,
          riskLevel: record.riskLevel,
          evidenceStatus: record.evidenceStatus,
          sideEffectCompleteness: record.sideEffectCompleteness,
        },
        plan: null,
      }
    }
    if (record.workId !== workId) {
      return {
        eligibility: {
          status: 'blocked',
          planOnly: true,
          reasonCodes: ['CHECKPOINT_WORK_MISMATCH'],
          checkpointId: record.id,
          riskLevel: record.riskLevel,
          evidenceStatus: record.evidenceStatus,
          sideEffectCompleteness: record.sideEffectCompleteness,
        },
        plan: null,
      }
    }

    let checkpointJson: ReturnType<typeof CheckpointJsonSchema.parse>
    let evidence: ReturnType<typeof CheckpointEvidenceSchema.parse>
    try {
      checkpointJson = CheckpointJsonSchema.parse(JSON.parse(record.checkpointJson))
      evidence = CheckpointEvidenceSchema.parse(JSON.parse(record.evidenceJson))
    } catch {
      return {
        eligibility: {
          status: 'blocked',
          planOnly: true,
          reasonCodes: ['CHECKPOINT_CONTENT_HASH_MISMATCH'],
          checkpointId: record.id,
          riskLevel: record.riskLevel,
          evidenceStatus: 'invalid',
          sideEffectCompleteness: record.sideEffectCompleteness,
        },
        plan: null,
      }
    }
    const worktree = this.worktreeForCheckpoint(work.id, evidence.files)
    const evaluation = evaluateCheckpointRecovery({
      record,
      work,
      worktree,
      artifacts: this.deps.artifacts,
      artifactsRoot: this.deps.artifactsRoot,
      now: this.now(),
    })
    if (evaluation.eligibility.status === 'blocked') {
      this.auditRecoveryBlocked(record, evaluation.eligibility.reasonCodes)
      return { eligibility: evaluation.eligibility, plan: null }
    }

    const taskMemory = this.deps.taskMemories.get(work.id) ?? checkpointJson.memory
    const messages = this.deps.teamMessages
      .listByWork(work.id, 200)
      .slice(-40)
      .map((message) => ({
        authorType: message.authorType,
        content: message.content,
        createdAt: message.createdAt,
      }))
    const artifactInputs = evidence.artifacts.map((artifact) => {
      const recordArtifact = this.deps.artifacts.getArtifact(artifact.artifactId)
      return {
        name: recordArtifact?.name ?? artifact.artifactId,
        version: artifact.version,
        checksum: artifact.checksum,
      }
    })
    try {
      const built = buildContext({
        work: {
          id: work.id,
          name: work.name,
          objective: work.objective,
          acceptanceCriteria: work.acceptanceCriteria,
          acceptanceCriteriaVersion: work.acceptanceCriteriaVersion,
        },
        taskMemory,
        checkpoint: {
          id: record.id,
          seq: record.seq,
          kind: record.kind,
          json: checkpointJson,
        },
        agent: null,
        messages,
        artifacts: artifactInputs,
        files: checkpointJson.files.map((file) => ({
          relativePath: file.relativePath,
          status: file.status,
          verification: file.verification,
        })),
        sideEffects: checkpointJson.sideEffects.refs,
      })
      this.deps.audit.append({
        actorType: 'system',
        actorId: 'agentra',
        action: 'context.built',
        targetType: 'work',
        targetId: work.id,
        details: {
          checkpointId: record.id,
          executionId: record.executionId,
          p0Bytes: built.manifest.sections.p0,
          p1Bytes: built.manifest.sections.p1,
          p2Bytes: built.manifest.sections.p2,
          p3Bytes: built.manifest.sections.p3,
          totalChars: built.manifest.totalChars,
          trimmed: built.manifest.trimmed,
          sourceRefs: built.manifest.sourceRefs,
        },
        now: this.now(),
      })
      return {
        eligibility: evaluation.eligibility,
        plan: {
          checkpointId: record.id,
          workId: work.id,
          seq: record.seq,
          kind: record.kind,
          acceptanceCriteriaWorkVersion: record.acceptanceCriteriaWorkVersion,
          memoryVersion: record.taskMemoryVersion ?? checkpointJson.memoryVersion,
          sections: built.sections,
          manifest: built.manifest,
          warnings: evaluation.eligibility.reasonCodes,
        },
      }
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) {
        const reasons = [...new Set([...evaluation.eligibility.reasonCodes, error.code])]
        this.deps.audit.append({
          actorType: 'system',
          actorId: 'agentra',
          action: 'context.budget_exceeded',
          targetType: 'work',
          targetId: work.id,
          details: {
            checkpointId: record.id,
            section: error.section,
            actualChars: error.actualChars,
            budgetChars: error.budgetChars,
          },
          now: this.now(),
        })
        this.auditRecoveryBlocked(record, reasons)
        return {
          eligibility: {
            ...evaluation.eligibility,
            status: 'blocked',
            reasonCodes: reasons,
          },
          plan: null,
        }
      }
      throw error
    }
  }

  private createValidCheckpoint(
    context: ExecutionContext,
    kind: CheckpointKind,
    baseDedupeKey: string,
  ): CheckpointCreationResult {
    const now = this.now()
    const taskMemory = this.deps.taskMemories.refreshForWork(context.work, 'checkpoint_create')
    const memoryVersion = this.deps.taskMemories.getVersion(context.work.id) ?? 1
    const fileEvidence = this.collectFileEvidence(context)
    const artifactRefs = this.artifactRefsForContext(context)
    const artifactEvidence = collectArtifactEvidence({
      refs: artifactRefs,
      workId: context.work.id,
      executionId: context.execution.id,
      artifacts: this.deps.artifacts,
      artifactsRoot: this.deps.artifactsRoot,
    })
    const root = context.worktree?.worktreePath ?? context.work.rootPath
    const codeVersion = computeCodeVersion({
      root,
      worktreeId: context.worktree?.id ?? null,
      fileHashes: fileHashesFromEvidence(fileEvidence.files),
    })
    const testEvidence = this.collectTestEvidence(context, codeVersion)
    const structured = this.deps.logs.listStructured(context.execution.id, STRUCTURED_LOG_LIMIT)
    const extracted = extractToolEvents(structured, structured.length < STRUCTURED_LOG_LIMIT)
    const agent = context.execution.agentId ? this.deps.agents.get(context.execution.agentId) : null
    const risk = classifyRisk({
      accessMode: agent?.accessMode ?? 'edit',
      toolEvents: extracted.events,
      toolEventsComplete: extracted.complete,
      rootKind: context.worktree ? 'worktree' : 'work_root',
      fileEvidenceTracked: fileEvidence.tracked,
      sideEffects: [],
    })
    const sideEffectCompleteness: SideEffectCompleteness = 'not_tracked'
    const evidence: CheckpointEvidence = {
      files: fileEvidence.files,
      artifacts: artifactEvidence.artifacts,
      tests: testEvidence,
      sideEffects: [],
      fileEvidenceTracked: fileEvidence.tracked,
      fileEvidenceCompleteness: fileEvidence.completeness,
      toolEventsComplete: extracted.complete,
      riskReasons: risk.reasons,
    }
    const aggregate = aggregateEvidence(evidence)
    const verification: CheckpointVerification = {
      files: evidence.files.map((file) => ({
        relativePath: file.relativePath,
        verification: file.verification,
        reasonCode: null,
      })),
      artifacts: evidence.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        version: artifact.version,
        verification: artifact.verification,
        reasonCode: null,
      })),
      tests: evidence.tests.map((test) => ({
        testKey: test.testKey,
        verification: test.verification,
        reasonCode: null,
      })),
      evidenceStatus: aggregate.status,
      sideEffectCompleteness,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      verifiedAt: now,
    }
    const blocked =
      risk.level === 'high' &&
      (aggregate.status === 'invalid' ||
        aggregate.status === 'missing' ||
        !isSideEffectComplete(sideEffectCompleteness))

    const created = transaction<
      { kind: 'existing'; record: CheckpointRecord } | { kind: 'created'; record: CheckpointRecord }
    >(this.deps.db, () => {
      const latest = this.deps.checkpoints.getLatestAttempt(context.work.id, baseDedupeKey)
      if (latest?.state === 'valid') return { kind: 'existing', record: latest }
      const attemptNo = latest ? latest.attemptNo + 1 : 1
      if (attemptNo > MAX_CHECKPOINT_ATTEMPTS) {
        throw new Error(`CHECKPOINT_RETRY_LIMIT_REACHED: ${baseDedupeKey}`)
      }
      const seq = this.deps.checkpoints.nextSeq(context.work.id)
      const dedupeKey = attemptNo === 1 ? baseDedupeKey : `${baseDedupeKey}#attempt-${attemptNo}`
      const checkpointJson: CheckpointJson = {
        schemaVersion: 1,
        workId: context.work.id,
        seq,
        kind,
        stage: stageForContext(context),
        status: checkpointStatus(context.work, context.execution.status),
        objective: context.work.objective,
        acceptanceCriteria: {
          workVersion: taskMemory.acceptanceCriteria.workVersion,
          workUpdatedAt: taskMemory.acceptanceCriteria.workUpdatedAt,
          items: taskMemory.acceptanceCriteria.items,
        },
        memoryVersion,
        memory: taskMemory,
        files: evidence.files.map((file) => ({
          relativePath: file.relativePath,
          status: file.status,
          requirement: file.requirement,
          verification: file.verification,
          sha256: file.sha256,
        })),
        artifacts: evidence.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          version: artifact.version,
          checksum: artifact.checksum,
          verification: artifact.verification,
        })),
        tests: evidence.tests.map((test) => ({
          testKey: test.testKey,
          name: test.name,
          result: test.result,
          trust: test.trust,
          verification: test.verification,
        })),
        sideEffects: { completeness: sideEffectCompleteness, refs: [] },
        session: {
          agentraSessionId: context.session?.id ?? null,
          providerSessionId: context.session?.externalSessionId ?? null,
          executionId: context.execution.id,
        },
        generatedBy: 'core',
        createdAt: now,
      }
      const checkpointJsonString = canonicalJson(checkpointJson)
      const evidenceJson = canonicalJson(evidence)
      const verificationJson = canonicalJson(verification)
      const contentHash = hashCheckpointContent({
        schemaVersion: 1,
        workId: context.work.id,
        seq,
        baseDedupeKey,
        dedupeKey,
        attemptNo,
        state: 'valid',
        kind,
        stage: checkpointJson.stage,
        executionId: context.execution.id,
        sessionId: context.session?.id ?? null,
        nodeRunId: context.nodeRun?.id ?? null,
        teamRunId: context.teamRun?.id ?? null,
        parentCheckpointId: this.deps.checkpoints.getLatestValid(context.work.id)?.id ?? null,
        acceptanceCriteriaWorkVersion: checkpointJson.acceptanceCriteria.workVersion,
        taskMemoryVersion: checkpointJson.memoryVersion,
        riskLevel: risk.level,
        evidenceStatus: aggregate.status,
        sideEffectCompleteness,
        checkpointJson: checkpointJsonString,
        evidenceJson,
        verificationJson,
        errorJson: null,
        createdAt: now,
      })
      const record: CheckpointRecord = {
        id: newId('chk'),
        workId: context.work.id,
        seq,
        baseDedupeKey,
        dedupeKey,
        attemptNo,
        state: 'valid',
        kind,
        stage: checkpointJson.stage,
        executionId: context.execution.id,
        sessionId: context.session?.id ?? null,
        nodeRunId: context.nodeRun?.id ?? null,
        teamRunId: context.teamRun?.id ?? null,
        parentCheckpointId: this.deps.checkpoints.getLatestValid(context.work.id)?.id ?? null,
        acceptanceCriteriaWorkVersion: checkpointJson.acceptanceCriteria.workVersion,
        taskMemoryVersion: checkpointJson.memoryVersion,
        riskLevel: risk.level,
        evidenceStatus: aggregate.status,
        sideEffectCompleteness,
        checkpointJson: checkpointJsonString,
        evidenceJson,
        verificationJson,
        errorJson: null,
        contentHash,
        createdAt: now,
      }
      this.deps.checkpoints.insert(record)
      this.deps.audit.append({
        actorType: 'system',
        actorId: 'agentra',
        action: 'checkpoint.created',
        targetType: 'work',
        targetId: context.work.id,
        details: {
          checkpointId: record.id,
          seq: record.seq,
          kind: record.kind,
          executionId: record.executionId,
          riskLevel: record.riskLevel,
          evidenceStatus: record.evidenceStatus,
          sideEffectCompleteness: record.sideEffectCompleteness,
          contentHash: record.contentHash,
          attemptNo: record.attemptNo,
        },
        now,
      })
      return { kind: 'created', record }
    })

    if (created.kind === 'existing') {
      this.auditDeduplicated(context.work.id, baseDedupeKey, created.record.id)
      return resultFromRecord(created.record, 'existing', false, [])
    }

    this.markExecutionCheckpoint(context.execution.id, {
      state: 'completed',
      checkpointId: created.record.id,
      completedAt: now,
    })
    return resultFromRecord(created.record, 'created', blocked, [
      ...aggregate.reasons,
      ...risk.reasons,
    ])
  }

  private createFinalCheckpoint(work: WorkRecord, baseDedupeKey: string): CheckpointCreationResult {
    const now = this.now()
    const taskMemory = this.deps.taskMemories.refreshForWork(work, 'checkpoint_final')
    const memoryVersion = this.deps.taskMemories.getVersion(work.id) ?? 1
    const latest = this.deps.checkpoints.getLatestValid(work.id)
    const latestEvidence = latest
      ? CheckpointEvidenceSchema.parse(JSON.parse(latest.evidenceJson))
      : null
    const worktree =
      this.worktreeForCheckpoint(work.id, latestEvidence?.files ?? []) ??
      this.deps.worktrees.list(work.id)[0] ??
      null
    const fileEvidence = worktree
      ? collectWorktreeFileEvidence(worktree, now)
      : collectExplicitFileEvidence({ root: work.rootPath, refs: [], now })
    const artifactRefs: ArtifactEvidenceRef[] = []
    for (const artifact of this.deps.artifacts.listByWork(work.id)) {
      const version = this.deps.artifacts.latestVersion(artifact.id)
      if (version) {
        artifactRefs.push({
          artifactId: artifact.id,
          version: version.version,
          checksum: version.checksum,
          requirement: 'required',
          executionId: null,
        })
      }
    }
    const artifactEvidence = collectArtifactEvidence({
      refs: artifactRefs,
      workId: work.id,
      executionId: null,
      artifacts: this.deps.artifacts,
      artifactsRoot: this.deps.artifactsRoot,
    })
    const riskLevel: RiskLevel = latest?.riskLevel ?? 'medium'
    const sideEffectCompleteness: SideEffectCompleteness = 'not_tracked'
    const evidence: CheckpointEvidence = {
      files: fileEvidence.files,
      artifacts: artifactEvidence.artifacts,
      tests: latestEvidence?.tests ?? [],
      sideEffects: [],
      fileEvidenceTracked: fileEvidence.tracked,
      fileEvidenceCompleteness: fileEvidence.completeness,
      toolEventsComplete: true,
      riskReasons: latest ? [latest.riskLevel] : ['final_delivery_without_execution_context'],
    }
    const aggregate = aggregateEvidence(evidence)
    const blocked =
      riskLevel === 'high' &&
      (aggregate.status === 'invalid' ||
        aggregate.status === 'missing' ||
        !isSideEffectComplete(sideEffectCompleteness))
    const verification: CheckpointVerification = {
      files: evidence.files.map((file) => ({
        relativePath: file.relativePath,
        verification: file.verification,
        reasonCode: null,
      })),
      artifacts: evidence.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        version: artifact.version,
        verification: artifact.verification,
        reasonCode: null,
      })),
      tests: evidence.tests.map((test) => ({
        testKey: test.testKey,
        verification: test.verification,
        reasonCode: null,
      })),
      evidenceStatus: aggregate.status,
      sideEffectCompleteness,
      riskLevel,
      riskReasons: evidence.riskReasons,
      verifiedAt: now,
    }

    const created = transaction<
      { kind: 'existing'; record: CheckpointRecord } | { kind: 'created'; record: CheckpointRecord }
    >(this.deps.db, () => {
      const currentLatest = this.deps.checkpoints.getLatestAttempt(work.id, baseDedupeKey)
      if (currentLatest?.state === 'valid') return { kind: 'existing', record: currentLatest }
      const attemptNo = currentLatest ? currentLatest.attemptNo + 1 : 1
      if (attemptNo > MAX_CHECKPOINT_ATTEMPTS) {
        throw new Error(`CHECKPOINT_RETRY_LIMIT_REACHED: ${baseDedupeKey}`)
      }
      const seq = this.deps.checkpoints.nextSeq(work.id)
      const dedupeKey = attemptNo === 1 ? baseDedupeKey : `${baseDedupeKey}#attempt-${attemptNo}`
      const checkpointJson: CheckpointJson = {
        schemaVersion: 1,
        workId: work.id,
        seq,
        kind: 'final_delivery',
        stage: 'final_delivery',
        status: 'done',
        objective: work.objective,
        acceptanceCriteria: {
          workVersion: taskMemory.acceptanceCriteria.workVersion,
          workUpdatedAt: taskMemory.acceptanceCriteria.workUpdatedAt,
          items: taskMemory.acceptanceCriteria.items,
        },
        memoryVersion,
        memory: taskMemory,
        files: evidence.files.map((file) => ({
          relativePath: file.relativePath,
          status: file.status,
          requirement: file.requirement,
          verification: file.verification,
          sha256: file.sha256,
        })),
        artifacts: evidence.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          version: artifact.version,
          checksum: artifact.checksum,
          verification: artifact.verification,
        })),
        tests: evidence.tests.map((test) => ({
          testKey: test.testKey,
          name: test.name,
          result: test.result,
          trust: test.trust,
          verification: test.verification,
        })),
        sideEffects: { completeness: sideEffectCompleteness, refs: [] },
        session: {
          agentraSessionId: null,
          providerSessionId: null,
          executionId: null,
        },
        generatedBy: 'core',
        createdAt: now,
      }
      const checkpointJsonString = canonicalJson(checkpointJson)
      const evidenceJson = canonicalJson(evidence)
      const verificationJson = canonicalJson(verification)
      const contentHash = hashCheckpointContent({
        schemaVersion: 1,
        workId: work.id,
        seq,
        baseDedupeKey,
        dedupeKey,
        attemptNo,
        state: 'valid',
        kind: 'final_delivery',
        stage: 'final_delivery',
        executionId: null,
        sessionId: null,
        nodeRunId: null,
        teamRunId: null,
        parentCheckpointId: this.deps.checkpoints.getLatestValid(work.id)?.id ?? null,
        acceptanceCriteriaWorkVersion: checkpointJson.acceptanceCriteria.workVersion,
        taskMemoryVersion: checkpointJson.memoryVersion,
        riskLevel,
        evidenceStatus: aggregate.status,
        sideEffectCompleteness,
        checkpointJson: checkpointJsonString,
        evidenceJson,
        verificationJson,
        errorJson: null,
        createdAt: now,
      })
      const record: CheckpointRecord = {
        id: newId('chk'),
        workId: work.id,
        seq,
        baseDedupeKey,
        dedupeKey,
        attemptNo,
        state: 'valid',
        kind: 'final_delivery',
        stage: 'final_delivery',
        executionId: null,
        sessionId: null,
        nodeRunId: null,
        teamRunId: null,
        parentCheckpointId: this.deps.checkpoints.getLatestValid(work.id)?.id ?? null,
        acceptanceCriteriaWorkVersion: checkpointJson.acceptanceCriteria.workVersion,
        taskMemoryVersion: checkpointJson.memoryVersion,
        riskLevel,
        evidenceStatus: aggregate.status,
        sideEffectCompleteness,
        checkpointJson: checkpointJsonString,
        evidenceJson,
        verificationJson,
        errorJson: null,
        contentHash,
        createdAt: now,
      }
      this.deps.checkpoints.insert(record)
      this.deps.audit.append({
        actorType: 'system',
        actorId: 'agentra',
        action: 'checkpoint.created',
        targetType: 'work',
        targetId: work.id,
        details: {
          checkpointId: record.id,
          seq: record.seq,
          kind: record.kind,
          riskLevel: record.riskLevel,
          evidenceStatus: record.evidenceStatus,
          sideEffectCompleteness: record.sideEffectCompleteness,
          contentHash: record.contentHash,
          attemptNo: record.attemptNo,
        },
        now,
      })
      return { kind: 'created', record }
    })

    if (created.kind === 'existing') {
      this.auditDeduplicated(work.id, baseDedupeKey, created.record.id)
      return resultFromRecord(created.record, 'existing', false, [])
    }
    return resultFromRecord(created.record, 'created', blocked, [
      ...aggregate.reasons,
      ...evidence.riskReasons,
    ])
  }

  private recordFailure(
    context: ExecutionContext,
    kind: CheckpointKind,
    baseDedupeKey: string,
    error: unknown,
  ): CheckpointCreationResult {
    const message = error instanceof Error ? error.message : String(error)
    const now = this.now()
    const riskLevel = this.assessRiskForContext(context)
    let existingValid: CheckpointRecord | null = null
    try {
      existingValid = transaction<CheckpointRecord | null>(this.deps.db, () => {
        const latest = this.deps.checkpoints.getLatestAttempt(context.work.id, baseDedupeKey)
        if (latest?.state === 'valid') {
          return latest
        }
        const attemptNo = latest ? latest.attemptNo + 1 : 1
        if (attemptNo > MAX_CHECKPOINT_ATTEMPTS) return null
        const seq = this.deps.checkpoints.nextSeq(context.work.id)
        const dedupeKey = attemptNo === 1 ? baseDedupeKey : `${baseDedupeKey}#attempt-${attemptNo}`
        const errorJson = canonicalJson({ message, kind, attemptNo })
        const checkpointJson = canonicalJson({
          schemaVersion: 1,
          workId: context.work.id,
          kind,
          error: message,
          createdAt: now,
        })
        const contentHash = hashCheckpointContent({
          schemaVersion: 1,
          workId: context.work.id,
          seq,
          baseDedupeKey,
          dedupeKey,
          attemptNo,
          state: 'failed',
          kind,
          stage: stageForContext(context),
          executionId: context.execution.id,
          sessionId: context.session?.id ?? null,
          nodeRunId: context.nodeRun?.id ?? null,
          teamRunId: context.teamRun?.id ?? null,
          parentCheckpointId: this.deps.checkpoints.getLatestValid(context.work.id)?.id ?? null,
          acceptanceCriteriaWorkVersion: context.work.acceptanceCriteriaVersion,
          taskMemoryVersion: null,
          riskLevel,
          evidenceStatus: 'missing',
          sideEffectCompleteness: 'not_tracked',
          checkpointJson,
          evidenceJson: '{}',
          verificationJson: '{}',
          errorJson,
          createdAt: now,
        })
        this.deps.checkpoints.insert({
          id: newId('chk'),
          workId: context.work.id,
          seq,
          baseDedupeKey,
          dedupeKey,
          attemptNo,
          state: 'failed',
          kind,
          stage: stageForContext(context),
          executionId: context.execution.id,
          sessionId: context.session?.id ?? null,
          nodeRunId: context.nodeRun?.id ?? null,
          teamRunId: context.teamRun?.id ?? null,
          parentCheckpointId: this.deps.checkpoints.getLatestValid(context.work.id)?.id ?? null,
          acceptanceCriteriaWorkVersion: context.work.acceptanceCriteriaVersion,
          taskMemoryVersion: null,
          riskLevel,
          evidenceStatus: 'missing',
          sideEffectCompleteness: 'not_tracked',
          checkpointJson,
          evidenceJson: '{}',
          verificationJson: '{}',
          errorJson,
          contentHash,
          createdAt: now,
        })
        this.deps.audit.append({
          actorType: 'system',
          actorId: 'agentra',
          action: 'checkpoint.failed',
          targetType: 'work',
          targetId: context.work.id,
          details: {
            kind,
            attemptNo,
            riskLevel,
            stage: stageForContext(context),
            errorCode: 'CHECKPOINT_CREATE_FAILED',
            blocked: riskLevel === 'high',
            message,
          },
          now,
        })
        return null
      })
    } catch (recordError) {
      this.deps.logger?.warn('checkpoint failure record failed', {
        workId: context.work.id,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      })
    }
    if (existingValid) {
      this.auditDeduplicated(context.work.id, baseDedupeKey, existingValid.id)
      return resultFromRecord(existingValid, 'existing', false, [])
    }
    this.markExecutionCheckpoint(context.execution.id, {
      state: 'failed',
      attempts:
        this.deps.checkpoints.getLatestAttempt(context.work.id, baseDedupeKey)?.attemptNo ?? 1,
      lastError: message,
      failedAt: now,
    })
    return {
      outcome: 'failed',
      checkpointId:
        this.deps.checkpoints.getLatestAttempt(context.work.id, baseDedupeKey)?.id ?? null,
      blocked: riskLevel === 'high',
      riskLevel,
      evidenceStatus: 'missing',
      sideEffectCompleteness: 'not_tracked',
      reasons: ['CHECKPOINT_CREATE_FAILED', message],
    }
  }

  private recordFinalFailure(
    work: WorkRecord,
    baseDedupeKey: string,
    error: unknown,
  ): CheckpointCreationResult {
    const message = error instanceof Error ? error.message : String(error)
    const now = this.now()
    let existingValid: CheckpointRecord | null = null
    try {
      existingValid = transaction<CheckpointRecord | null>(this.deps.db, () => {
        const latest = this.deps.checkpoints.getLatestAttempt(work.id, baseDedupeKey)
        if (latest?.state === 'valid') return latest
        const attemptNo = latest ? latest.attemptNo + 1 : 1
        if (attemptNo > MAX_CHECKPOINT_ATTEMPTS) return null
        const seq = this.deps.checkpoints.nextSeq(work.id)
        const dedupeKey = attemptNo === 1 ? baseDedupeKey : `${baseDedupeKey}#attempt-${attemptNo}`
        const errorJson = canonicalJson({ message, kind: 'final_delivery', attemptNo })
        const checkpointJson = canonicalJson({
          schemaVersion: 1,
          workId: work.id,
          kind: 'final_delivery',
          error: message,
          createdAt: now,
        })
        const contentHash = hashCheckpointContent({
          schemaVersion: 1,
          workId: work.id,
          seq,
          baseDedupeKey,
          dedupeKey,
          attemptNo,
          state: 'failed',
          kind: 'final_delivery',
          stage: 'final_delivery',
          executionId: null,
          sessionId: null,
          nodeRunId: null,
          teamRunId: null,
          parentCheckpointId: this.deps.checkpoints.getLatestValid(work.id)?.id ?? null,
          acceptanceCriteriaWorkVersion: work.acceptanceCriteriaVersion,
          taskMemoryVersion: null,
          riskLevel: 'medium',
          evidenceStatus: 'missing',
          sideEffectCompleteness: 'not_tracked',
          checkpointJson,
          evidenceJson: '{}',
          verificationJson: '{}',
          errorJson,
          createdAt: now,
        })
        this.deps.checkpoints.insert({
          id: newId('chk'),
          workId: work.id,
          seq,
          baseDedupeKey,
          dedupeKey,
          attemptNo,
          state: 'failed',
          kind: 'final_delivery',
          stage: 'final_delivery',
          executionId: null,
          sessionId: null,
          nodeRunId: null,
          teamRunId: null,
          parentCheckpointId: this.deps.checkpoints.getLatestValid(work.id)?.id ?? null,
          acceptanceCriteriaWorkVersion: work.acceptanceCriteriaVersion,
          taskMemoryVersion: null,
          riskLevel: 'medium',
          evidenceStatus: 'missing',
          sideEffectCompleteness: 'not_tracked',
          checkpointJson,
          evidenceJson: '{}',
          verificationJson: '{}',
          errorJson,
          contentHash,
          createdAt: now,
        })
        this.deps.audit.append({
          actorType: 'system',
          actorId: 'agentra',
          action: 'checkpoint.failed',
          targetType: 'work',
          targetId: work.id,
          details: {
            kind: 'final_delivery',
            attemptNo,
            riskLevel: 'medium',
            stage: 'final_delivery',
            errorCode: 'CHECKPOINT_CREATE_FAILED',
            blocked: false,
            message,
          },
          now,
        })
        return null
      })
    } catch (recordError) {
      this.deps.logger?.warn('final checkpoint failure record failed', {
        workId: work.id,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      })
    }
    if (existingValid) {
      this.auditDeduplicated(work.id, baseDedupeKey, existingValid.id)
      return resultFromRecord(existingValid, 'existing', false, [])
    }
    return {
      outcome: 'failed',
      checkpointId: this.deps.checkpoints.getLatestAttempt(work.id, baseDedupeKey)?.id ?? null,
      blocked: false,
      riskLevel: 'medium',
      evidenceStatus: 'missing',
      sideEffectCompleteness: 'not_tracked',
      reasons: ['CHECKPOINT_CREATE_FAILED', message],
    }
  }

  private resolveExecutionContext(
    executionId: string,
    source: 'generic' | 'team' | 'node',
  ): ExecutionContext | null {
    const execution = this.deps.executions.get(executionId)
    if (!execution) return null
    const nodeRunId = this.deps.executions.getNodeRunId(executionId)
    const nodeRun = nodeRunId ? this.deps.nodes.get(nodeRunId) : null
    const workflowRun = nodeRun ? this.deps.workflowRuns.get(nodeRun.workflowRunId) : null
    const teamRun = this.deps.teamRuns.getByExecutionId(executionId)
    const session = this.deps.sessions.get(execution.sessionId)
    const assignment = session?.assignmentId
      ? this.deps.assignments.get(session.assignmentId)
      : null
    const workId = teamRun?.workId ?? workflowRun?.workId ?? assignment?.workId ?? null
    if (!workId) return null
    const work = this.deps.works.get(workId)
    if (!work) return null
    return {
      executionId,
      work,
      execution,
      session,
      nodeRun,
      teamRun,
      worktree: this.findWorktreeForExecution(work, execution.workingDirectory),
      source,
    }
  }

  private sourceForExecution(executionId: string): 'generic' | 'team' | 'node' {
    if (this.deps.executions.getNodeRunId(executionId)) return 'node'
    if (this.deps.teamRuns.getByExecutionId(executionId)) return 'team'
    return 'generic'
  }

  private findWorktreeForExecution(
    work: WorkRecord,
    workingDirectory: string,
  ): WorktreeRecord | null {
    const active = this.deps.worktrees.list(work.id)
    let workingReal: string
    try {
      workingReal = fs.realpathSync(workingDirectory)
    } catch {
      return null
    }
    for (const worktree of active) {
      try {
        if (fs.realpathSync(worktree.worktreePath) === workingReal) return worktree
      } catch {}
    }
    return null
  }

  private collectFileEvidence(context: ExecutionContext): FileEvidenceCollection {
    if (context.worktree) {
      return collectWorktreeFileEvidence(context.worktree, this.now())
    }
    return collectExplicitFileEvidence({
      root: context.work.rootPath,
      refs: [],
      now: this.now(),
    })
  }

  private assessRiskForContext(context: ExecutionContext): RiskLevel {
    try {
      const structured = this.deps.logs.listStructured(context.execution.id, STRUCTURED_LOG_LIMIT)
      const extracted = extractToolEvents(structured, structured.length < STRUCTURED_LOG_LIMIT)
      const agent = context.execution.agentId
        ? this.deps.agents.get(context.execution.agentId)
        : null
      return classifyRisk({
        accessMode: agent?.accessMode ?? 'edit',
        toolEvents: extracted.events,
        toolEventsComplete: extracted.complete,
        rootKind: context.worktree ? 'worktree' : 'work_root',
        fileEvidenceTracked: false,
        sideEffects: [],
      }).level
    } catch {
      return 'medium'
    }
  }

  private artifactRefsForContext(context: ExecutionContext): ArtifactEvidenceRef[] {
    const refs: ArtifactEvidenceRef[] = []
    const seen = new Set<string>()
    const add = (ref: ArtifactEvidenceRef): void => {
      const key = `${ref.artifactId}:${ref.version}`
      if (seen.has(key)) return
      seen.add(key)
      refs.push(ref)
    }
    const outputArtifacts = context.nodeRun?.outputSnapshot?.artifacts
    if (Array.isArray(outputArtifacts)) {
      for (const item of outputArtifacts) {
        if (!item || typeof item !== 'object') continue
        const ref = item as Record<string, unknown>
        if (
          typeof ref.artifactId === 'string' &&
          typeof ref.version === 'number' &&
          typeof ref.checksum === 'string'
        ) {
          add({
            artifactId: ref.artifactId,
            version: ref.version,
            checksum: ref.checksum,
            requirement: 'required',
            executionId: context.execution.id,
          })
        }
      }
    }
    if (refs.length === 0) {
      for (const artifact of this.deps.artifacts.listByWork(context.work.id)) {
        const versions = this.deps.artifacts
          .listVersions(artifact.id)
          .filter((version) => version.metadata.executionId === context.execution.id)
        const latest = versions.sort((a, b) => b.version - a.version)[0]
        if (latest) {
          add({
            artifactId: artifact.id,
            version: latest.version,
            checksum: latest.checksum,
            requirement: 'required',
            executionId: context.execution.id,
          })
        }
      }
    }
    return refs
  }

  private collectTestEvidence(
    context: ExecutionContext,
    codeVersion: ReturnType<typeof computeCodeVersion>,
  ): TestEvidence[] {
    if (!context.nodeRun?.outputSnapshot) return []
    return collectAgentTestEvidence({
      nodeRunId: context.nodeRun.id,
      output: context.nodeRun.outputSnapshot,
      codeVersion,
    })
  }

  private worktreeForCheckpoint(workId: string, files: FileEvidence[]): WorktreeRecord | null {
    const worktreeId = files.find((file) => file.rootKind === 'worktree')?.worktreeId
    if (!worktreeId) return null
    const worktree = this.deps.worktrees.get(worktreeId)
    return worktree?.workId === workId ? worktree : null
  }

  private markExecutionCheckpoint(executionId: string, fragment: Record<string, unknown>): void {
    try {
      this.deps.executions.mergeRecoveryState(
        executionId,
        { checkpointProcessing: fragment },
        this.now(),
      )
    } catch (error) {
      this.deps.logger?.warn('checkpoint processing state write failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private emitCheckpointResult(
    executionId: string,
    result: CheckpointCreationResult,
    checkpointState: 'valid' | 'failed' | null,
  ): void {
    try {
      this.deps.onCheckpointResult?.({ ...result, executionId, checkpointState })
    } catch (error) {
      this.deps.logger?.warn('checkpoint result observer failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private auditRetryLimit(workId: string, baseDedupeKey: string, record: CheckpointRecord): void {
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'checkpoint.failed',
      targetType: 'work',
      targetId: workId,
      details: {
        checkpointId: record.id,
        baseDedupeKey,
        kind: record.kind,
        attemptNo: record.attemptNo,
        riskLevel: record.riskLevel,
        stage: record.stage,
        errorCode: 'CHECKPOINT_RETRY_LIMIT_REACHED',
        blocked: record.riskLevel === 'high',
      },
      now: this.now(),
    })
  }

  private auditDeduplicated(workId: string, baseDedupeKey: string, checkpointId: string): void {
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'checkpoint.deduplicated',
      targetType: 'work',
      targetId: workId,
      details: { baseDedupeKey, checkpointId },
      now: this.now(),
    })
  }

  private auditRecoveryBlocked(record: CheckpointRecord, reasons: string[]): void {
    this.deps.audit.append({
      actorType: 'system',
      actorId: 'agentra',
      action: 'checkpoint.recovery_blocked',
      targetType: 'work',
      targetId: record.workId,
      details: {
        checkpointId: record.id,
        reasonCodes: reasons,
        evidenceStatus: record.evidenceStatus,
        riskLevel: record.riskLevel,
        sideEffectCompleteness: record.sideEffectCompleteness,
      },
      now: this.now(),
    })
  }
}

function isSideEffectComplete(completeness: SideEffectCompleteness): boolean {
  return completeness === 'complete'
}

function isTerminal(status: string): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'crashed'
  )
}

function kindForExecutionStatus(status: string): CheckpointKind {
  if (status === 'cancelled') return 'user_cancelled'
  if (status === 'failed' || status === 'crashed') return 'execution_failed'
  return 'stage_complete'
}

function baseKeyForContext(context: ExecutionContext, kind: CheckpointKind): string {
  if (context.nodeRun) return `node:${context.nodeRun.id}:${kind}`
  if (context.teamRun) return `team_run:${context.teamRun.id}:${kind}`
  return `execution:${context.execution.id}:${kind}`
}

function stageForContext(context: ExecutionContext): string {
  if (context.nodeRun) return context.nodeRun.workflowNodeKey
  if (context.teamRun) return `team:${context.teamRun.role}`
  return 'execution'
}

function checkpointStatus(work: WorkRecord, executionStatus: string): CheckpointStatus {
  if (executionStatus === 'cancelled') return 'cancelled'
  if (executionStatus === 'failed' || executionStatus === 'crashed') return 'failed'
  if (work.status === 'completed' || work.issueStatus === 'done') return 'done'
  if (work.issueStatus === 'review') return 'review'
  return 'in_progress'
}

function aggregateEvidence(evidence: CheckpointEvidence): {
  status: EvidenceStatus
  reasons: string[]
} {
  const reasons: string[] = []
  let invalid = false
  let missing = false
  let partial = false
  let verified = false

  for (const file of evidence.files) {
    const required = file.requirement === 'required'
    if (file.verification === 'verified') {
      verified = true
      continue
    }
    if (file.verification === 'missing') {
      if (required) {
        missing = true
        reasons.push('FILE_REQUIRED_MISSING')
      } else {
        partial = true
        reasons.push('EVIDENCE_PARTIAL')
      }
      continue
    }
    if (required) invalid = true
    else partial = true
    reasons.push(required ? 'FILE_HASH_MISMATCH' : 'EVIDENCE_PARTIAL')
  }

  for (const artifact of evidence.artifacts) {
    const required = artifact.requirement === 'required'
    if (artifact.verification === 'verified' || artifact.verification === 'not_required') {
      verified = true
      continue
    }
    if (artifact.verification === 'missing') {
      if (required) missing = true
      else partial = true
      reasons.push(required ? 'ARTIFACT_MISSING' : 'EVIDENCE_PARTIAL')
      continue
    }
    if (required) invalid = true
    else partial = true
    reasons.push(required ? 'ARTIFACT_CHECKSUM_MISMATCH' : 'EVIDENCE_PARTIAL')
  }

  for (const test of evidence.tests) {
    const required = test.requirement === 'required'
    if (test.verification === 'verified') {
      verified = true
      continue
    }
    if (test.verification === 'inferred' || test.verification === 'unverifiable') {
      partial = true
      reasons.push('TEST_UNVERIFIABLE')
      continue
    }
    if (test.verification === 'missing') {
      if (required) missing = true
      else partial = true
      reasons.push(required ? 'TEST_MISSING' : 'EVIDENCE_PARTIAL')
      continue
    }
    if (required) invalid = true
    else partial = true
    reasons.push(required ? 'TEST_CODE_VERSION_STALE' : 'EVIDENCE_PARTIAL')
  }

  if (!evidence.fileEvidenceTracked) {
    partial = true
    reasons.push('FILE_EVIDENCE_NOT_TRACKED')
  } else if (evidence.fileEvidenceCompleteness === 'partial') {
    partial = true
    reasons.push('EVIDENCE_PARTIAL')
  }

  const status: EvidenceStatus = invalid
    ? 'invalid'
    : missing
      ? 'missing'
      : partial
        ? 'partial'
        : verified
          ? 'verified'
          : 'not_required'
  return { status, reasons: [...new Set(reasons)] }
}

function resultFromRecord(
  record: CheckpointRecord,
  outcome: CheckpointCreationOutcome,
  blocked: boolean,
  reasons: string[],
): CheckpointCreationResult {
  const highRiskBlocked =
    record.riskLevel === 'high' &&
    (record.evidenceStatus === 'invalid' ||
      record.evidenceStatus === 'missing' ||
      record.sideEffectCompleteness !== 'complete')
  return {
    outcome,
    checkpointId: record.id,
    blocked: blocked || highRiskBlocked,
    riskLevel: record.riskLevel,
    evidenceStatus: record.evidenceStatus,
    sideEffectCompleteness: record.sideEffectCompleteness,
    reasons: [...new Set(reasons)],
  }
}

function skipped(reason: string): CheckpointCreationResult {
  return {
    outcome: 'skipped',
    checkpointId: null,
    blocked: false,
    riskLevel: 'low',
    evidenceStatus: 'not_required',
    sideEffectCompleteness: 'not_tracked',
    reasons: [reason],
  }
}
