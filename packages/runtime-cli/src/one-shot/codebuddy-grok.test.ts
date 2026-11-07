import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeProvider } from '@agentra/runtime-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCodeBuddy } from '../codebuddy/discovery'
import { CodeBuddyProvider } from '../codebuddy/provider'
import { discoverGrok } from '../grok/discovery'
import { GrokProvider } from '../grok/provider'
import { FAKE_CLAUDE_PATH, FAKE_GROK_PATH } from '../test-fixtures'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-more-providers-'))
  dirs.push(dir)
  return dir
}

function terminal(
  provider: RuntimeProvider,
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

describe('CodeBuddyProvider', () => {
  it('discovers the CLI with an injected runner', async () => {
    const info = await discoverCodeBuddy({
      env: { AGENTRA_CODEBUDDY_PATH: FAKE_CLAUDE_PATH },
      run: async () => ({ code: 0, signal: null, stdout: '2.82.0\n', stderr: '', timedOut: false }),
    })
    expect(info).toMatchObject({
      providerId: 'codebuddy',
      version: '2.82.0',
      healthStatus: 'healthy',
    })
  })

  it('runs the Claude-compatible stream-json session', async () => {
    const provider = new CodeBuddyProvider({ executablePath: FAKE_CLAUDE_PATH })
    const executionId = 'exe-codebuddy-1'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'TASK_A',
      workingDirectory: tempDir(),
      sessionId: 'ses-codebuddy-1',
      allowedTools: ['Read'],
    })
    const result = await done
    expect(result.status).toBe('succeeded')
    expect(result.stdout).toContain('echo:TASK_A')
  })
})

describe('GrokProvider', () => {
  it('marks an unauthenticated CLI as unauthenticated', async () => {
    const info = await discoverGrok({
      env: { AGENTRA_GROK_PATH: FAKE_GROK_PATH },
      run: async (_file, args) =>
        args[0] === 'models'
          ? {
              code: 0,
              signal: null,
              stdout: 'You are not authenticated.\n',
              stderr: '',
              timedOut: false,
            }
          : {
              code: 0,
              signal: null,
              stdout: 'grok 1.0.5 (fixture)\n',
              stderr: '',
              timedOut: false,
            },
    })
    expect(info).toMatchObject({
      providerId: 'grok',
      version: '1.0.5',
      healthStatus: 'unauthenticated',
    })
  })

  it('reads the model list from grok models output', async () => {
    const provider = new GrokProvider({
      executablePath: FAKE_GROK_PATH,
      discovery: {
        run: async () => ({
          code: 0,
          signal: null,
          stdout:
            'You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n',
          stderr: '',
          timedOut: false,
        }),
      },
    })
    expect(await provider.listModels()).toEqual([
      { id: 'grok-4.6', label: 'grok-4.6' },
      { id: 'grok-4.5', label: 'grok-4.5' },
    ])
  })

  it('collects text deltas and the final result', async () => {
    const provider = new GrokProvider({ executablePath: FAKE_GROK_PATH })
    const executionId = 'exe-grok-1'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'hello',
      workingDirectory: tempDir(),
      sessionId: 'ses-grok-1',
      allowedTools: ['Read'],
    })
    expect(await done).toEqual({ status: 'succeeded', stdout: 'OK' })
  })

  it('marks a failed turn as failed', async () => {
    const provider = new GrokProvider({ executablePath: FAKE_GROK_PATH })
    const executionId = 'exe-grok-fail'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'FAIL',
      workingDirectory: tempDir(),
      sessionId: 'ses-grok-fail',
      allowedTools: ['Read'],
    })
    expect((await done).status).toBe('failed')
  })
})
