// 示例项目：通用工具函数

export function formatDate(d: Date): string {
  // 待办：支持多时区，目前只输出本地时间
  return d.toISOString().slice(0, 10)
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: any = null
  return ((...args: any[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}
