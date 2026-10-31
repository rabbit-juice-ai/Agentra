import { z } from 'zod'

/** 定义格式版本；schemaVersion 位于 definition 顶层（checksum 输入集 {schemaVersion, nodes, edges, settings}）。 */
export const SCHEMA_VERSION = 1

export const NODE_TYPES = [
  'start',
  'agent_task',
  'parallel_split',
  'join',
  'human_approval',
  'condition',
  'end',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const KEY_PATTERN = /^[a-z0-9_-]{1,64}$/

const KeySchema = z.string().regex(KEY_PATTERN, 'must match [a-z0-9_-]{1,64}')

const PositionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
})

// ---------------------------------------------------------------------------
// Condition 表达式（AST，禁止表达式文本与 eval）
// ---------------------------------------------------------------------------

export type ConditionLiteral = string | number | boolean | null
export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in'

export type ConditionOperand =
  | { kind: 'field'; path: string }
  | { kind: 'literal'; value: ConditionLiteral | ConditionLiteral[] }

export type ConditionExpr =
  | { kind: 'comparison'; op: ComparisonOp; left: ConditionOperand; right: ConditionOperand }
  | { kind: 'logical'; op: 'and' | 'or'; operands: ConditionExpr[] }
  | { kind: 'not'; operand: ConditionExpr }

const ConditionLiteralSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

const FieldOperandSchema = z.strictObject({
  kind: z.literal('field'),
  path: z.string().min(1).max(200),
})

const LiteralOperandSchema = z.strictObject({
  kind: z.literal('literal'),
  value: ConditionLiteralSchema,
})

const LiteralArrayOperandSchema = z.strictObject({
  kind: z.literal('literal'),
  value: z.array(ConditionLiteralSchema).min(2).max(50),
})

/** MVP 约束：比较运算左侧必须是字段、右侧必须是字面量（不做字段对字段比较）。 */
const ConditionExprSchema: z.ZodType<ConditionExpr> = z.lazy(() =>
  z.union([
    z.strictObject({
      kind: z.literal('comparison'),
      op: z.enum(['==', '!=', '>', '>=', '<', '<=']),
      left: FieldOperandSchema,
      right: LiteralOperandSchema,
    }),
    z.strictObject({
      kind: z.literal('comparison'),
      op: z.literal('in'),
      left: FieldOperandSchema,
      right: LiteralArrayOperandSchema,
    }),
    z.strictObject({
      kind: z.literal('logical'),
      op: z.enum(['and', 'or']),
      operands: z.array(ConditionExprSchema).min(2).max(5),
    }),
    z.strictObject({
      kind: z.literal('not'),
      operand: ConditionExprSchema,
    }),
  ]),
)

export { ConditionExprSchema }

// ---------------------------------------------------------------------------
// 节点配置（每类严格校验：未知字段拒绝）
// ---------------------------------------------------------------------------

export const OutputFieldSchema = z.strictObject({
  name: z.string().min(1).max(64),
  type: z.enum(['string', 'number', 'boolean', 'string_array']),
  required: z.boolean().default(true),
})

export const OutputContractSchema = z
  .strictObject({
    profile: z.enum(['generic', 'test_result']).default('generic'),
    fields: z.array(OutputFieldSchema).max(20).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.profile === 'test_result' && value.fields.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'test_result 使用固定 5 字段，不允许自定义 fields',
      })
    }
  })

export const AssignmentSelectorSchema = z.strictObject({
  workRole: z.string().min(1).max(64),
  agentProfileId: z.string().min(1).max(128).optional(),
})

export const ArtifactDeclarationSchema = z.strictObject({
  name: z.string().min(1).max(64),
  type: z.enum(['markdown', 'text', 'code', 'image', 'other']),
  required: z.boolean().default(true),
})

export const AgentTaskConfigSchema = z.strictObject({
  assignmentSelector: AssignmentSelectorSchema,
  taskPrompt: z.string().min(1).max(20_000),
  inputArtifactRefs: z
    .array(
      z.strictObject({
        nodeKey: KeySchema,
        artifactName: z.string().min(1).max(64).optional(),
      }),
    )
    .default([]),
  artifacts: z.array(ArtifactDeclarationSchema).default([]),
  workingDirectoryPolicy: z.enum(['work_root', 'worktree']).default('work_root'),
  outputContract: OutputContractSchema.default({ profile: 'generic', fields: [] }),
  timeoutSeconds: z.number().int().min(60).max(86_400).optional(),
  retryPolicy: z.strictObject({ maxAttempts: z.number().int().min(1).max(3) }).optional(),
})

export const HumanApprovalConfigSchema = z.strictObject({
  target: z.strictObject({
    nodeKey: KeySchema,
    phase: z.enum(['before_execute', 'after_execute']),
  }),
  reworkTargetNodeKey: KeySchema.optional(),
  instructions: z.string().max(2000).default(''),
})

export const ConditionConfigSchema = z.strictObject({
  predicate: ConditionExprSchema,
  falseBranch: z
    .union([
      z.literal('edge'),
      z.strictObject({ kind: z.literal('rework'), reportNodeKey: KeySchema }),
    ])
    .default('edge'),
})

export const ParallelSplitConfigSchema = z.strictObject({
  strategy: z.literal('fan_out_all').default('fan_out_all'),
})

export const JoinConfigSchema = z.strictObject({
  policy: z.literal('all_success').default('all_success'),
  pairWith: KeySchema,
})

export const StartConfigSchema = z.strictObject({})
export const EndConfigSchema = z.strictObject({})

// ---------------------------------------------------------------------------
// 节点 / 边 / settings / definition
// ---------------------------------------------------------------------------

const nodeBase = {
  key: KeySchema,
  label: z.string().max(100).default(''),
  position: PositionSchema,
}

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...nodeBase, type: z.literal('start'), config: StartConfigSchema }),
  z.strictObject({ ...nodeBase, type: z.literal('agent_task'), config: AgentTaskConfigSchema }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('parallel_split'),
    config: ParallelSplitConfigSchema,
  }),
  z.strictObject({ ...nodeBase, type: z.literal('join'), config: JoinConfigSchema }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('human_approval'),
    config: HumanApprovalConfigSchema,
  }),
  z.strictObject({ ...nodeBase, type: z.literal('condition'), config: ConditionConfigSchema }),
  z.strictObject({ ...nodeBase, type: z.literal('end'), config: EndConfigSchema }),
])

export const WorkflowEdgeSchema = z.strictObject({
  key: KeySchema,
  source: KeySchema,
  target: KeySchema,
  branchKey: KeySchema.optional(),
  when: z.boolean().optional(),
})

const DefaultsSchema = z.strictObject({
  timeoutSeconds: z.number().int().min(60).max(86_400).default(1800),
  maxAttempts: z.number().int().min(1).max(3).default(1),
})

const ReworkPolicySettingsSchema = z.strictObject({
  maxRounds: z.number().int().min(1).max(2).default(2),
})

const ConcurrencySettingsSchema = z.strictObject({
  maxParallelNodes: z.number().int().min(1).max(16).default(4),
})

export const WorkflowSettingsSchema = z.strictObject({
  // prefault 而不是 default：default({}) 会短路返回 {}，不会应用子对象内的默认值。
  defaults: DefaultsSchema.prefault({}),
  reworkPolicy: ReworkPolicySettingsSchema.prefault({}),
  failureStrategy: z.literal('fail_branch').default('fail_branch'),
  concurrency: ConcurrencySettingsSchema.prefault({}),
})

export const WorkflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema),
  settings: WorkflowSettingsSchema.prefault({}),
})

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>
export type AgentTaskConfig = z.infer<typeof AgentTaskConfigSchema>
export type ConditionConfig = z.infer<typeof ConditionConfigSchema>

/**
 * 未知节点类型必须在 Schema 解析阶段就识别出来（返回 UNKNOWN_NODE_TYPE 错误码），
 * 因此先做一次宽松扫描，而不是等 discriminatedUnion 报一个笼统错误。
 */
export function findUnknownNodeTypes(input: unknown): { nodeKey?: string; type: unknown }[] {
  if (typeof input !== 'object' || input === null) return []
  const nodes = (input as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []
  const unknown: { nodeKey?: string; type: unknown }[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const type = (node as { type?: unknown }).type
    if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
      const key = (node as { key?: unknown }).key
      unknown.push({
        nodeKey: typeof key === 'string' ? key : undefined,
        type,
      })
    }
  }
  return unknown
}
