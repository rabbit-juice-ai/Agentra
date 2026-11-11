import { z } from 'zod'

export const WORKFLOW_NODE_RECOVERY_PLAN_METHOD = 'workflow.node.recovery.plan'
export const WORKFLOW_NODE_RECOVERY_START_METHOD = 'workflow.node.recovery.start'

export const WorkflowNodeRecoveryPlanParams = z
  .object({
    workflowRunId: z.string().min(1),
    nodeRunId: z.string().min(1),
    checkpointId: z.string().min(1).optional(),
  })
  .strict()
export type WorkflowNodeRecoveryPlanParams = z.infer<typeof WorkflowNodeRecoveryPlanParams>

export const WorkflowNodeRecoveryPlanResult = z
  .object({
    plan: z
      .object({
        target: z
          .object({
            workflowRunId: z.string().min(1),
            branchRunId: z.string().min(1).nullable(),
            branchKey: z.string().min(1).nullable(),
            nodeKey: z.string().min(1),
            nodeRunId: z.string().min(1),
            attempt: z.number().int().min(1),
            status: z.string().min(1),
            recoveryChainId: z.string().min(1),
          })
          .strict(),
        eligibility: z
          .object({
            status: z.enum(['eligible', 'conditional', 'blocked']),
            planOnly: z.literal(true),
            reasonCodes: z.array(z.string().max(120)).max(50),
            riskLevel: z.enum(['low', 'medium', 'high']).nullable(),
            evidenceStatus: z.string().max(50).nullable(),
            sideEffectCompleteness: z.string().max(50).nullable(),
            executionEvidence: z.enum(['not_started', 'terminal', 'active', 'unconfirmed']),
            requiresRiskAcknowledgement: z.boolean(),
          })
          .strict(),
        checkpoint: z
          .object({
            id: z.string().min(1),
            seq: z.number().int().min(1),
            kind: z.string().min(1),
            isLatest: z.boolean(),
            nodeRunId: z.string().min(1).nullable(),
          })
          .strict()
          .nullable(),
        limits: z
          .object({
            maxAttempts: z.number().int().min(1),
            attemptsUsed: z.number().int().min(0),
            remainingAttempts: z.number().int().min(0),
            activeRecoveryAttemptId: z.string().min(1).nullable(),
          })
          .strict(),
        nextAttempt: z
          .object({
            attempt: z.number().int().min(1),
            branchRunId: z.string().min(1).nullable(),
          })
          .strict(),
        worktree: z
          .object({
            required: z.literal(true),
            policy: z.enum(['worktree', 'work_root', 'shared']),
            branchNamePreview: z.string().min(1).nullable(),
            blockers: z.array(z.string().max(120)).max(20),
          })
          .strict(),
        chain: z
          .object({
            key: z.string().min(1),
            attemptNo: z.number().int().min(1),
            attemptsUsed: z.number().int().min(0),
          })
          .strict(),
        runReentry: z
          .object({
            required: z.boolean(),
            allowed: z.boolean(),
            blockers: z.array(z.string().max(120)).max(20),
          })
          .strict(),
        contextBudget: z
          .object({
            totalChars: z.number().int().min(0),
            trimmed: z.object({ p1: z.boolean(), p2: z.boolean(), p3: z.boolean() }).strict(),
          })
          .strict(),
        sections: z
          .object({ p0: z.string(), p1: z.string(), p2: z.string(), p3: z.string() })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
export type WorkflowNodeRecoveryPlanResult = z.infer<typeof WorkflowNodeRecoveryPlanResult>

export const WorkflowNodeRecoveryStartParams = z
  .object({
    workflowRunId: z.string().min(1),
    nodeRunId: z.string().min(1),
    checkpointId: z.string().min(1).optional(),
    confirm: z.boolean(),
    acknowledgeRisk: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict()
export type WorkflowNodeRecoveryStartParams = z.infer<typeof WorkflowNodeRecoveryStartParams>

export const WorkflowNodeRecoveryStartResult = z
  .object({
    recoveryAttemptId: z.string().min(1),
    status: z.enum(['starting', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']),
    newNodeRunId: z.string().min(1),
    executionId: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    idempotentReplay: z.boolean(),
  })
  .strict()
export type WorkflowNodeRecoveryStartResult = z.infer<typeof WorkflowNodeRecoveryStartResult>
