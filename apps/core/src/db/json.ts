import type { z } from 'zod'

/** 持久化 JSON 列的读取校验：损坏或不合 schema 的数据必须显式失败，不能静默降级。 */
export function parseJsonColumn<T>(schema: z.ZodType<T>, raw: string, context: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${context}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`${context}: schema validation failed: ${result.error.message}`)
  }
  return result.data
}

/** JSON 列写入前校验（防止把不合 schema 的数据落库）。 */
export function serializeJsonColumn<T>(schema: z.ZodType<T>, value: T, context: string): string {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`${context}: schema validation failed: ${result.error.message}`)
  }
  return JSON.stringify(result.data)
}
