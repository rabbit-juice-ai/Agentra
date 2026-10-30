/**
 * 协议版本常量。全仓唯一版本来源：Core/Daemon/Desktop 均从此导入。
 * 字符串形式允许未来 "2" 这类非数字比较。
 */
export const PROTOCOL_VERSION = '1'

import { z } from 'zod'

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION)
