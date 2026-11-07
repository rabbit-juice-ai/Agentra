import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试夹具：模拟 Claude Code stream-json 的 Node 脚本（仓库内，非生产依赖）。 */
export const FAKE_CLAUDE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-claude.mjs',
)
export const FAKE_CODEX_PATH = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
export const FAKE_GEMINI_PATH = fileURLToPath(
  new URL('../fixtures/fake-gemini.mjs', import.meta.url),
)
export const FAKE_GROK_PATH = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url))
export const FAKE_ANTIGRAVITY_PATH = fileURLToPath(
  new URL('../fixtures/fake-antigravity.mjs', import.meta.url),
)
