import { describe, expect, it } from 'vitest'
import type { ExecutionLogRepository } from '../db/repositories/execution-log-repository'
import type { NodeRunRepository } from '../db/repositories/node-run-repository'
import type { ArtifactService } from '../services/artifact-service'
import { redactOutput } from '../services/redact-output'
import { ArtifactExchange, describeOutputContract } from './artifact-exchange'

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
  it('uses the final result even when stdout exceeds the transfer budget', () => {
    expect(
      extractor([
        { stream: 'stdout', content: 'x'.repeat(8_000_001) },
        {
          stream: 'structured',
          content: JSON.stringify({ type: 'result', result: '{"reply":"done"}' }),
        },
      ]).extract('e'),
    ).toEqual({ reply: 'done' })
  })
  it('rejects oversized stdout when no final result frame exists', () => {
    expect(() =>
      extractor([{ stream: 'stdout', content: 'x'.repeat(8_000_001) }]).extract('e'),
    ).toThrow(/exceeds extraction budget/)
  })
  it('builds a recovery prompt with input artifacts without writing the NodeRun', () => {
    const checksum = 'a'.repeat(64)
    const ref = {
      name: 'PRD',
      artifactId: 'art-1',
      versionId: 'ver-1',
      version: 1,
      nodeRunId: 'nrn-src',
      checksum,
    }
    const sourceNode = {
      key: 'source',
      type: 'agent_task',
      label: '',
      position: { x: 0, y: 0 },
      config: {
        assignmentSelector: { workRole: 'dev' },
        taskPrompt: 'write prd',
        artifacts: [{ name: 'PRD', type: 'markdown', required: true }],
      },
    }
    const targetNode = {
      key: 'task',
      type: 'agent_task',
      label: '',
      position: { x: 0, y: 1 },
      config: {
        assignmentSelector: { workRole: 'dev' },
        taskPrompt: 'recover task',
        inputArtifactRefs: [{ nodeKey: 'source' }],
        artifacts: [{ name: 'out', type: 'markdown', required: true }],
        outputContract: { profile: 'generic', fields: [] },
      },
    }
    let wroteInputSnapshot = false
    const exchange = new ArtifactExchange(
      {} as ExecutionLogRepository,
      {
        preview: () => ({
          artifact: { workId: 'work-1', artifactType: 'markdown' },
          version: {
            id: 'ver-1',
            checksum,
            metadata: { nodeRunId: 'nrn-src', workflowRunId: 'run-1' },
          },
          content: Buffer.from('# upstream'),
        }),
      } as unknown as ArtifactService,
      {
        listByRun: () => [
          {
            id: 'nrn-src',
            workflowNodeKey: 'source',
            status: 'succeeded',
            attempt: 1,
            outputSnapshot: { artifacts: [ref] },
          },
        ],
        setInputSnapshot: () => {
          wroteInputSnapshot = true
        },
      } as unknown as NodeRunRepository,
    )
    const prompt = exchange.promptForRecovery({
      run: { id: 'run-1', workId: 'work-1' } as never,
      node: targetNode as never,
      definition: {
        schemaVersion: 1,
        nodes: [sourceNode, targetNode],
        edges: [],
        settings: {},
      } as never,
    })
    expect(prompt).toContain('# upstream')
    expect(prompt).toContain('agentraOutputVersion')
    expect(prompt).toContain('recover task')
    expect(wroteInputSnapshot).toBe(false)
  })

  it('describes test_result as flat output fields, not a nested contract descriptor', () => {
    const description = describeOutputContract({ profile: 'test_result', fields: [] })
    expect(description).toContain('top-level fields')
    expect(description).toContain('pass (boolean)')
    expect(description).toContain('relatedTasks (string array)')
    expect(description).toContain('Do not wrap them in a "fields" array')
    expect(description).not.toContain('{"profile"')
  })
  it('describes generic fields with requiredness', () => {
    expect(
      describeOutputContract({
        profile: 'generic',
        fields: [{ name: 'summary', type: 'string', required: true }],
      }),
    ).toBe('The output object must contain these top-level fields: summary (string, required).')
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
