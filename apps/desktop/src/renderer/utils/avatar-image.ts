const AVATAR_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const AVATAR_MAX_INPUT_BYTES = 5 * 1024 * 1024
const AVATAR_SIZE = 128

/** 本地图片 → 128×128 方形 data URL（居中裁剪），避免把原图直接写进数据库。 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    const scale = Math.max(AVATAR_SIZE / bitmap.width, AVATAR_SIZE / bitmap.height)
    const width = bitmap.width * scale
    const height = bitmap.height * scale
    context.drawImage(bitmap, (AVATAR_SIZE - width) / 2, (AVATAR_SIZE - height) / 2, width, height)
    return canvas.toDataURL('image/webp', 0.85)
  } finally {
    bitmap.close()
  }
}

export function validateAvatarFile(file: File): string | null {
  if (!AVATAR_IMAGE_TYPES.has(file.type)) return '仅支持 PNG / JPEG / WebP / GIF 图片'
  if (file.size > AVATAR_MAX_INPUT_BYTES) return '图片不能超过 5MB'
  return null
}
