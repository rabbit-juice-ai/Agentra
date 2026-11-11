/** 流式事件偶尔会重复发送同一段文本（stdout + 结构化流/重放）；追加时去重。 */
export function appendLiveText(current: string, next: string): string {
  if (!next) return current
  if (!current) return next
  if (current.endsWith(next)) return current
  if (next.startsWith(current)) return next
  if (next.length >= 20 && current.includes(next)) return current
  const maxOverlap = Math.min(current.length, next.length, 400)
  for (let overlap = maxOverlap; overlap >= 20; overlap -= 1) {
    if (current.slice(-overlap) === next.slice(0, overlap)) {
      return `${current}${next.slice(overlap)}`
    }
  }
  return `${current}${next}`
}
