import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCodexModels } from './models'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-codex-models-'))
  dirs.push(home)
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  return home
}

describe('Codex configured model discovery', () => {
  it('reads the cc-switch catalog and filters image-only models', () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, '.codex', 'cc-switch-model-catalog.json'),
      JSON.stringify({
        models: [
          { slug: 'cn:glm-5.2', display_name: 'cn:glm-5.2' },
          { slug: 'cn:deepseek-v4.1-flash', display_name: 'cn:deepseek-v4.1-flash' },
          { slug: 'cn:hunyuan-image-alpha', display_name: 'cn:hunyuan-image-alpha' },
          { slug: 'cn:glm-5.2', display_name: 'duplicate' },
        ],
      }),
    )
    expect(discoverCodexModels({ homeDir: home, env: {} })).toEqual([
      { id: 'cn:glm-5.2', label: 'glm-5.2' },
      { id: 'cn:deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' },
    ])
  })

  it('falls back to config.toml model and then to env', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\n')
    expect(discoverCodexModels({ homeDir: home, env: {} })).toEqual([
      { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    ])

    const empty = tempHome()
    expect(discoverCodexModels({ homeDir: empty, env: { OPENAI_MODEL: 'deepseek-v4.1' } })).toEqual(
      [{ id: 'deepseek-v4.1', label: 'deepseek-v4.1' }],
    )
  })
})
