/**
 * 模型输出有时是整段 JSON（Planner/队长/成员），有时是 JSON 夹在说明文字后面。
 * 展示时只提取可读正文，绝不把原始 JSON 直接铺在聊天里。
 */
export function readableContent(content: string): string {
  let text = content.trim()
  // 本机 claude-mem 插件的诊断提示会混进 Agent 最终输出；展示时去掉，避免淹没正文。
  text = text.replace(/^(?:【claude-mem 告警】|【系统提示】claude-mem)[^\n]*\n*/u, '').trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(text)
  if (fenced) text = fenced[1]?.trim() ?? text

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const prefix = text.slice(0, start).trim()
    const candidate = text.slice(start, end + 1)
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const reply =
        typeof parsed.reply === 'string'
          ? parsed.reply.trim()
          : typeof parsed.text === 'string'
            ? parsed.text.trim()
            : typeof parsed.decision === 'string'
              ? parsed.decision.trim()
              : ''
      if (reply) return [prefix, reply].filter(Boolean).join('\n\n')
    } catch {
      // 继续按普通文本处理。
    }
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) return parsed.reply.trim()
      if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim()
      if (typeof parsed.decision === 'string' && parsed.decision.trim()) {
        return parsed.decision.trim()
      }
    } catch {
      // 不是合法 JSON 时保留原文。
    }
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
