const LABELS: Record<string, string> = {
  running: '执行中',
  pending: '待处理',
  succeeded: '成功',
  failed: '失败',
  crashed: '崩溃',
  cancelled: '已取消',
  healthy: '健康',
  unavailable: '不可用',
  unauthenticated: '未认证',
  unknown: '未知',
  active: '启用',
  draft: '草稿',
  paused: '已暂停',
  completed: '已完成',
  removed: '已移除',
  disabled: '已停用',
  archived: '已归档',
  waiting_approval: '等待审批',
  blocked: '等待中',
  skipped: '已跳过',
  reconciliation_required: '待对账',
}

const TONES: Record<string, string> = {
  running: 'running',
  pending: 'pending',
  succeeded: 'done',
  healthy: 'done',
  completed: 'done',
  active: 'done',
  failed: 'danger',
  crashed: 'danger',
  unavailable: 'danger',
  cancelled: 'warn',
  paused: 'warn',
  disabled: 'warn',
  unauthenticated: 'warn',
  draft: 'pending',
  removed: 'pending',
  archived: 'pending',
  unknown: 'pending',
  waiting_approval: 'warn',
  blocked: 'pending',
  skipped: 'pending',
  reconciliation_required: 'danger',
}

/** Shared status pill. `label` lets a page give context (Work active = 进行中). */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`pill ${TONES[status] ?? 'pending'}`}>
      {label ?? LABELS[status] ?? status}
    </span>
  )
}
