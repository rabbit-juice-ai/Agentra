import type { CheckpointJson, SideEffectRef } from './checkpoint-schemas'
import type { TaskMemory, TaskMemoryItem } from './task-memory-service'

export type ContextBudget = {
  totalChars: number
  p0Chars: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalChars: 60_000,
  p0Chars: 30_000,
}

export type ContextMessage = {
  authorType: string
  content: string
  createdAt: string
}

export type ContextBuilderInput = {
  work: {
    id: string
    name: string
    objective: string
    acceptanceCriteria: string[]
    acceptanceCriteriaVersion: number
  }
  taskMemory: TaskMemory
  checkpoint: {
    id: string
    seq: number
    kind: string
    json: CheckpointJson
  } | null
  agent: {
    name: string
    accessMode: 'analyze' | 'edit'
    systemPrompt: string
  } | null
  messages: ContextMessage[]
  artifacts: Array<{ name: string; version: number; checksum: string }>
  files: Array<{ relativePath: string; status: string; verification: string }>
  sideEffects: SideEffectRef[]
  /** 仅恢复执行使用；计入 P0 预算。 */
  recoveryPrefix?: string
  budget?: Partial<ContextBudget>
}

export type ContextManifest = {
  totalChars: number
  sections: { p0: number; p1: number; p2: number; p3: number }
  trimmed: { p1: boolean; p2: boolean; p3: boolean }
  sourceRefs: string[]
}

export type ContextBuildResult = {
  sections: { p0: string; p1: string; p2: string; p3: string }
  manifest: ContextManifest
}

export class ContextBudgetExceededError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED'
  constructor(
    readonly actualChars: number,
    readonly budgetChars: number,
    readonly section: 'p0' | 'total',
  ) {
    super(
      `${section.toUpperCase()} context exceeds budget: ${actualChars} > ${budgetChars} chars; refusing to truncate P0`,
    )
    this.name = 'ContextBudgetExceededError'
  }
}

function renderItems(items: TaskMemoryItem[]): string {
  if (items.length === 0) return '(none)'
  return items
    .map(
      (item) =>
        `- [${item.verification}] ${item.statement} (source: ${item.source.type}:${item.source.id})`,
    )
    .join('\n')
}

function renderP0(input: ContextBuilderInput): string {
  const lines: string[] = []
  if (input.recoveryPrefix?.trim()) {
    lines.push(input.recoveryPrefix.trim(), '')
  }
  lines.push('## P0 · Identity and permissions')
  if (input.agent) {
    lines.push(`Agent: ${input.agent.name}`)
    lines.push(`Access mode: ${input.agent.accessMode}`)
    if (input.agent.systemPrompt.trim()) lines.push(input.agent.systemPrompt.trim())
  } else {
    lines.push('Agent: (core recovery context)')
  }
  lines.push('', '## P0 · Work')
  lines.push(`Task: ${input.work.name}`)
  lines.push(`Objective: ${input.work.objective || '(none)'}`)
  lines.push(`Acceptance criteria (Work v${input.work.acceptanceCriteriaVersion}):`)
  lines.push(
    input.work.acceptanceCriteria.length > 0
      ? input.work.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
      : '(none)',
  )

  if (input.checkpoint) {
    const checkpoint = input.checkpoint.json
    lines.push('', '## P0 · Latest valid checkpoint')
    lines.push(
      `Checkpoint: ${input.checkpoint.id} (seq ${input.checkpoint.seq}, kind ${input.checkpoint.kind})`,
    )
    lines.push(`Status: ${checkpoint.status}`)
    lines.push(`Completed:\n${renderItems(checkpoint.memory.completed)}`)
    lines.push(`In progress:\n${renderItems(checkpoint.memory.inProgress)}`)
    lines.push(`Blockers:\n${renderItems(checkpoint.memory.blockers)}`)
    lines.push(`Next actions:\n${renderItems(checkpoint.memory.nextActions)}`)
  } else {
    lines.push('', '## P0 · Latest valid checkpoint')
    lines.push('(none; no recovery point)')
  }

  lines.push('', '## P0 · Side effects')
  if (input.sideEffects.length === 0) {
    lines.push('Completeness: not_tracked (no side-effect ledger in Phase 1B-1)')
  } else {
    lines.push(
      `Completeness: ${input.sideEffects[0]?.completeness ?? 'not_tracked'}`,
      ...input.sideEffects.map(
        (effect) =>
          `- [${effect.status}] ${effect.effectKey} (${effect.kind}, completeness=${effect.completeness})`,
      ),
    )
  }
  lines.push(
    '',
    '## P0 · Recovery safety constraints',
    '- Do not overwrite, rollback, or delete workspace files during recovery.',
    '- Do not retry an in_progress or unknown side effect.',
    '- Recovery planning is read-only in Phase 1B-1.',
  )
  return lines.join('\n')
}

function renderP1(memory: TaskMemory): string {
  return [
    '## P1 · Task memory (current snapshot)',
    `Objective: ${memory.objective || '(none)'}`,
    `Constraints:\n${renderItems(memory.constraints)}`,
    `Completed:\n${renderItems(memory.completed)}`,
    `In progress:\n${renderItems(memory.inProgress)}`,
    `Decisions:\n${renderItems(memory.decisions)}`,
    `Issues:\n${renderItems(memory.issues)}`,
    `Blockers:\n${renderItems(memory.blockers)}`,
    `Next actions:\n${renderItems(memory.nextActions)}`,
    `Open questions:\n${renderItems(memory.openQuestions)}`,
  ].join('\n')
}

function renderP2(messages: ContextMessage[]): string {
  const recent = messages.slice(-40)
  if (recent.length === 0) return '## P2 · Recent task thread\n(none)'
  return [
    '## P2 · Recent task thread (conversation continuity, not verified facts)',
    ...recent.map((message) => `- ${message.authorType}: ${message.content}`),
  ].join('\n')
}

function renderP3(input: ContextBuilderInput): string {
  const lines = ['## P3 · Artifacts and files']
  if (input.artifacts.length === 0) lines.push('Artifacts: (none)')
  else {
    lines.push('Artifacts:')
    for (const artifact of input.artifacts) {
      lines.push(`- ${artifact.name} v${artifact.version} (${artifact.checksum.slice(0, 16)}…)`)
    }
  }
  if (input.files.length === 0) lines.push('Files: (none)')
  else {
    lines.push('Files:')
    for (const file of input.files) {
      lines.push(`- [${file.verification}] ${file.status} ${file.relativePath}`)
    }
  }
  return lines.join('\n')
}

function trimTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 0) return ''
  return `${value.slice(0, Math.max(0, maxChars - 20))}\n…[trimmed]`
}

/**
 * 纯函数 ContextBuilder。P0 永不裁剪；P1/P2/P3 按优先级从低到高裁剪。
 * Phase 1B-1 使用固定字符预算，不依赖 Provider Token 窗口。
 */
export function buildRecoveryPrompt(input: ContextBuilderInput & { checkpointId: string }): {
  prompt: string
  sections: ContextBuildResult['sections']
  manifest: ContextManifest
} {
  const prefix = [
    '## P0 · Explicit recovery',
    `You are performing an explicit recovery from checkpoint ${input.checkpointId}.`,
    'This is not a fresh task. Do not repeat completed work.',
    'Do not repeat in_progress or unknown side effects.',
    'Do not overwrite, rollback, or delete workspace files.',
    'If evidence or context is insufficient, stop and report instead of guessing.',
  ].join('\n')
  const result = buildContext({ ...input, recoveryPrefix: prefix })
  return {
    prompt: [result.sections.p0, result.sections.p1, result.sections.p2, result.sections.p3]
      .filter((section) => section.length > 0)
      .join('\n\n'),
    sections: result.sections,
    manifest: result.manifest,
  }
}

export function buildContext(input: ContextBuilderInput): ContextBuildResult {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, ...input.budget }
  const p0 = renderP0(input)
  if (p0.length > budget.p0Chars) {
    throw new ContextBudgetExceededError(p0.length, budget.p0Chars, 'p0')
  }
  let p1 = renderP1(input.taskMemory)
  let p2 = renderP2(input.messages)
  let p3 = renderP3(input)
  const trimmed = { p1: false, p2: false, p3: false }

  const total = (): number => p0.length + p1.length + p2.length + p3.length
  if (total() > budget.totalChars) {
    const p3Max = Math.max(0, budget.totalChars - p0.length - p1.length - p2.length)
    p3 = trimTail(p3, p3Max)
    trimmed.p3 = true
  }
  if (total() > budget.totalChars) {
    const p2Max = Math.max(0, budget.totalChars - p0.length - p1.length - p3.length)
    p2 = trimTail(p2, p2Max)
    trimmed.p2 = true
  }
  if (total() > budget.totalChars) {
    const p1Max = Math.max(0, budget.totalChars - p0.length - p2.length - p3.length)
    p1 = trimTail(p1, p1Max)
    trimmed.p1 = true
  }
  if (total() > budget.totalChars) {
    throw new ContextBudgetExceededError(total(), budget.totalChars, 'total')
  }

  return {
    sections: { p0, p1, p2, p3 },
    manifest: {
      totalChars: total(),
      sections: {
        p0: p0.length,
        p1: p1.length,
        p2: p2.length,
        p3: p3.length,
      },
      trimmed,
      sourceRefs: [
        `work:${input.work.id}@v${input.work.acceptanceCriteriaVersion}`,
        `task_memory:${input.taskMemory.taskId}@v${input.taskMemory.acceptanceCriteria.workVersion}`,
        ...(input.checkpoint ? [`checkpoint:${input.checkpoint.id}`] : []),
        ...input.artifacts.map((artifact) => `artifact:${artifact.name}@v${artifact.version}`),
      ],
    },
  }
}
