import type { ExecutionLog } from '@agentra/protocol'
import type { RiskLevel, SideEffectRef } from './checkpoint-schemas'

export type ToolEvent = {
  name: string
  input: unknown
}

export type RiskAssessment = {
  level: RiskLevel
  reasons: string[]
  toolEventsComplete: boolean
}

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?/i, reason: 'destructive_delete' },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/i, reason: 'destructive_delete' },
  { pattern: /\bfind\b.*\b-delete\b/i, reason: 'destructive_delete' },
  { pattern: /\brmdir\b/i, reason: 'destructive_delete' },
  { pattern: /\btruncate\b/i, reason: 'destructive_delete' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git_history_destruction' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: 'git_workspace_destruction' },
  { pattern: /\bgit\s+push\b.*--force\b/i, reason: 'git_history_destruction' },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, reason: 'database_destructive_change' },
  { pattern: /\btruncate\s+table\b/i, reason: 'database_destructive_change' },
  { pattern: /\bdeploy\b/i, reason: 'external_release' },
  { pattern: /\bpublish\b/i, reason: 'external_release' },
  { pattern: /\brelease\b/i, reason: 'external_release' },
  { pattern: /\bkubectl\b/i, reason: 'external_release' },
  { pattern: /\bterraform\s+apply\b/i, reason: 'external_release' },
  { pattern: /\bdocker\s+push\b/i, reason: 'external_release' },
  { pattern: /\bnpm\s+publish\b/i, reason: 'external_release' },
  { pattern: /\bcurl\b.*\b(POST|PUT|PATCH|DELETE)\b/i, reason: 'external_write' },
  { pattern: /\b(ssh|scp|rsync)\b/i, reason: 'external_write' },
  { pattern: /\b(payment|transfer|refund|checkout)\b/i, reason: 'external_financial_transaction' },
  {
    pattern: /\b(chmod|chown|passwd|useradd|userdel|revoke)\b/i,
    reason: 'account_or_permission_change',
  },
  {
    pattern: /\b(send|notify|webhook)\b.*\b(formal|public|external|customer)\b/i,
    reason: 'irreversible_external_action',
  },
]

const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit'])
const SHELL_TOOLS = new Set(['Bash', 'bash', 'Shell', 'shell', 'exec', 'Terminal'])
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'read',
  'grep',
  'glob',
])

function collectToolUse(value: unknown, out: ToolEvent[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectToolUse(item, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (record.type === 'tool_use' && typeof record.name === 'string') {
    out.push({ name: record.name, input: record.input ?? null })
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'input') continue
    collectToolUse(value, out, depth + 1)
  }
}

/** 从 structured execution logs 提取 tool_use；调用方负责传入是否截断。 */
export function extractToolEvents(
  logs: ExecutionLog[],
  toolEventsComplete: boolean,
): { events: ToolEvent[]; complete: boolean } {
  const events: ToolEvent[] = []
  for (const log of logs) {
    if (log.stream !== 'structured') continue
    try {
      collectToolUse(JSON.parse(log.content), events)
    } catch {
      // 非 JSON structured 输出不是 tool_use；不改变风险等级。
    }
  }
  return { events, complete: toolEventsComplete }
}

function commandText(event: ToolEvent): string {
  if (event.input && typeof event.input === 'object') {
    const input = event.input as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['command', 'cmd', 'script', 'description', 'url', 'method']) {
      if (typeof input[key] === 'string') parts.push(input[key] as string)
    }
    return parts.join(' ')
  }
  return typeof event.input === 'string' ? event.input : ''
}

export function classifyRisk(input: {
  accessMode: 'analyze' | 'edit'
  toolEvents: ToolEvent[]
  toolEventsComplete: boolean
  rootKind: 'worktree' | 'work_root'
  fileEvidenceTracked: boolean
  sideEffects: SideEffectRef[]
}): RiskAssessment {
  const reasons: string[] = []
  let level: RiskLevel = 'low'

  const raise = (next: RiskLevel, reason: string): void => {
    if (next === 'high') level = 'high'
    else if (next === 'medium' && level === 'low') level = 'medium'
    reasons.push(reason)
  }

  for (const effect of input.sideEffects) {
    if (
      effect.status === 'succeeded' ||
      effect.status === 'in_progress' ||
      effect.status === 'unknown'
    ) {
      raise(effect.riskLevel, `side_effect:${effect.kind}:${effect.status}`)
    }
  }

  for (const event of input.toolEvents) {
    const text = SHELL_TOOLS.has(event.name) ? `${event.name} ${commandText(event)}` : event.name
    const matched = HIGH_RISK_PATTERNS.find(({ pattern }) => pattern.test(text))
    if (matched) {
      raise('high', matched.reason)
      continue
    }
    if (SHELL_TOOLS.has(event.name)) {
      raise('medium', 'shell_tool')
    } else if (FILE_EDIT_TOOLS.has(event.name)) {
      raise(input.rootKind === 'worktree' ? 'low' : 'medium', 'file_edit')
    } else if (!READ_ONLY_TOOLS.has(event.name)) {
      raise('medium', 'unknown_tool')
    }
  }

  if (!input.toolEventsComplete) raise('medium', 'tool_events_incomplete')
  if (input.rootKind === 'work_root') raise('medium', 'non_worktree_root')
  if (!input.fileEvidenceTracked) raise('medium', 'file_evidence_not_tracked')
  if (input.accessMode === 'edit' && input.toolEvents.length === 0) {
    raise('medium', 'edit_agent_without_observed_tools')
  }

  if (reasons.length === 0) reasons.push('read_only_or_worktree_local')
  return { level, reasons: [...new Set(reasons)], toolEventsComplete: input.toolEventsComplete }
}
