/**
 * 协议版本常量。全仓唯一版本来源：Core/Daemon/Desktop 均从此导入，禁止字面量。
 * `as const` 保留字面量类型，使 z.literal 能推断出精确版本而不是 string。
 * 字符串形式允许未来 "2" 这类非数字比较。
 */
export const PROTOCOL_VERSION = '1' as const

import { z } from 'zod'

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION)
