#!/usr/bin/env node
/**
 * U2 发布构建隔离检查：对**构建产物**断言开发者执行控制台的标记存在/缺失。
 *
 * 判据是产物本身，不是源码里的运行时开关：
 * - 发布向（默认 `pnpm build`）：控制台页面与导航项的两个标记都必须**不存在**；
 * - 开发控制台向（`AGENTRA_DEV_CONSOLE=1`，走 build:dev-console）：两个标记都必须**存在**，
 *   否则说明检查空转（例如开关没生效、产物路径变了），同样判失败。
 *
 * 阶段 6 会对真实安装包执行同一条断言（换扫描目录即可）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const assetsDir = path.join(repoRoot, 'apps', 'desktop', 'out', 'renderer', 'assets')
// 模式以命令行参数为准（`AGENTRA_DEV_CONSOLE=1 a && b` 里的变量只作用于 a，不会传给 b）；
// 环境变量仅作兼容。
const expectConsole =
  process.argv.includes('--expect-console') || process.env.AGENTRA_DEV_CONSOLE === '1'

const MARKERS = [
  { name: '执行控制台页面', value: 'agentra-dev-console' },
  // 导航项文案：页面被移除但导航项残留时，这条能单独抓住（约束 2：两者必须同时消失）
  { name: '导航项文案', value: '执行控制台' },
]

/**
 * 产品页面标记：Team / Work 是阶段 2 的产品功能，**两种构建都必须包含**。
 * 这条正向断言防止有人把产品页也挂到 __AGENTRA_DEV_CONSOLE__ 开关上，
 * 或让检查脚本把它们的消失当成"隔离成功"。
 */
const REQUIRED_MARKERS = [
  { name: 'Team 页面', value: 'agentra-product-teams' },
  { name: 'Work 页面', value: 'agentra-product-works' },
  // 阶段 3：画布是产品功能，两种构建都必须包含；与控制台标记互不影响。
  { name: 'Workflow 页面', value: 'agentra-product-workflow' },
  // 阶段 5 S5-3：审批中心与 Artifact 面板是产品功能，两种构建都必须包含。
  { name: '审批中心页面', value: 'agentra-product-approvals' },
  { name: 'Artifact 面板', value: 'agentra-product-artifacts' },
]

function modeLabel(devConsole) {
  return devConsole ? '开发控制台' : '发布'
}

/** 打包器可能把非 ASCII 字符转义成 \uXXXX，先还原再匹配。 */
const unescapeUnicode = (text) =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))

if (!fs.existsSync(assetsDir)) {
  console.error(`[check-release-bundle] 未找到产物目录 ${assetsDir}，请先执行构建`)
  process.exit(1)
}

const files = fs.readdirSync(assetsDir).filter((file) => file.endsWith('.js'))
if (files.length === 0) {
  console.error(`[check-release-bundle] 产物目录中没有 JS 文件：${assetsDir}`)
  process.exit(1)
}

const contents = files.map((file) =>
  unescapeUnicode(fs.readFileSync(path.join(assetsDir, file), 'utf8')),
)

const problems = []
for (const marker of MARKERS) {
  const present = contents.some((content) => content.includes(marker.value))
  if (expectConsole && !present) {
    problems.push(`开发控制台构建缺少「${marker.name}」标记（检查可能空转）`)
  }
  if (!expectConsole && present) {
    problems.push(`发布构建包含「${marker.name}」标记（控制台未隔离）`)
  }
}

for (const marker of REQUIRED_MARKERS) {
  const present = contents.some((content) => content.includes(marker.value))
  if (!present) problems.push(`${modeLabel(expectConsole)}缺少产品页面「${marker.name}」`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}

console.log(`[check-release-bundle] ${modeLabel(expectConsole)}构建检查通过（扫描 ${files.length} 个 JS 产物）`)
