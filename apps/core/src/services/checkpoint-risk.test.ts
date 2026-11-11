import type { ExecutionLog } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import { classifyRisk, extractToolEvents } from './checkpoint-risk'

const NOW = '2026-11-09T00:00:00.000Z'

function log(content: unknown): ExecutionLog {
  return {
    id: 'log-1',
    executionId: 'exe-1',
    sequenceNo: 1,
    stream: 'structured',
    content: JSON.stringify(content),
    timestamp: NOW,
  }
}

function assess(input: {
  accessMode?: 'analyze' | 'edit'
  tools?: Array<{ name: string; input?: unknown }>
  complete?: boolean
  rootKind?: 'worktree' | 'work_root'
  fileTracked?: boolean
}) {
  return classifyRisk({
    accessMode: input.accessMode ?? 'analyze',
    toolEvents: (input.tools ?? []).map((tool) => ({
      name: tool.name,
      input: tool.input ?? null,
    })),
    toolEventsComplete: input.complete ?? true,
    rootKind: input.rootKind ?? 'worktree',
    fileEvidenceTracked: input.fileTracked ?? true,
    sideEffects: [],
  })
}

describe('checkpoint risk classifier', () => {
  it.each([
    ['rm -rf /tmp/x', 'destructive_delete'],
    ['git reset --hard HEAD~1', 'git_history_destruction'],
    ['git clean -fd', 'git_workspace_destruction'],
    ['git push --force origin main', 'git_history_destruction'],
    ['psql -c "DROP TABLE users"', 'database_destructive_change'],
    ['kubectl apply -f prod.yaml', 'external_release'],
    ['npm publish', 'external_release'],
    ['curl -X POST https://api.example.com/pay', 'external_write'],
    ['chmod 777 /etc/passwd', 'account_or_permission_change'],
  ])('classifies %s as high risk', (command, reason) => {
    const result = assess({
      accessMode: 'edit',
      tools: [{ name: 'Bash', input: { command } }],
    })
    expect(result.level).toBe('high')
    expect(result.reasons).toContain(reason)
  })

  it('takes the highest risk when rules conflict', () => {
    const result = assess({
      accessMode: 'edit',
      tools: [
        { name: 'Read', input: { path: 'README.md' } },
        { name: 'Bash', input: { command: 'git reset --hard' } },
        { name: 'Write', input: { path: 'src/app.ts' } },
      ],
    })
    expect(result.level).toBe('high')
  })

  it('defaults unknown tools and incomplete tool events to medium, never low', () => {
    const unknown = assess({ accessMode: 'analyze', tools: [{ name: 'MysteryTool' }] })
    expect(unknown.level).toBe('medium')
    const incomplete = assess({
      accessMode: 'analyze',
      tools: [],
      complete: false,
    })
    expect(incomplete.level).toBe('medium')
    expect(incomplete.reasons).toContain('tool_events_incomplete')
  })

  it('treats edit agents without observed tools and non-worktree roots as medium', () => {
    expect(assess({ accessMode: 'edit', tools: [] }).level).toBe('medium')
    expect(
      assess({
        accessMode: 'analyze',
        rootKind: 'work_root',
        fileTracked: false,
      }).level,
    ).toBe('medium')
  })

  it('keeps read-only worktree analysis low', () => {
    const result = assess({
      accessMode: 'analyze',
      tools: [{ name: 'Read', input: { path: 'README.md' } }],
    })
    expect(result.level).toBe('low')
  })

  it('extracts tool_use events from structured logs and ignores non-JSON', () => {
    const extracted = extractToolEvents(
      [
        log({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }),
        log({ nested: { item: { type: 'tool_use', name: 'Read', input: { path: 'x' } } } }),
        { ...log({}), content: 'not-json' },
      ],
      true,
    )
    expect(extracted.events.map((event) => event.name)).toEqual(['Bash', 'Read'])
    expect(extracted.complete).toBe(true)
  })
})
