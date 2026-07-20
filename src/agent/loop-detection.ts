import { createHash } from 'node:crypto'

export interface ToolCallRecord {
  toolName: string
  argsHash: string
  resultHash?: string
  timestamp: number
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker'

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true
      level: 'warning' | 'critical'
      detector: DetectorKind
      count: number
      message: string
    }

export interface LoopDetectorOptions {
  historySize: number
  warningThreshold: number
  criticalThreshold: number
  breakerThreshold: number
}

export const DEFAULT_LOOP_DETECTOR_OPTIONS: LoopDetectorOptions = {
  historySize: 30,
  warningThreshold: 5,
  criticalThreshold: 8,
  breakerThreshold: 10,
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function hash(input: string) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function hashToolCall(toolName: string, params: unknown) {
  return `${toolName}:${hash(stableStringify(params))}`
}

export function hashResult(result: unknown) {
  return hash(stableStringify(result))
}

/** 每个智能体循环独立使用一个检测器，不在不同会话间共享模块级历史记录。 */
export class LoopDetector {
  private readonly history: ToolCallRecord[] = []
  private readonly options: LoopDetectorOptions

  constructor(options: Partial<LoopDetectorOptions> = {}) {
    this.options = { ...DEFAULT_LOOP_DETECTOR_OPTIONS, ...options }
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`LoopDetectorOptions.${name} 必须是正整数`)
      }
    }
    if (this.options.warningThreshold > this.options.criticalThreshold) {
      throw new Error('warningThreshold 不能大于 criticalThreshold')
    }
  }

  recordCall(toolName: string, params: unknown) {
    const record: ToolCallRecord = {
      toolName,
      argsHash: hashToolCall(toolName, params),
      timestamp: Date.now(),
    }
    this.history.push(record)
    if (this.history.length > this.options.historySize) this.history.shift()
    return record
  }

  recordResult(record: ToolCallRecord, result: unknown) {
    record.resultHash = hashResult(result)
  }

  detect(toolName: string, params: unknown): DetectionResult {
    const argsHash = hashToolCall(toolName, params)
    const noProgress = this.getNoProgressStreak(toolName, argsHash)

    if (noProgress >= this.options.breakerThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: noProgress,
        message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
      }
    }

    const pingPong = this.getPingPongCount(argsHash)
    if (pingPong >= this.options.criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'ping_pong',
        count: pingPong,
        message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
      }
    }
    if (pingPong >= this.options.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'ping_pong',
        count: pingPong,
        message: `[警告] 检测到乒乓循环（${pingPong} 次交替），已阻止本次调用`,
      }
    }

    const recentCount = this.history.filter(
      (record) => record.toolName === toolName && record.argsHash === argsHash,
    ).length + 1
    if (recentCount >= this.options.criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
      }
    }
    if (recentCount >= this.options.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，已阻止本次调用`,
      }
    }

    return { stuck: false }
  }

  private getNoProgressStreak(toolName: string, argsHash: string) {
    let streak = 0
    let lastResultHash: string | undefined

    for (let index = this.history.length - 1; index >= 0; index--) {
      const record = this.history[index]
      if (record.toolName !== toolName || record.argsHash !== argsHash || !record.resultHash) continue
      if (!lastResultHash) {
        lastResultHash = record.resultHash
        streak = 1
        continue
      }
      if (record.resultHash !== lastResultHash) break
      streak++
    }
    return streak
  }

  private getPingPongCount(currentHash: string) {
    if (this.history.length < 3) return 0

    const last = this.history[this.history.length - 1]
    let otherHash: string | undefined
    for (let index = this.history.length - 2; index >= 0; index--) {
      if (this.history[index].argsHash !== last.argsHash) {
        otherHash = this.history[index].argsHash
        break
      }
    }
    if (!otherHash) return 0

    let count = 0
    for (let index = this.history.length - 1; index >= 0; index--) {
      const expected = count % 2 === 0 ? last.argsHash : otherHash
      if (this.history[index].argsHash !== expected) break
      count++
    }

    return currentHash === otherHash && count >= 2 ? count + 1 : 0
  }
}
