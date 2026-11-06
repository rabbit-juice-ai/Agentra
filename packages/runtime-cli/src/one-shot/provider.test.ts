import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCodex } from '../codex/discovery'
import { CodexProvider } from '../codex/provider'
import { discoverGemini } from '../gemini/discovery'
import { GeminiProvider } from '../gemini/provider'
import { FAKE_CODEX_PATH, FAKE_GEMINI_PATH } from '../test-fixtures'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-one-shot-'))
  dirs.push(dir)
  return dir
}

function terminal(
  provider: CodexProvider | GeminiProvider,
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

describe('CodexProvider', () => {
  it('discovers the CLI and reports its version', async () => {
    const [info] = await new CodexProvider({ executablePath: FAKE_CODEX_PATH }).discover()
    expect(info).toMatchObject({
      providerId: 'codex',
      providerName: 'Codex',
      version: '0.166.0',
      healthStatus: 'healthy',
    })
  })

  it('runs one headless turn and exposes the final agent message as stdout', async () => {
    const provider = new CodexProvider({ executablePath: FAKE_CODEX_PATH })
    const executionId = 'exe-codex-1'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'hello',
      workingDirectory: tempDir(),
      sessionId: 'ses-codex-1',
      allowedTools: ['Read'],
    })
    const result = await done
    expect(result).toEqual({ status: 'succeeded', stdout: 'OK' })
    await expect(provider.sendMessage()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(provider.resume()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  })

  it('marks a failed turn as failed', async () => {
    const provider = new CodexProvider({ executablePath: FAKE_CODEX_PATH })
    const executionId = 'exe-codex-fail'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'FAIL',
      workingDirectory: tempDir(),
      sessionId: 'ses-codex-fail',
      allowedTools: ['Read'],
    })
    expect((await done).status).toBe('failed')
  })

  it('discovery can be tested with an injected runner', async () => {
    const info = await discoverCodex({
      env: { AGENTRA_CODEX_PATH: FAKE_CODEX_PATH },
      run: async () => ({
        code: 0,
        signal: null,
        stdout: '0.166.0\n',
        stderr: '',
        timedOut: false,
      }),
    })
    expect(info.executablePath).toBe(FAKE_CODEX_PATH)
    expect(info.version).toBe('0.166.0')
  })
})

describe('GeminiProvider', () => {
  it('discovers the CLI and reports its version', async () => {
    const [info] = await new GeminiProvider({ executablePath: FAKE_GEMINI_PATH }).discover()
    expect(info).toMatchObject({
      providerId: 'gemini',
      providerName: 'Gemini CLI',
      version: '0.52.0',
      healthStatus: 'healthy',
    })
  })

  it('collects streamed assistant deltas into the final stdout', async () => {
    const provider = new GeminiProvider({ executablePath: FAKE_GEMINI_PATH })
    const executionId = 'exe-gemini-1'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'hello',
      workingDirectory: tempDir(),
      sessionId: 'ses-gemini-1',
      allowedTools: ['Read'],
    })
    expect(await done).toEqual({ status: 'succeeded', stdout: 'OK' })
  })

  it('marks a failed turn as failed', async () => {
    const provider = new GeminiProvider({ executablePath: FAKE_GEMINI_PATH })
    const executionId = 'exe-gemini-fail'
    const done = terminal(provider, executionId)
    await provider.start({
      executionId,
      prompt: 'FAIL',
      workingDirectory: tempDir(),
      sessionId: 'ses-gemini-fail',
      allowedTools: ['Read'],
    })
    expect((await done).status).toBe('failed')
  })

  it('discovery can be tested with an injected runner', async () => {
    const info = await discoverGemini({
      env: { AGENTRA_GEMINI_PATH: FAKE_GEMINI_PATH },
      run: async () => ({ code: 0, signal: null, stdout: '0.52.0\n', stderr: '', timedOut: false }),
    })
    expect(info.executablePath).toBe(FAKE_GEMINI_PATH)
    expect(info.version).toBe('0.52.0')
  })
})
