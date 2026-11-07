import type { RuntimeProviderRecord } from '@agentra/protocol'
import { describe, expect, it } from 'vitest'
import type { RuntimeClient } from '../daemon/daemon-client'
import type { ProviderRepository } from '../db/repositories/provider-repository'
import { ProviderRegistry } from './provider-registry'

const NOW = '2026-11-07T00:00:00.000Z'

function provider(overrides: Partial<RuntimeProviderRecord> = {}): RuntimeProviderRecord {
  return {
    id: 'claude-code',
    providerType: 'cli',
    providerName: 'Claude Code',
    executablePath: '/usr/local/bin/claude',
    version: '2.1.318',
    capabilities: {
      streaming: 'native',
      structuredEvents: 'native',
      interrupt: 'native',
      resume: 'native',
      checkpoint: 'unsupported',
      permissionRequests: 'native',
      sessionPersistence: 'native',
      workingDirectory: 'native',
      toolControl: 'native',
    },
    healthStatus: 'healthy',
    authMethod: 'oauth_token',
    healthDetail: null,
    lastDiscoveredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function harness(
  record: RuntimeProviderRecord,
  listModels?: RuntimeClient['listModels'],
): ProviderRegistry {
  const repository = {
    get: (id: string) => (id === record.id ? record : null),
    list: () => [record],
  } as unknown as ProviderRepository
  const runtime = { listModels } as unknown as RuntimeClient
  return new ProviderRegistry(repository, runtime)
}

describe('ProviderRegistry.listModels', () => {
  it('uses the models reported by the provider', async () => {
    const record = provider({ id: 'antigravity', providerName: 'Antigravity CLI' })
    const registry = harness(record, async () => [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    ])
    await expect(registry.listModels('antigravity')).resolves.toEqual({
      provider: record,
      models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }],
      source: 'provider',
    })
  })

  it('falls back to the built-in catalog when the daemon cannot list models', async () => {
    const record = provider()
    const registry = harness(record)
    const result = await registry.listModels('claude-code')
    expect(result.source).toBe('catalog')
    expect(result.models.map((model) => model.id)).toContain('sonnet')
  })

  it('falls back to the catalog when listing throws or returns nothing', async () => {
    const record = provider()
    const throwing = harness(record, async () => {
      throw new Error('cli failed')
    })
    await expect(throwing.listModels('claude-code')).resolves.toMatchObject({ source: 'catalog' })

    const empty = harness(record, async () => [])
    await expect(empty.listModels('claude-code')).resolves.toMatchObject({ source: 'catalog' })
  })

  it('rejects an unknown provider', async () => {
    const registry = harness(provider())
    await expect(registry.listModels('missing')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    })
  })
})
