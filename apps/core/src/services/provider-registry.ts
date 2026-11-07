import {
  RpcMethodError,
  type RuntimeProviderModel,
  type RuntimeProviderRecord,
} from '@agentra/protocol'
import type { RuntimeClient } from '../daemon/daemon-client'
import type { ProviderRepository } from '../db/repositories/provider-repository'
import type { DrainCoordinator } from '../lifecycle/drain-coordinator'
import { modelsForProvider } from './model-catalog'

export type RegistryLogger = {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

/**
 * RuntimeProviderRecord Registry：发现结果持久化到 runtime_providers，Core 只读 DB。
 * Daemon 负责探测（路径/版本/认证），Core 负责业务侧选择。
 */
export class ProviderRegistry {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly runtime: RuntimeClient,
    private readonly logger?: RegistryLogger,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly drain?: DrainCoordinator,
  ) {}

  list(): RuntimeProviderRecord[] {
    return this.providers.list()
  }

  get(id: string): RuntimeProviderRecord {
    const provider = this.providers.get(id)
    if (!provider) throw new RpcMethodError('PROVIDER_NOT_FOUND', `provider not found: ${id}`)
    return provider
  }

  async refresh(): Promise<RuntimeProviderRecord[]> {
    const lease = this.drain?.acquire('provider-refresh', 'provider:refresh')
    try {
      const infos = await this.runtime.discover()
      const now = this.now()
      const updated = infos.map((info) => this.providers.upsertDiscovered(info, now))
      this.logger?.info('runtime providers refreshed', {
        providers: updated.map((provider) => ({
          id: provider.id,
          version: provider.version,
          healthStatus: provider.healthStatus,
        })),
      })
      return updated
    } finally {
      lease?.release()
    }
  }

  /** 启动路径使用：发现失败不阻断 Core 启动，保留上次已知状态。 */
  async refreshQuietly(): Promise<void> {
    try {
      await this.refresh()
    } catch (error) {
      this.logger?.warn('runtime provider refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  markUnavailable(id: string): void {
    this.providers.setHealth(id, 'unavailable', this.now())
  }

  /**
   * 模型候选：先让 Daemon 调用 Provider 自己的 models 命令；不支持或失败时回退内置目录。
   * 返回 source 让 UI 如实展示「来自 Provider」还是「内置候选」。
   */
  async listModels(providerId: string): Promise<{
    provider: RuntimeProviderRecord
    models: RuntimeProviderModel[]
    source: 'provider' | 'catalog'
  }> {
    const provider = this.get(providerId)
    let models: RuntimeProviderModel[] = []
    try {
      models = (await this.runtime.listModels?.(providerId)) ?? []
    } catch (error) {
      this.logger?.warn('provider model listing failed; using catalog', {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      })
      models = []
    }
    const clean = models
      .map((model) => ({ id: model.id.trim(), label: model.label.trim() || model.id.trim() }))
      .filter((model) => model.id.length > 0)
    if (clean.length > 0) {
      return { provider, models: clean, source: 'provider' }
    }
    return {
      provider,
      models: modelsForProvider(provider.providerName),
      source: 'catalog',
    }
  }
}
