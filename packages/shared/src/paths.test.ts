import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentraHome, agentraPaths, ensureDirs, MAX_SOCKET_PATH_BYTES } from './paths'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentra-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('agentraHome', () => {
  it('defaults to ~/Library/Application Support/agentra', () => {
    expect(agentraHome({}, '/Users/test')).toBe('/Users/test/Library/Application Support/agentra')
  })

  it('honors AGENTRA_DATA_DIR override', () => {
    const dir = tempHome()
    expect(agentraHome({ AGENTRA_DATA_DIR: dir })).toBe(path.resolve(dir))
  })
})

describe('agentraPaths', () => {
  it('derives runtime, logs, sockets and pid files under home', () => {
    const dir = tempHome()
    const p = agentraPaths(dir)
    expect(p.runtime).toBe(path.join(dir, 'runtime'))
    expect(p.logs).toBe(path.join(dir, 'logs'))
    expect(p.coreSocket).toBe(path.join(dir, 'runtime', 'core.sock'))
    expect(p.daemonPid).toBe(path.join(dir, 'runtime', 'daemon.pid'))
    expect(p.daemonLog).toBe(path.join(dir, 'logs', 'daemon.log'))
  })

  it('throws a human-readable error when socket path exceeds the limit', () => {
    const long = path.join(tempHome(), 'x'.repeat(120))
    expect(() => agentraPaths(long)).toThrow(/exceeds/)
  })

  it('socket paths stay within the sun_path budget', () => {
    const p = agentraPaths(tempHome())
    expect(Buffer.byteLength(p.coreSocket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)
    expect(Buffer.byteLength(p.daemonSocket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)
  })
})

describe('ensureDirs', () => {
  it('creates home, runtime and logs directories', () => {
    const dir = tempHome()
    const p = agentraPaths(dir)
    ensureDirs(p)
    for (const d of [p.home, p.runtime, p.logs]) {
      expect(() => {
        writeFileSync(path.join(d, '.probe'), '')
        rmSync(path.join(d, '.probe'))
      }).not.toThrow()
    }
  })
})
