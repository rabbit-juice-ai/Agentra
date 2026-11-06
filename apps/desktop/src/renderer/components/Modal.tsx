import { type ReactNode, useEffect } from 'react'
import { Icon } from './Icon'

/**
 * 通用弹框：创建/编辑/确认类操作使用，不再把表单塞进页面流里挤压内容。
 * Esc、点击遮罩、右上角关闭均可退出；打开时锁定背景滚动。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点击关闭是辅助交互；键盘用户可用 Esc 或右上角关闭。
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
