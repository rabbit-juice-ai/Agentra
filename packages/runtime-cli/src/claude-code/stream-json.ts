import type { OutputStream } from '@agentra/runtime-sdk'

/**
 * Claude Code stream-json 帧没有稳定文档：宽松解析、未知帧忽略语义但保留原始日志、
 * 非 JSON 行按原始 stdout 保存（AGENTS §6：不吞异常，也不把非可信输出当指令）。
 */
export type ParsedLine = { stream: OutputStream; content: string }

export type AssistantTextBlock = { type: 'text'; text: string }
export type AssistantToolBlock = { type: string; [key: string]: unknown }

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 逐行解析 stdout：assistant 文本进 stdout（UI 直接可读），其余帧保留为 structured。 */
export function parseStdoutLine(line: string): ParsedLine[] {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []
  const frame = tryParseJson(trimmed)
  if (!frame) return [{ stream: 'stdout', content: line }]

  const type = typeof frame.type === 'string' ? frame.type : null
  if (type === 'assistant') {
    const message = frame.message
    const content =
      message &&
      typeof message === 'object' &&
      Array.isArray((message as { content?: unknown }).content)
        ? (message as { content: unknown[] }).content
        : null
    if (!content) return [{ stream: 'structured', content: line }]
    const out: ParsedLine[] = []
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const text = (block as { text: string }).text
        if (text.length > 0) out.push({ stream: 'stdout', content: text })
      } else {
        out.push({ stream: 'structured', content: JSON.stringify(block) })
      }
    }
    return out.length > 0 ? out : [{ stream: 'structured', content: line }]
  }

  // result / system / stream_event / 未知帧：结构化保留，供审计与后续解析。
  return [{ stream: 'structured', content: line }]
}

export function parseStderrLine(line: string): ParsedLine[] {
  if (line.trim().length === 0) return []
  return [{ stream: 'stderr', content: line }]
}

export type ResultFrame = { isError: boolean; subtype: string | null; result: string | null }

/** 识别 result 帧（回合结束）。非 result 返回 null。 */
export function readResultFrame(line: string): ResultFrame | null {
  const frame = tryParseJson(line.trim())
  if (frame?.type !== 'result') return null
  return {
    isError:
      frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success'),
    subtype: typeof frame.subtype === 'string' ? frame.subtype : null,
    result: typeof frame.result === 'string' ? frame.result : null,
  }
}

/** 逐行切分缓冲：处理跨 chunk 的半行。 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk
  const parts = combined.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

export function buildUserFrame(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`
}

/** 原生中断：向 stdin 写 control_request（capabilities.interrupt=native）。 */
export function buildInterruptFrame(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  })}\n`
}
