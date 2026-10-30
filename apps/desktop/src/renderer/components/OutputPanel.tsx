import type { ExecutionLog } from '@agentra/protocol'
import { useEffect, useRef } from 'react'

const STREAM_COLORS: Record<string, string> = {
  stdout: '#c9d1d9',
  stderr: '#ff7b72',
  system: '#8b949e',
  structured: '#79c0ff',
}

/** 只读输出面板：按流着色，自动滚动到底部。 */
export function OutputPanel({ logs, emptyHint }: { logs: ExecutionLog[]; emptyHint: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 依赖 logs.length 是刻意的：effect 内不直接读取它，但需要在日志条数变化时重新滚动到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 日志增长即触发滚动，去掉会退化为只在挂载时滚动一次
  useEffect(() => {
    const element = containerRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [logs.length])

  return (
    <div
      ref={containerRef}
      style={{
        background: '#0d1117',
        color: '#c9d1d9',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        borderRadius: 8,
        padding: 12,
        height: 320,
        overflow: 'auto',
      }}
    >
      {logs.length === 0 ? (
        <span style={{ color: '#8b949e' }}>{emptyHint}</span>
      ) : (
        logs.map((log) => (
          <div
            key={log.id}
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: STREAM_COLORS[log.stream] ?? '#c9d1d9',
            }}
          >
            <span style={{ color: '#6e7681', marginRight: 8 }}>
              {String(log.sequenceNo).padStart(4, '0')}
            </span>
            {log.stream === 'system' ? `[system] ${log.content}` : log.content}
          </div>
        ))
      )}
    </div>
  )
}
