/**
 * Agent 头像：emoji 或上传图片的 data URL。
 * 列表与表单共用，避免同一身份在不同页面显示不一致。
 */
export function AgentAvatar({
  avatar,
  size = 26,
  className = '',
  title,
}: {
  avatar: string
  size?: number
  className?: string
  title?: string
}) {
  if (avatar.startsWith('data:image/')) {
    return (
      <img
        className={`avatar avatar-image ${className}`}
        src={avatar}
        alt=""
        title={title}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className={`avatar avatar-emoji ${className}`}
      title={title}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
    >
      {avatar}
    </span>
  )
}
