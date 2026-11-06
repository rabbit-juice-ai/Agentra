import type { ReactNode } from 'react'

type Props = {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  crumb?: ReactNode
}

/** Page header: title/subtitle on the left, actions pinned to the right. */
export function PageHeader({ title, subtitle, actions, crumb }: Props) {
  return (
    <div className="page-header">
      <div className="page-head">
        {crumb && <div className="crumb">{crumb}</div>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}
