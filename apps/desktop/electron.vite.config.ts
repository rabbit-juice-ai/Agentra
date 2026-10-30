import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // workspace 包必须打进 bundle：其 exports 指向 TS 源码，Electron 运行时无法直接
    // 解析（Node ESM 不做无扩展名补全）。只外置真正的运行时依赖（ws）。
    plugins: [externalizeDepsPlugin({ exclude: ['@agentra/protocol', '@agentra/shared'] })],
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
    },
    resolve: {
      // workspace 包的 exports 指向 src，main 进程打包时直接消费 TS 源码。
      conditions: ['source'],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // 强制 CJS：ESM preload 需要 .mjs 且必须关闭 sandbox；保持 sandbox 开启更安全。
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'] },
    },
    resolve: {
      conditions: ['source'],
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      conditions: ['source'],
    },
  },
})
