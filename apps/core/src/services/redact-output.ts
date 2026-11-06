/** CLI 输出不可信；在落库和广播前清除可识别的凭据。不能替代 CLI 端避免输出秘密。 */
export function redactOutput(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const visit = (value: unknown): unknown => {
      if (typeof value === 'string') return redactText(value)
      if (Array.isArray(value)) return value.map(visit)
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            /^(password|passwd|api[_-]?key|(?:access|refresh)[_-]?token|token|secret|authorization|cookie|set-cookie)$/i.test(
              key,
            )
              ? '[REDACTED]'
              : visit(item),
          ]),
        )
      return value
    }
    return JSON.stringify(visit(parsed))
  } catch {
    return redactText(text)
  }
}

function redactText(text: string): string {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
      '[REDACTED]',
    )
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(
      /((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)["']?\s*[:=]\s*["']?)([^\s,"'\\}]+)/gi,
      '$1[REDACTED]',
    )
}
