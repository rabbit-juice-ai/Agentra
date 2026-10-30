import crypto from 'node:crypto'

/** 生成 RPC requestId / 事件 id（≥8 字符，满足协议信封下限）。 */
export function newId(prefix = 'id'): string {
  return `${prefix}-${crypto.randomUUID()}`
}
