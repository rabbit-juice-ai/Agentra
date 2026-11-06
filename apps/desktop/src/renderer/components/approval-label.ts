/** Human-readable approval type; Core stores the phase, not a display label. */
export function approvalTypeLabel(type: string): string {
  switch (type) {
    case 'before_execute':
      return '执行前审批'
    case 'after_execute':
      return '执行后审批'
    default:
      return type
  }
}
