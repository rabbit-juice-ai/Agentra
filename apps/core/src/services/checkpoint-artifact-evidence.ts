import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import { hashFileNoFollow, resolveWithinRoot } from './checkpoint-path-safety'
import type { ArtifactEvidence } from './checkpoint-schemas'

export type ArtifactEvidenceRef = {
  artifactId: string
  version: number
  checksum?: string
  requirement: 'required' | 'reference'
  executionId?: string | null
}

export type ArtifactEvidenceCollection = {
  artifacts: ArtifactEvidence[]
  requiredCount: number
}

const MAX_ARTIFACT_EVIDENCE_BYTES = 50 * 1024 * 1024

/**
 * Artifact 证据只存引用，不复制内容。
 * 校验顺序：DB 行 → Work 归属 → 版本 → checksum → 文件存在 → 文件 SHA-256。
 */
export function collectArtifactEvidence(input: {
  refs: ArtifactEvidenceRef[]
  workId: string
  executionId: string | null
  artifacts: ArtifactRepository
  artifactsRoot: string
}): ArtifactEvidenceCollection {
  const evidence: ArtifactEvidence[] = []
  for (const ref of input.refs) {
    const artifact = input.artifacts.getArtifact(ref.artifactId)
    const version = input.artifacts.findByArtifactAndVersion(ref.artifactId, ref.version)
    const base = {
      artifactId: ref.artifactId,
      versionId: version?.id ?? null,
      version: ref.version,
      checksum: version?.checksum ?? ref.checksum ?? '',
      workId: input.workId,
      executionId: ref.executionId ?? input.executionId,
      requirement: ref.requirement,
    } as const

    if (!artifact || !version) {
      evidence.push({ ...base, verification: 'missing' })
      continue
    }
    if (artifact.workId !== input.workId) {
      evidence.push({ ...base, verification: 'mismatch' })
      continue
    }
    if (ref.checksum && ref.checksum !== version.checksum) {
      evidence.push({ ...base, verification: 'mismatch' })
      continue
    }

    try {
      const absolute = path.resolve(version.storagePath)
      const relative = path.relative(path.resolve(input.artifactsRoot), absolute)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        evidence.push({ ...base, verification: 'mismatch' })
        continue
      }
      const target = resolveWithinRoot(input.artifactsRoot, relative)
      if (!fs.existsSync(target)) {
        evidence.push({ ...base, verification: 'missing' })
        continue
      }
      const hashed = hashFileNoFollow(target, MAX_ARTIFACT_EVIDENCE_BYTES)
      evidence.push({
        ...base,
        verification: hashed.sha256 === version.checksum ? 'verified' : 'mismatch',
      })
    } catch {
      evidence.push({ ...base, verification: 'mismatch' })
    }
  }
  return {
    artifacts: evidence,
    requiredCount: evidence.filter((item) => item.requirement === 'required').length,
  }
}
