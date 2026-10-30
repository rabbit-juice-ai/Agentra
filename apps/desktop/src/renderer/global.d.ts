import type { AgentraApi } from '../shared/api'

declare global {
  interface Window {
    agentra: AgentraApi
  }

  /**
   * 构建期常量，由 electron.vite.config.ts 的 define 注入（U2）。
   * 发布构建为 false，控制台代码在打包时被移除；开发控制台构建为 true。
   */
  const __AGENTRA_DEV_CONSOLE__: boolean
}
