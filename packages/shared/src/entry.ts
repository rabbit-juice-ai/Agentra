import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 判断当前模块是否被直接运行（而不是被测试或其他模块导入）。
 *
 * 不用文件名后缀匹配：源码态入口是 src/index.ts、打包态是 dist/index.js，
 * 任何后缀白名单都会漏判（曾导致打包后的 Core/Daemon 启动守卫失效、进程直接退出）。
 */
export function isDirectRun(
  moduleUrl: string,
  argvEntry: string | undefined = process.argv[1],
): boolean {
  if (!argvEntry) return false
  return path.resolve(argvEntry) === fileURLToPath(moduleUrl)
}
