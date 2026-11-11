import { z } from 'zod'

export const WORK_RECOVERY_PLAN_METHOD = 'work.recovery.plan'
export const WORK_RECOVERY_START_METHOD = 'work.recovery.start'

export const WorkRecoveryPlanParams = z
  .object({
    workId: z.string().min(1),
    checkpointId: z.string().min(1).optional(),
  })
  .strict()
export type WorkRecoveryPlanParams = z.infer<typeof WorkRecoveryPlanParams>

export const WorkRecoveryEligibility = z
  .object({
    status: z.enum(['eligible', 'conditional', 'blocked']),
    planOnly: z.literal(true),
    reasonCodes: z.array(z.string().max(100)).max(50),
    riskLevel: z.enum(['low', 'medium', 'high']).nullable(),
    evidenceStatus: z.string().max(50).nullable(),
    sideEffectCompleteness: z.string().max(50).nullable(),
  })
  .strict()

export const WorkRecoveryPlanResult = z
  .object({
    plan: z
      .object({
        workId: z.string().min(1),
        checkpointId: z.string().min(1),
        checkpointSeq: z.number().int().min(1),
        checkpointKind: z.string().min(1),
        isLatest: z.boolean(),
        workStatus: z.string().min(1),
        workIssueStatus: z.string().min(1),
        eligibility: WorkRecoveryEligibility,
        limits: z
          .object({
            maxAttempts: z.number().int().min(1),
            attemptsUsed: z.number().int().min(0),
            remainingAttempts: z.number().int().min(0),
            activeAttemptId: z.string().min(1).nullable(),
          })
          .strict(),
        contextBudget: z
          .object({
            totalChars: z.number().int().min(0),
            p0Chars: z.number().int().min(0),
            p0Bytes: z.number().int().min(0),
            p1Bytes: z.number().int().min(0),
            p2Bytes: z.number().int().min(0),
            p3Bytes: z.number().int().min(0),
            trimmed: z.object({ p1: z.boolean(), p2: z.boolean(), p3: z.boolean() }).strict(),
          })
          .strict(),
        reopen: z
          .object({
            required: z.boolean(),
            originalWorkStatus: z.literal('completed').nullable(),
            reasonRequired: z.boolean(),
          })
          .strict(),
        sections: z
          .object({
            p0: z.string(),
            p1: z.string(),
            p2: z.string(),
            p3: z.string(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
export type WorkRecoveryPlanResult = z.infer<typeof WorkRecoveryPlanResult>

export const WorkRecoveryStartParams = z
  .object({
    workId: z.string().min(1),
    checkpointId: z.string().min(1),
    confirm: z.boolean(),
    acknowledgeRisk: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(200),
    reopenReason: z.string().max(4000).optional(),
  })
  .strict()
export type WorkRecoveryStartParams = z.infer<typeof WorkRecoveryStartParams>

export const WorkRecoveryStartResult = z
  .object({
    recoveryAttemptId: z.string().min(1),
    status: z.enum(['starting', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']),
    executionId: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    teamRunId: z.string().min(1).nullable(),
    idempotentReplay: z.boolean(),
  })
  .strict()
export type WorkRecoveryStartResult = z.infer<typeof WorkRecoveryStartResult>
