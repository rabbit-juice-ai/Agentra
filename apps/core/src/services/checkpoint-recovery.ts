import fs from 'node:fs'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import type { CheckpointRecord } from '../db/repositories/checkpoint-repository'
import type { WorkRecord } from '../db/repositories/work-repository'
import { collectArtifactEvidence } from './checkpoint-artifact-evidence'
import { hashCheckpointContent } from './checkpoint-hash'
import { hashFileNoFollow, resolveWithinRoot } from './checkpoint-path-safety'
import {
  CheckpointEvidenceSchema,
  CheckpointJsonSchema,
  type EvidenceStatus,
  type RecoveryEligibility,
  type RiskLevel,
  type SideEffectCompleteness,
} from './checkpoint-schemas'
import {
  computeCodeVersion,
  fileHashesFromEvidence,
  sameCodeVersion,
} from './checkpoint-test-evidence'
import type { WorktreeRecord } from './worktree-service'

export type RecoveryEvaluation = {
  eligibility: RecoveryEligibility
  evidenceStatus: EvidenceStatus
  sideEffectCompleteness: SideEffectCompleteness
  riskLevel: RiskLevel
}

function blocked(
  record: CheckpointRecord,
  reasons: string[],
  evidenceStatus: EvidenceStatus,
  sideEffectCompleteness: SideEffectCompleteness,
  riskLevel: RiskLevel,
): RecoveryEvaluation {
  return {
    eligibility: {
      status: 'blocked',
      planOnly: true,
      reasonCodes: [...new Set(reasons)],
      checkpointId: record.id,
      riskLevel,
      evidenceStatus,
      sideEffectCompleteness,
    },
    evidenceStatus,
    sideEffectCompleteness,
    riskLevel,
  }
}

/**
 * 读取时重新校验历史证据。Checkpoint 的 evidenceStatus 是创建时结论；
 * 工作区/Artifact 之后变化时，恢复资格必须重新计算，不能沿用旧结论。
 */
export function evaluateCheckpointRecovery(input: {
  record: CheckpointRecord
  work: WorkRecord
  worktree: WorktreeRecord | null
  artifacts: ArtifactRepository
  artifactsRoot: string
  now: string
}): RecoveryEvaluation {
  const { record, work, worktree } = input
  const reasons: string[] = []
  const sideEffectCompleteness = record.sideEffectCompleteness
  const riskLevel = record.riskLevel

  const expectedHash = hashCheckpointContent({
    schemaVersion: 1,
    workId: record.workId,
    seq: record.seq,
    baseDedupeKey: record.baseDedupeKey,
    dedupeKey: record.dedupeKey,
    attemptNo: record.attemptNo,
    state: record.state,
    kind: record.kind,
    stage: record.stage,
    executionId: record.executionId,
    sessionId: record.sessionId,
    nodeRunId: record.nodeRunId,
    teamRunId: record.teamRunId,
    parentCheckpointId: record.parentCheckpointId,
    acceptanceCriteriaWorkVersion: record.acceptanceCriteriaWorkVersion,
    taskMemoryVersion: record.taskMemoryVersion,
    riskLevel: record.riskLevel,
    evidenceStatus: record.evidenceStatus,
    sideEffectCompleteness: record.sideEffectCompleteness,
    checkpointJson: record.checkpointJson,
    evidenceJson: record.evidenceJson,
    verificationJson: record.verificationJson,
    errorJson: record.errorJson,
    createdAt: record.createdAt,
  })
  if (expectedHash !== record.contentHash) {
    return blocked(
      record,
      ['CHECKPOINT_CONTENT_HASH_MISMATCH'],
      'invalid',
      sideEffectCompleteness,
      riskLevel,
    )
  }
  if (record.state !== 'valid') {
    return blocked(
      record,
      ['CHECKPOINT_STATE_FAILED'],
      record.evidenceStatus,
      sideEffectCompleteness,
      riskLevel,
    )
  }

  let checkpointJson: ReturnType<typeof CheckpointJsonSchema.parse>
  let evidence: ReturnType<typeof CheckpointEvidenceSchema.parse>
  try {
    checkpointJson = CheckpointJsonSchema.parse(JSON.parse(record.checkpointJson))
    evidence = CheckpointEvidenceSchema.parse(JSON.parse(record.evidenceJson))
  } catch {
    return blocked(
      record,
      ['CHECKPOINT_CONTENT_HASH_MISMATCH'],
      'invalid',
      sideEffectCompleteness,
      riskLevel,
    )
  }
  if (
    checkpointJson.workId !== record.workId ||
    checkpointJson.seq !== record.seq ||
    checkpointJson.memoryVersion !== record.taskMemoryVersion ||
    checkpointJson.acceptanceCriteria.workVersion !== record.acceptanceCriteriaWorkVersion
  ) {
    return blocked(
      record,
      ['CHECKPOINT_TASK_MEMORY_STALE'],
      'invalid',
      sideEffectCompleteness,
      riskLevel,
    )
  }

  let invalid = false
  let missing = false
  let partial = false
  const requireReason = (code: string, required: boolean): void => {
    reasons.push(code)
    if (required) invalid = true
    else partial = true
  }

  for (const file of evidence.files) {
    if (file.rootKind === 'worktree') {
      if (!worktree || worktree.status !== 'active' || worktree.workId !== work.id) {
        reasons.push('WORKTREE_MISSING')
        invalid = true
        continue
      }
      if (worktree.id !== file.worktreeId) {
        reasons.push('WORKTREE_BASE_MISMATCH')
        invalid = true
        continue
      }
      if (file.baselineCommit && worktree.baseCommit !== file.baselineCommit) {
        reasons.push('WORKTREE_BASE_MISMATCH')
        invalid = true
        continue
      }
    }
    const root = file.rootKind === 'worktree' ? worktree?.worktreePath : work.rootPath
    if (!root) {
      reasons.push('WORKTREE_MISSING')
      invalid = true
      continue
    }
    if (file.verification === 'skipped') {
      requireReason(
        file.requirement === 'required' ? 'FILE_PATH_UNSAFE' : 'EVIDENCE_PARTIAL',
        file.requirement === 'required',
      )
      continue
    }
    try {
      const target = resolveWithinRoot(root, file.relativePath)
      const exists = existsNoFollow(target)
      if (file.status === 'deleted') {
        if (exists) requireReason('FILE_HASH_MISMATCH', file.requirement === 'required')
        continue
      }
      if (!exists) {
        if (file.requirement === 'required') {
          missing = true
          reasons.push('FILE_REQUIRED_MISSING')
        } else {
          partial = true
          reasons.push('EVIDENCE_PARTIAL')
        }
        continue
      }
      if (!file.sha256) {
        requireReason('FILE_REQUIRED_MISSING', file.requirement === 'required')
        continue
      }
      const hashed = hashFileNoFollow(target, 50 * 1024 * 1024)
      if (hashed.sha256 !== file.sha256) {
        requireReason('FILE_HASH_MISMATCH', file.requirement === 'required')
      }
    } catch {
      requireReason('FILE_PATH_UNSAFE', file.requirement === 'required')
    }
  }

  if (evidence.artifacts.length > 0) {
    const current = collectArtifactEvidence({
      refs: evidence.artifacts.map((item) => ({
        artifactId: item.artifactId,
        version: item.version,
        checksum: item.checksum || undefined,
        requirement: item.requirement,
        executionId: item.executionId,
      })),
      workId: work.id,
      executionId: record.executionId,
      artifacts: input.artifacts,
      artifactsRoot: input.artifactsRoot,
    })
    for (const artifact of current.artifacts) {
      if (artifact.verification === 'verified' || artifact.verification === 'not_required') continue
      const required = artifact.requirement === 'required'
      if (artifact.verification === 'missing') {
        if (required) missing = true
        else partial = true
        reasons.push(required ? 'ARTIFACT_MISSING' : 'EVIDENCE_PARTIAL')
      } else {
        requireReason('ARTIFACT_CHECKSUM_MISMATCH', required)
      }
    }
  }

  const root = worktree?.status === 'active' ? worktree.worktreePath : work.rootPath
  const currentCodeVersion = computeCodeVersion({
    root,
    worktreeId: worktree?.id ?? null,
    fileHashes: fileHashesFromEvidence(evidence.files),
  })
  for (const test of evidence.tests) {
    const required = test.requirement === 'required'
    if (test.result !== 'passed') {
      requireReason('TEST_FAILED_OR_SKIPPED', required)
      continue
    }
    if (test.trust !== 'runner' || test.verification === 'inferred') {
      if (required) invalid = true
      else partial = true
      reasons.push('TEST_UNVERIFIABLE')
      continue
    }
    if (!sameCodeVersion(test.codeVersion, currentCodeVersion)) {
      requireReason('TEST_CODE_VERSION_STALE', required)
    }
  }

  if (sideEffectCompleteness === 'not_tracked') reasons.push('SIDE_EFFECTS_NOT_TRACKED')
  if (riskLevel === 'high' && sideEffectCompleteness !== 'complete') {
    reasons.push('RISK_TOO_HIGH')
  }

  const evidenceStatus: EvidenceStatus =
    invalid || (riskLevel === 'high' && sideEffectCompleteness !== 'complete')
      ? 'invalid'
      : missing
        ? 'missing'
        : partial
          ? 'partial'
          : evidence.files.length + evidence.artifacts.length + evidence.tests.length === 0
            ? 'not_required'
            : 'verified'

  if (evidenceStatus === 'invalid' || evidenceStatus === 'missing') {
    return blocked(record, reasons, evidenceStatus, sideEffectCompleteness, riskLevel)
  }

  const status =
    riskLevel === 'high'
      ? 'conditional'
      : riskLevel === 'medium' || evidenceStatus === 'partial'
        ? 'conditional'
        : 'eligible'

  return {
    eligibility: {
      status,
      planOnly: true,
      reasonCodes: [...new Set(reasons)],
      checkpointId: record.id,
      riskLevel,
      evidenceStatus,
      sideEffectCompleteness,
    },
    evidenceStatus,
    sideEffectCompleteness,
    riskLevel,
  }
}

function existsNoFollow(filePath: string): boolean {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
  return !!stat && stat.isFile() && !stat.isSymbolicLink()
}
