import { execSync } from 'node:child_process'

let canSpawnCache: boolean | null = null

/**
 * 检测当前环境是否支持 spawn 子进程。
 *
 * WebContainer 等沙箱环境不支持 execSync，会在首次调用时抛错。
 * 用模块级缓存避免每次工具调用都重复探测。
 */
export function canSpawnProcess(): boolean {
  if (canSpawnCache !== null) return canSpawnCache
  try {
    execSync('echo test', { stdio: 'ignore' })
    canSpawnCache = true
  } catch {
    canSpawnCache = false
  }
  return canSpawnCache
}
