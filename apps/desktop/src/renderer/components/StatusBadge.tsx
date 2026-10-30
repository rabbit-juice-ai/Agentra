import { colors } from './styles'

const STATUS_COLORS: Record<string, string> = {
  running: colors.blue,
  pending: colors.muted,
  succeeded: colors.green,
  failed: colors.red,
  crashed: colors.red,
  cancelled: colors.amber,
  healthy: colors.green,
  unavailable: colors.red,
  unauthenticated: colors.amber,
  unknown: colors.muted,
  active: colors.green,
  disabled: colors.amber,
  archived: colors.muted,
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? colors.muted
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 8px',
        borderRadius: 10,
        color,
        border: `1px solid ${color}`,
        background: '#ffffff',
      }}
    >
      {status}
    </span>
  )
}
