import { z } from 'zod'
import { TaskMemoryItemSchema, TaskMemorySchema } from './task-memory-service'

export const CHECKPOINT_KINDS = [
  'stage_complete',
  'execution_failed',
  'user_cancelled',
  'rework_started',
  'rework_completed',
  'final_delivery',
  'session_switch',
  'compression',
] as const
export const CheckpointKindSchema = z.enum(CHECKPOINT_KINDS)
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>

export const CheckpointStateSchema = z.enum(['valid', 'failed'])
export type CheckpointState = z.infer<typeof CheckpointStateSchema>

export const RiskLevelSchema = z.enum(['low', 'medium', 'high'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const EvidenceStatusSchema = z.enum([
  'verified',
  'partial',
  'invalid',
  'missing',
  'not_required',
])
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>

export const SideEffectCompletenessSchema = z.enum(['complete', 'partial', 'not_tracked'])
export type SideEffectCompleteness = z.infer<typeof SideEffectCompletenessSchema>

export const FileEvidenceSchema = z
  .object({
    rootKind: z.enum(['worktree', 'work_root']),
    worktreeId: z.string().min(1).nullable(),
    baselineCommit: z.string().min(1).nullable(),
    relativePath: z.string().min(1).max(4096),
    status: z.enum(['created', 'modified', 'deleted']),
    requirement: z.enum(['required', 'reference']),
    size: z.number().int().nonnegative().nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    verifiedAt: z.string().min(1),
    verification: z.enum(['verified', 'missing', 'mismatch', 'skipped']),
    skipReason: z.enum(['too_large', 'excluded', 'symlink', 'unreadable']).nullable().default(null),
  })
  .strict()
export type FileEvidence = z.infer<typeof FileEvidenceSchema>

export const ArtifactEvidenceSchema = z
  .object({
    artifactId: z.string().min(1),
    versionId: z.string().min(1).nullable(),
    version: z.number().int().min(1),
    checksum: z.string().max(128),
    workId: z.string().min(1),
    executionId: z.string().min(1).nullable(),
    requirement: z.enum(['required', 'reference']),
    verification: z.enum(['verified', 'missing', 'mismatch', 'not_required']),
  })
  .strict()
export type ArtifactEvidence = z.infer<typeof ArtifactEvidenceSchema>

export const CodeVersionSchema = z
  .object({
    worktreeId: z.string().min(1).nullable(),
    gitCommit: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/)
      .nullable(),
    dirty: z.boolean(),
    diffHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    fileHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict()
export type CodeVersion = z.infer<typeof CodeVersionSchema>

export const TestEvidenceSchema = z
  .object({
    testKey: z.string().min(1).max(500),
    name: z.string().min(1).max(500),
    command: z.string().max(4000).nullable(),
    result: z.enum(['passed', 'failed', 'skipped']),
    trust: z.enum(['runner', 'agent_claimed']),
    requirement: z.enum(['required', 'reference']),
    startedAt: z.string().min(1).nullable(),
    endedAt: z.string().min(1).nullable(),
    codeVersion: CodeVersionSchema.nullable(),
    reportArtifact: z
      .object({
        artifactId: z.string().min(1),
        version: z.number().int().min(1),
        checksum: z.string().min(1).max(128),
      })
      .strict()
      .nullable(),
    verification: z.enum(['verified', 'stale', 'missing', 'unverifiable', 'inferred']),
  })
  .strict()
export type TestEvidence = z.infer<typeof TestEvidenceSchema>

export const SideEffectRefSchema = z
  .object({
    effectKey: z.string().min(1).max(500),
    kind: z.enum([
      'deploy',
      'publish',
      'message',
      'external_write',
      'irreversible_command',
      'other',
    ]),
    status: z.enum(['not_started', 'in_progress', 'succeeded', 'failed', 'unknown']),
    completeness: SideEffectCompletenessSchema,
    executionId: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    toolCallKey: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1).nullable(),
    evidenceRef: z.string().min(1).nullable(),
    observedAt: z.string().min(1).nullable(),
    riskLevel: RiskLevelSchema,
  })
  .strict()
export type SideEffectRef = z.infer<typeof SideEffectRefSchema>

export const CheckpointEvidenceSchema = z
  .object({
    files: z.array(FileEvidenceSchema).max(5000),
    artifacts: z.array(ArtifactEvidenceSchema).max(500),
    tests: z.array(TestEvidenceSchema).max(200),
    sideEffects: z.array(SideEffectRefSchema).max(500),
    fileEvidenceTracked: z.boolean(),
    fileEvidenceCompleteness: SideEffectCompletenessSchema,
    toolEventsComplete: z.boolean(),
    riskReasons: z.array(z.string().max(500)).max(100),
  })
  .strict()
export type CheckpointEvidence = z.infer<typeof CheckpointEvidenceSchema>

const FileVerificationSchema = z
  .object({
    relativePath: z.string().min(1),
    verification: z.enum(['verified', 'missing', 'mismatch', 'skipped']),
    reasonCode: z.string().max(100).nullable(),
  })
  .strict()

const ArtifactVerificationSchema = z
  .object({
    artifactId: z.string().min(1),
    version: z.number().int().min(1),
    verification: z.enum(['verified', 'missing', 'mismatch', 'not_required']),
    reasonCode: z.string().max(100).nullable(),
  })
  .strict()

const TestVerificationSchema = z
  .object({
    testKey: z.string().min(1),
    verification: z.enum(['verified', 'stale', 'missing', 'unverifiable', 'inferred']),
    reasonCode: z.string().max(100).nullable(),
  })
  .strict()

export const CheckpointVerificationSchema = z
  .object({
    files: z.array(FileVerificationSchema).max(5000),
    artifacts: z.array(ArtifactVerificationSchema).max(500),
    tests: z.array(TestVerificationSchema).max(200),
    evidenceStatus: EvidenceStatusSchema,
    sideEffectCompleteness: SideEffectCompletenessSchema,
    riskLevel: RiskLevelSchema,
    riskReasons: z.array(z.string().max(500)).max(100),
    verifiedAt: z.string().min(1),
  })
  .strict()
export type CheckpointVerification = z.infer<typeof CheckpointVerificationSchema>

export const CheckpointStatusSchema = z.enum([
  'in_progress',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
])
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>

const FileEvidenceSummarySchema = z
  .object({
    relativePath: z.string().min(1),
    status: z.enum(['created', 'modified', 'deleted']),
    requirement: z.enum(['required', 'reference']),
    verification: z.enum(['verified', 'missing', 'mismatch', 'skipped']),
    sha256: z.string().nullable(),
  })
  .strict()

const ArtifactEvidenceSummarySchema = z
  .object({
    artifactId: z.string().min(1),
    version: z.number().int().min(1),
    checksum: z.string().min(1),
    verification: z.enum(['verified', 'missing', 'mismatch', 'not_required']),
  })
  .strict()

const TestEvidenceSummarySchema = z
  .object({
    testKey: z.string().min(1),
    name: z.string().min(1),
    result: z.enum(['passed', 'failed', 'skipped']),
    trust: z.enum(['runner', 'agent_claimed']),
    verification: z.enum(['verified', 'stale', 'missing', 'unverifiable', 'inferred']),
  })
  .strict()

export const CheckpointJsonSchema = z
  .object({
    schemaVersion: z.literal(1),
    workId: z.string().min(1),
    seq: z.number().int().min(1),
    kind: CheckpointKindSchema,
    stage: z.string().max(500).default(''),
    status: CheckpointStatusSchema,
    objective: z.string().max(20_000),
    acceptanceCriteria: z
      .object({
        workVersion: z.number().int().min(1),
        workUpdatedAt: z.string().min(1).nullable(),
        items: z.array(TaskMemoryItemSchema).max(20),
      })
      .strict(),
    memoryVersion: z.number().int().min(1),
    memory: TaskMemorySchema,
    files: z.array(FileEvidenceSummarySchema).max(5000),
    artifacts: z.array(ArtifactEvidenceSummarySchema).max(500),
    tests: z.array(TestEvidenceSummarySchema).max(200),
    sideEffects: z
      .object({
        completeness: SideEffectCompletenessSchema,
        refs: z.array(SideEffectRefSchema).max(500),
      })
      .strict(),
    session: z
      .object({
        agentraSessionId: z.string().min(1).nullable(),
        providerSessionId: z.string().min(1).nullable(),
        executionId: z.string().min(1).nullable(),
      })
      .strict(),
    generatedBy: z.literal('core'),
    createdAt: z.string().min(1),
  })
  .strict()
export type CheckpointJson = z.infer<typeof CheckpointJsonSchema>

export const RecoveryEligibilityStatusSchema = z.enum(['eligible', 'conditional', 'blocked'])
export type RecoveryEligibilityStatus = z.infer<typeof RecoveryEligibilityStatusSchema>

export const RecoveryEligibilitySchema = z
  .object({
    status: RecoveryEligibilityStatusSchema,
    planOnly: z.literal(true),
    reasonCodes: z.array(z.string().max(100)).max(50),
    checkpointId: z.string().min(1).nullable(),
    riskLevel: RiskLevelSchema.nullable(),
    evidenceStatus: EvidenceStatusSchema.nullable(),
    sideEffectCompleteness: SideEffectCompletenessSchema.nullable(),
  })
  .strict()
export type RecoveryEligibility = z.infer<typeof RecoveryEligibilitySchema>
