import { describe, expect, it } from 'vitest'
import type { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { ArtifactService } from '../services/artifact-service'
import { redactOutput } from '../services/redact-output'
import { ArtifactExchange } from './artifact-exchange'

function extractor(entries: Array<{ stream: string; content: string }>) {
  return new ArtifactExchange(
    {
      list: (_id: string, after: number) =>
        entries.map((e, i) => ({ ...e, sequenceNo: i + 1 })).filter((e) => e.sequenceNo > after),
    } as unknown as ExecutionLogRepository,
    {} as ArtifactService,
    {} as NodeRunRepository,
  )
}
describe('Artifact output extraction (normalized CLI logs)', () => {
  it('accepts normal text without pretending it is a declared artifact', () => {
    expect(extractor([{ stream: 'stdout', content: 'hello' }]).extract('e')).toEqual({
      text: 'hello',
    })
  })
  it('uses the final CLI result, not intermediate assistant text', () => {
    const document = {
      agentraOutputVersion: 1,
      output: { pass: true },
      artifacts: [{ name: 'PRD', content: '# PRD' }],
    }
    expect(
      extractor([
        { stream: 'stdout', content: 'working...' },
        {
          stream: 'structured',
          content: JSON.stringify({ type: 'result', result: JSON.stringify(document) }),
        },
      ]).extract('e'),
    ).toEqual({
      pass: true,
      __agentraArtifacts: [{ name: 'PRD', content: '# PRD', encoding: 'utf8' }],
    })
  })
  it('accepts a fenced explicit document and rejects unsupported formats', () => {
    expect(
      extractor([
        {
          stream: 'stdout',
          content: '```json\n{"agentraOutputVersion":1,"output":{},"artifacts":[]}\n```',
        },
      ]).extract('e'),
    ).toEqual({ __agentraArtifacts: [] })
    expect(() =>
      extractor([{ stream: 'stdout', content: '{"agentraOutputVersion":2,"output":{}}' }]).extract(
        'e',
      ),
    ).toThrow(/Invalid/)
  })
  it('rejects empty output and malformed artifact documents', () => {
    expect(() => extractor([]).extract('e')).toThrow(/no transferable/)
    expect(() =>
      extractor([
        {
          stream: 'stdout',
          content: '{"agentraOutputVersion":1,"output":{},"artifacts":[{"name":"x","content":""}]}',
        },
      ]).extract('e'),
    ).toThrow(/Invalid/)
  })
  it('redacts credential values without destroying structured output', () => {
    const clean = JSON.parse(
      redactOutput(
        JSON.stringify({
          token: 'fixture-secret',
          result: 'password=fixture-secret',
          output: { pass: true },
        }),
      ),
    )
    expect(clean.token).toBe('[REDACTED]')
    expect(clean.result).not.toContain('fixture-secret')
    expect(clean.output.pass).toBe(true)
  })
})
