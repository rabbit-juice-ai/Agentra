import { describe, expect, it } from 'vitest'
import {
  buildInterruptFrame,
  buildUserFrame,
  parseStderrLine,
  parseStdoutLine,
  readResultFrame,
  splitLines,
} from './claude-code/stream-json'

describe('parseStdoutLine', () => {
  it('maps assistant text blocks to readable stdout', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    })
    expect(parseStdoutLine(line)).toEqual([{ stream: 'stdout', content: 'OK' }])
  })

  it('keeps non-text assistant blocks as structured output', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] },
    })
    const parsed = parseStdoutLine(line)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.stream).toBe('structured')
    expect(parsed[0]?.content).toContain('tool_use')
  })

  it('keeps unknown frames as structured raw JSON', () => {
    const line = '{"type":"mystery","value":1}'
    expect(parseStdoutLine(line)).toEqual([{ stream: 'structured', content: line }])
  })

  it('keeps non-JSON lines as raw stdout', () => {
    expect(parseStdoutLine('plain text output')).toEqual([
      { stream: 'stdout', content: 'plain text output' },
    ])
  })

  it('drops blank lines', () => {
    expect(parseStdoutLine('   ')).toEqual([])
  })

  it('handles assistant frames with multiple blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    })
    expect(parseStdoutLine(line)).toEqual([
      { stream: 'stdout', content: 'a' },
      { stream: 'stdout', content: 'b' },
    ])
  })
})

describe('parseStderrLine', () => {
  it('keeps stderr lines verbatim', () => {
    expect(parseStderrLine('warning: something')).toEqual([
      { stream: 'stderr', content: 'warning: something' },
    ])
  })
})

describe('readResultFrame', () => {
  it('detects a successful result frame', () => {
    expect(readResultFrame('{"type":"result","subtype":"success","is_error":false}')).toEqual({
      isError: false,
      subtype: 'success',
      result: null,
    })
  })

  it('treats non-success subtypes and is_error as errors', () => {
    expect(readResultFrame('{"type":"result","subtype":"error_during_execution"}')?.isError).toBe(
      true,
    )
    expect(readResultFrame('{"type":"result","subtype":"success","is_error":true}')?.isError).toBe(
      true,
    )
  })

  it('returns null for non-result frames and non-JSON', () => {
    expect(readResultFrame('{"type":"assistant"}')).toBeNull()
    expect(readResultFrame('nope')).toBeNull()
  })
})

describe('splitLines', () => {
  it('handles a line split across chunks', () => {
    const first = splitLines('', '{"a":')
    expect(first.lines).toEqual([])
    expect(first.rest).toBe('{"a":')
    const second = splitLines(first.rest, '1}\nnext\n')
    expect(second.lines).toEqual(['{"a":1}', 'next'])
    expect(second.rest).toBe('')
  })
})

describe('frame builders', () => {
  it('builds a user message frame for stdin', () => {
    const frame = JSON.parse(buildUserFrame('hello')) as Record<string, unknown>
    expect(frame.type).toBe('user')
    expect(frame.message).toMatchObject({ role: 'user' })
    expect(JSON.stringify(frame)).toContain('hello')
  })

  it('builds a control_request interrupt frame', () => {
    const frame = JSON.parse(buildInterruptFrame('req-1')) as Record<string, unknown>
    expect(frame).toEqual({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'interrupt' },
    })
  })
})
