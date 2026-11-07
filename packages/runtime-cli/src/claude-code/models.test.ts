import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverClaudeModels } from './models'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function homeWithSettings(settings: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-claude-models-'))
  dirs.push(home)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings))
  return home
}

type Call = { url: string; headers: Record<string, string> }

function fakeFetch(responder: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return responder(call)
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('Claude configured model discovery', () => {
  it('reads the cc-switch style catalog from the configured proxy', async () => {
    const home = homeWithSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'cn:deepseek-v4.1-flash',
      },
    })
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: 'cn:glm-5.2', display_name: 'cn:glm-5.2' },
              { slug: 'cn:deepseek-v4.1-flash', display_name: 'cn:deepseek-v4.1-flash' },
              { slug: 'cn:hunyuan-image-alpha', display_name: 'cn:hunyuan-image-alpha' },
            ],
          }),
          { status: 200 },
        ),
    )
    const models = await discoverClaudeModels({ env: {}, homeDir: home, fetchImpl })
    expect(models).toEqual([
      { id: 'cn:glm-5.2', label: 'glm-5.2' },
      { id: 'cn:deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' },
    ])
    expect(calls[0]?.url).toBe('http://127.0.0.1:15721/v1/models')
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token')
    expect(JSON.stringify(models)).not.toContain('secret-token')
  })

  it('falls back to x-api-key for the Anthropic {data:[...]} shape', async () => {
    const home = homeWithSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
      },
    })
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.headers.authorization
        ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        : new Response(
            JSON.stringify({
              data: [{ id: 'claude-custom', display_name: 'Claude Custom' }],
            }),
            { status: 200 },
          ),
    )
    const models = await discoverClaudeModels({ env: {}, homeDir: home, fetchImpl })
    expect(models).toEqual([{ id: 'claude-custom', label: 'Claude Custom' }])
    expect(calls[1]?.headers['x-api-key']).toBe('secret-token')
  })

  it('uses the configured alias mappings when the proxy is unavailable', async () => {
    const home = homeWithSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'cn:glm-5.2',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'cn:deepseek-v4.1-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'cn:deepseek-v4.1-flash',
      },
    })
    const { fetchImpl } = fakeFetch(() => {
      throw new Error('proxy offline')
    })
    const models = await discoverClaudeModels({ env: {}, homeDir: home, fetchImpl })
    expect(models).toEqual([
      { id: 'cn:glm-5.2', label: 'glm-5.2' },
      { id: 'cn:deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' },
    ])
  })

  it('reads environment overrides when no settings file exists', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-claude-models-env-'))
    dirs.push(home)
    const models = await discoverClaudeModels({
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'cn:glm-5.3',
      },
      homeDir: home,
    })
    expect(models).toEqual([{ id: 'cn:glm-5.3', label: 'glm-5.3' }])
  })
})
