import { CAPABILITY_NAMES, type CapabilityName } from '@agentra/runtime-sdk'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from './claude-code/args'
import { CLAUDE_CODE_CAPABILITIES } from './claude-code/capabilities'
import { ClaudeCodeProvider } from './claude-code/provider'
import { buildInterruptFrame, buildUserFrame, parseStdoutLine } from './claude-code/stream-json'
import { FAKE_CLAUDE_PATH } from './test-fixtures'

/**
 * 能力一致性（ARCHITECTURE §5：不支持的能力不能伪装）。
 *
 * 不变式：capabilities 声明与适配器实现锚点必须一一对应——
 * - 声明 native / emulated ⇒ 必须有可执行实现锚点；
 * - 声明 unsupported ⇒ 必须没有实现锚点，且调用返回 CAPABILITY_UNSUPPORTED。
 *
 * 新增能力或改动声明时，这张表必须先改，否则本测试失败。
 */
const IMPLEMENTATION_ANCHOR: Record<CapabilityName, string | null> = {
  streaming: 'buildUserFrame + ClaudeCodeProvider.sendMessage',
  structuredEvents: 'parseStdoutLine',
  interrupt: 'buildInterruptFrame + ClaudeCodeProvider.interrupt',
  resume: null,
  checkpoint: null,
  permissionRequests: null,
  sessionPersistence: 'buildClaudeArgs --session-id / --resume',
  workingDirectory: 'spawn({ cwd })',
  toolControl: 'buildClaudeArgs --allowedTools / --disallowedTools',
}

function makeProvider(): ClaudeCodeProvider {
  return new ClaudeCodeProvider({ executablePath: FAKE_CLAUDE_PATH })
}

describe('capability declarations match the adapter', () => {
  it('declares exactly the nine capabilities from ARCHITECTURE §5', () => {
    expect(Object.keys(CLAUDE_CODE_CAPABILITIES).sort()).toEqual([...CAPABILITY_NAMES].sort())
  })

  it('every native/emulated capability has an implementation anchor, every unsupported one has none', () => {
    const mismatches = CAPABILITY_NAMES.filter((name) => {
      const declared = CLAUDE_CODE_CAPABILITIES[name] !== 'unsupported'
      const anchored = IMPLEMENTATION_ANCHOR[name] !== null
      return declared !== anchored
    })
    expect(mismatches).toEqual([])
  })

  it('rejects calling resume, which is declared unsupported', async () => {
    const provider = makeProvider()
    await expect(provider.resume()).rejects.toMatchObject({
      name: 'RuntimeError',
      code: 'CAPABILITY_UNSUPPORTED',
    })
  })

  // 以下四条钉住"锚点不是空话"：声明为 native 的能力必须真的产生对应行为。
  it('streaming anchor: builds a user frame the CLI can consume', () => {
    const frame = JSON.parse(buildUserFrame('hello')) as {
      type: string
      message: { role: string; content: { type: string; text: string }[] }
    }
    expect(frame.type).toBe('user')
    expect(frame.message.role).toBe('user')
    expect(frame.message.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('structuredEvents anchor: parses stream-json frames by type', () => {
    const [assistant] = parseStdoutLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    )
    expect(assistant).toEqual({ stream: 'stdout', content: 'hi' })
    const [result] = parseStdoutLine(JSON.stringify({ type: 'result', subtype: 'success' }))
    expect(result?.stream).toBe('structured')
  })

  it('interrupt anchor: emits a native control_request frame', () => {
    const frame = JSON.parse(buildInterruptFrame('req-1')) as {
      type: string
      request: { subtype: string }
    }
    expect(frame.type).toBe('control_request')
    expect(frame.request.subtype).toBe('interrupt')
  })

  it('sessionPersistence / toolControl anchors: map onto CLI arguments', () => {
    const base = {
      executionId: 'exe-1',
      prompt: 'p',
      workingDirectory: '/tmp',
      sessionId: 'ses-1',
    }
    expect(buildClaudeArgs(base)).toContain('--session-id')
    expect(buildClaudeArgs(base)).toContain('--include-partial-messages')
    const withTools = buildClaudeArgs({
      ...base,
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
    })
    expect(withTools).toContain('--allowedTools')
    expect(withTools).toContain('--disallowedTools')
  })
})
