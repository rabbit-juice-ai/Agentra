import fs from 'node:fs'
import type { StartExecutionConfig } from '@agentra/runtime-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import type { OneShotParseState } from '../one-shot/provider'
import { FAKE_ANTIGRAVITY_PATH } from '../test-fixtures'
import { discoverAntigravity } from './discovery'
import { AntigravityProvider } from './provider'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

class TestProvider extends AntigravityProvider {
  args(config: StartExecutionConfig): string[] {
    return this.argsFor(config)
  }

  parse(line: string, state: OneShotParseState): void {
    this.parseLine(line, state)
  }
}

function config(overrides: Partial<StartExecutionConfig> = {}): StartExecutionConfig {
  return {
    executionId: 'exe-agy-1',
    prompt: 'hello',
    workingDirectory: '/tmp',
    sessionId: 'ses-agy-1',
    ...overrides,
  }
}

function terminal(
  provider: AntigravityProvider,
  executionId: string,
): Promise<{ status: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('execution did not finish'))
    }, 5000)
    const unsubscribe = provider.subscribe(executionId, (event) => {
      if (event.type === 'output' && event.stream === 'stdout') stdout += event.content
      if (
        event.type === 'state' &&
        (event.status === 'succeeded' || event.status === 'failed' || event.status === 'cancelled')
      ) {
        clearTimeout(timer)
        unsubscribe()
        resolve({ status: event.status, stdout })
      }
    })
  })
}

describe('Antigravity CLI discovery', () => {
  it('reports version and healthy status from the CLI', async () => {
    const info = await discoverAntigravity({
      env: { AGENTRA_ANTIGRAVITY_PATH: FAKE_ANTIGRAVITY_PATH },
      run: async (_file, args) => ({
        code: 0,
        signal: null,
        stdout: args[0] === '--version' ? 'agy 1.4.0 (fixture)' : 'gemini-3.8-flash',
        stderr: '',
        timedOut: false,
      }),
    })
    expect(info).toMatchObject({
      providerId: 'antigravity',
      providerName: 'Antigravity CLI',
      version: '1.4.0',
      healthStatus: 'healthy',
      executablePath: FAKE_ANTIGRAVITY_PATH,
    })
  })

  it('marks an unauthenticated CLI as unauthenticated', async () => {
    const info = await discoverAntigravity({
      env: { AGENTRA_ANTIGRAVITY_PATH: FAKE_ANTIGRAVITY_PATH },
      run: async (_file, args) =>
        args[0] === 'models'
          ? {
              code: 1,
              signal: null,
              stdout: '',
              stderr: 'Error: not authenticated. Please log in.\n',
              timedOut: false,
            }
          : {
              code: 0,
              signal: null,
              stdout: 'agy 1.4.0',
              stderr: '',
              timedOut: false,
            },
    })
    expect(info).toMatchObject({
      providerId: 'antigravity',
      healthStatus: 'unauthenticated',
    })
  })

  it('reports unavailable when the executable is missing', async () => {
    const info = await discoverAntigravity({ env: {}, homeDir: '/nonexistent' })
    expect(info).toMatchObject({
      providerId: 'antigravity',
      healthStatus: 'unavailable',
      executablePath: null,
    })
  })
})

describe('AntigravityProvider', () => {
  it('passes model and only skips permissions for edit tools', () => {
    const provider = new TestProvider({ executablePath: FAKE_ANTIGRAVITY_PATH })
    const analyze = provider.args(config({ model: 'gemini-3.8-flash', allowedTools: ['Read'] }))
    expect(analyze.slice(0, 4)).toEqual(['-p', 'hello', '--output-format', 'stream-json'])
    expect(analyze).toContain('--model')
    expect(analyze).toContain('gemini-3.8-flash')
    expect(analyze).not.toContain('--dangerously-skip-permissions')

    const edit = provider.args(config({ allowedTools: ['Read', 'Edit'] }))
    expect(edit).toContain('--dangerously-skip-permissions')
  })

  it('reads the model list from agy models output', async () => {
    const provider = new AntigravityProvider({
      executablePath: FAKE_ANTIGRAVITY_PATH,
      discovery: {
        run: async (_file, args) => ({
          code: 0,
          signal: null,
          stdout:
            args[0] === 'models'
              ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n'
              : 'agy 1.4.0 (fixture)',
          stderr: '',
          timedOut: false,
        }),
      },
    })
    expect(await provider.listModels()).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    ])
  })

  it('parses stream-json deltas and the final result', () => {
    const provider = new TestProvider({ executablePath: FAKE_ANTIGRAVITY_PATH })
    let text = ''
    let error: string | null = null
    const state: OneShotParseState = {
      appendText: (chunk) => {
        text += chunk
      },
      setText: (chunk) => {
        text = chunk
      },
      markError: (message) => {
        error = message
      },
    }
    provider.parse(
      JSON.stringify({ event: 'step_update', step_update: { text_delta: 'Hi' } }),
      state,
    )
    expect(text).toBe('Hi')
    provider.parse(
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Done' } }),
      state,
    )
    expect(text).toBe('Done')
    provider.parse(
      JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'boom' } }),
      state,
    )
    expect(error).toBe('boom')
  })

  it('runs one headless turn and exposes the final response as stdout', async () => {
    const provider = new AntigravityProvider({ executablePath: FAKE_ANTIGRAVITY_PATH })
    const executionId = 'exe-agy-1'
    const done = terminal(provider, executionId)
    await provider.start(config({ executionId, workingDirectory: process.cwd() }))
    expect(await done).toEqual({ status: 'succeeded', stdout: 'OK' })
    await expect(provider.sendMessage()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(provider.resume()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  })

  it('marks a failed turn as failed', async () => {
    const provider = new AntigravityProvider({ executablePath: FAKE_ANTIGRAVITY_PATH })
    const executionId = 'exe-agy-fail'
    const done = terminal(provider, executionId)
    await provider.start(config({ executionId, prompt: 'FAIL', workingDirectory: process.cwd() }))
    expect((await done).status).toBe('failed')
  })
})
