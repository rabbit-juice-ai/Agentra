import { z } from 'zod'
import { RuntimeProvider } from '../dto'

export const RUNTIME_PROVIDER_LIST_METHOD = 'runtime.provider.list'
export const RUNTIME_PROVIDER_REFRESH_METHOD = 'runtime.provider.refresh'

export const RuntimeProviderListParams = z.object({}).strict()
export type RuntimeProviderListParams = z.infer<typeof RuntimeProviderListParams>

export const RuntimeProviderListResult = z.object({
  providers: z.array(RuntimeProvider),
})
export type RuntimeProviderListResult = z.infer<typeof RuntimeProviderListResult>

export const RuntimeProviderRefreshParams = z.object({}).strict()
export type RuntimeProviderRefreshParams = z.infer<typeof RuntimeProviderRefreshParams>
