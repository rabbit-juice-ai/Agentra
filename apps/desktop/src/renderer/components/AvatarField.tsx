import { useId, useRef, useState } from 'react'
import { toAvatarDataUrl, validateAvatarFile } from '../utils/avatar-image'
import { AgentAvatar } from './AgentAvatar'

export function AvatarField({
  label,
  value,
  onChange,
  fallback = '👤',
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  fallback?: string
  disabled?: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [error, setError] = useState<string | null>(null)
  const isImage = value.startsWith('data:image/')

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const validationError = validateAvatarFile(file)
    if (validationError) {
      setError(validationError)
      return
    }
    try {
      onChange(await toAvatarDataUrl(file))
      setError(null)
    } catch {
      setError('图片读取失败，请换一张再试')
    }
  }

  return (
    <div className="field avatar-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="settings-avatar-row">
        <AgentAvatar avatar={value} size={44} />
        <input
          id={inputId}
          className="input"
          value={isImage ? '' : value}
          placeholder="输入一个 emoji"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          上传图片
        </button>
        {isImage && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={() => onChange(fallback)}
          >
            移除图片
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </div>
      <div className="faint" style={{ fontSize: 10.5 }}>
        {isImage ? '当前使用上传图片；输入 emoji 会替换图片。' : '可以使用 emoji，也可以上传图片。'}
      </div>
      {error && (
        <div className="faint" style={{ color: 'var(--danger)', fontSize: 10.5 }}>
          {error}
        </div>
      )}
    </div>
  )
}
