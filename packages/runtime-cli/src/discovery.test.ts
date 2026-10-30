import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverClaudeCode,
  findClaudeExecutable,
  interpretAuthStatus,
  parseVersion,
} from './claude-code/discovery'
import type { CommandResult } from './run-command'
import { FAKE_CLAUDE_PATH as FAKE_CLAUDE } from './test-fixtures'

function ok(stdout: string): CommandResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

describe('findClaudeExecutable', () => {
  it('honors AGENTRA_CLAUDE_PATH when it is executable', () => {
    expect(findClaudeExecutable({ AGENTRA_CLAUDE_PATH: FAKE_CLAUDE, PATH: '' }, os.tmpdir())).toBe(
      path.resolve(FAKE_CLAUDE),
    )
  })

  it('ignores AGENTRA_CLAUDE_PATH when the file is missing', () => {
    expect(
      findClaudeExecutable(
        { AGENTRA_CLAUDE_PATH: '/nonexistent/claude', PATH: '' },
        path.join(os.tmpdir(), 'agentra-no-such-home'),
      ),
    ).toBeNull()
  })

  it('finds claude on PATH', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentra-bin-'))
    try {
      const link = path.join(binDir, 'claude')
      fs.symlinkSync(FAKE_CLAUDE, link)
      const found = findClaudeExecutable({ PATH: binDir }, binDir)
      expect(found).toBe(path.resolve(link))
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('parseVersion', () => {
  it('parses the real claude --version format', () => {
    expect(parseVersion('2.1.314 (Claude Code)\n')).toBe('2.1.314')
  })

  it('parses a v-prefixed version', () => {
    expect(parseVersion('v1.2.3\n')).toBe('1.2.3')
  })

  it('returns null for unparseable output', () => {
    expect(parseVersion('not a version')).toBeNull()
  })
})

describe('interpretAuthStatus', () => {
  it('reports authenticated when loggedIn is true', () => {
    const probe = interpretAuthStatus(ok('{"loggedIn":true,"authMethod":"oauth_token"}'), {})
    expect(probe).toMatchObject({ authenticated: true, authMethod: 'oauth_token' })
  })

  it('reports unauthenticated when loggedIn is false and no API key exists', () => {
    const probe = interpretAuthStatus(ok('{"loggedIn":false}'), {})
    expect(probe.authenticated).toBe(false)
    expect(probe.detail).toContain('claude auth login')
  })

  it('accepts an API key as an alternative auth source', () => {
    const probe = interpretAuthStatus(ok('{"loggedIn":false}'), { ANTHROPIC_API_KEY: 'sk-test' })
    expect(probe).toMatchObject({ authenticated: true, authMethod: 'api_key' })
  })

  it('falls back to API key detection when auth status output is not JSON', () => {
    const probe = interpretAuthStatus(ok('unknown command'), { ANTHROPIC_API_KEY: 'sk-test' })
    expect(probe.authenticated).toBe(true)
    expect(interpretAuthStatus(ok('unknown command'), {}).authenticated).toBe(false)
  })
})

describe('discoverClaudeCode', () => {
  it('discovers the fake CLI: path, version, health and capabilities', async () => {
    const info = await discoverClaudeCode({
      env: { AGENTRA_CLAUDE_PATH: FAKE_CLAUDE, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    expect(info.executablePath).toBe(path.resolve(FAKE_CLAUDE))
    expect(info.version).toBe('9.9.9')
    expect(info.healthStatus).toBe('healthy')
    expect(info.healthDetail).toBe('')
    expect(info.capabilities.interrupt).toBe('native')
    expect(info.capabilities.checkpoint).toBe('unsupported')
    expect(info.providerId).toBe('claude-code')
    expect(info.providerType).toBe('cli')
  })

  it('reports unauthenticated with an actionable hint', async () => {
    const info = await discoverClaudeCode({
      env: {
        AGENTRA_CLAUDE_PATH: FAKE_CLAUDE,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        FAKE_CLAUDE_AUTH: 'fail',
      },
    })
    expect(info.healthStatus).toBe('unauthenticated')
    expect(info.healthDetail).toContain('claude auth login')
    expect(info.version).toBe('9.9.9')
  })

  it('reports unavailable with install hint when the CLI is missing', async () => {
    const info = await discoverClaudeCode({
      env: { AGENTRA_CLAUDE_PATH: '/nonexistent/claude', PATH: '' },
      homeDir: path.join(os.tmpdir(), 'agentra-no-such-home'),
    })
    expect(info.healthStatus).toBe('unavailable')
    expect(info.executablePath).toBeNull()
    expect(info.healthDetail).toContain('AGENTRA_CLAUDE_PATH')
  })

  it('reports unavailable when --version fails', async () => {
    const info = await discoverClaudeCode({
      env: { AGENTRA_CLAUDE_PATH: FAKE_CLAUDE, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      run: async () => ({ code: 2, signal: null, stdout: '', stderr: 'boom', timedOut: false }),
    })
    expect(info.healthStatus).toBe('unavailable')
    expect(info.healthDetail).toContain('boom')
  })
})
