import { z } from 'zod'
import { RuntimeProviderModel, RuntimeProviderRecord } from '../dto'

export const RUNTIME_PROVIDER_LIST_METHOD = 'runtime.provider.list'
export const RUNTIME_PROVIDER_REFRESH_METHOD = 'runtime.provider.refresh'
export const RUNTIME_PROVIDER_MODELS_METHOD = 'runtime.provider.models'

export const RuntimeProviderListParams = z.object({}).strict()
export type RuntimeProviderListParams = z.infer<typeof RuntimeProviderListParams>

export const RuntimeProviderListResult = z.object({
  providers: z.array(RuntimeProviderRecord),
})
export type RuntimeProviderListResult = z.infer<typeof RuntimeProviderListResult>

export const RuntimeProviderRefreshParams = z.object({}).strict()
export type RuntimeProviderRefreshParams = z.infer<typeof RuntimeProviderRefreshParams>

/** 某个 Provider 的模型候选；未知 Provider 由 Core 返回 PROVIDER_NOT_FOUND。 */
export const RuntimeProviderModelsParams = z.object({ providerId: z.string().min(1) }).strict()
export type RuntimeProviderModelsParams = z.infer<typeof RuntimeProviderModelsParams>

export const RuntimeProviderModelsResult = z.object({
  providerName: z.string().min(1),
  models: z.array(RuntimeProviderModel),
  /** provider：由 CLI 动态读取；catalog：CLI 不支持或读取失败，回退内置候选。 */
  source: z.enum(['provider', 'catalog']),
})
export type RuntimeProviderModelsResult = z.infer<typeof RuntimeProviderModelsResult>
