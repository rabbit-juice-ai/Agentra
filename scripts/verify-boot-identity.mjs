#!/usr/bin/env node
/**
 * I1 采样工具：验证同一开机的 Boot Session UUID 稳定。
 *
 * 用法（两种运行时各跑一遍）：
 *   node scripts/verify-boot-identity.mjs --samples 11 --interval-ms 30000 --label node
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-boot-identity.mjs \
 *     --samples 11 --interval-ms 30000 --label electron
 *
 * 每行输出一条 JSON（ISO 时间戳、原始输出、规范化 UUID），结尾输出 summary；
 * 唯一值不为 1（或读取失败）时退出码 1。
 */
import { execFileSync } from 'node:child_process'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const samples = Number(arg('--samples', '11'))
const intervalMs = Number(arg('--interval-ms', '30000'))
const label = arg('--label', `node-${process.version}`)
const records = []

for (let index = 0; index < samples; index += 1) {
  const at = new Date().toISOString()
  let raw = null
  let error = null
  try {
    raw = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const record = { at, label, raw, uuid: raw === null ? null : raw.toUpperCase(), error }
  records.push(record)
  console.log(JSON.stringify(record))
  if (index < samples - 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs)
  }
}

const uniques = [...new Set(records.map((record) => record.uuid))]
const summary = {
  label,
  samples: records.length,
  uniqueCount: uniques.length,
  uniques,
  firstAt: records[0]?.at ?? null,
  lastAt: records[records.length - 1]?.at ?? null,
}
console.log(JSON.stringify({ summary }))
if (uniques.length !== 1 || uniques[0] === null) process.exit(1)
