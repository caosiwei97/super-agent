import type { ModelMessage, ToolResultPart } from 'ai'

const TRUNCATED_MARKER = '[truncated:'
const COMPACTED_MARKER = '[tool result compacted:'
const SOFT_PRUNED_MARKER = '[soft pruned:'
const EXPIRED_MARKER = '[tool result expired:'

const FAILURE_PATTERN = /\b(?:error|failed|failure|denied|timeout|timed out|not found|permission)\b|失败|不存在|未找到|拒绝|超时|无权限/i
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export interface ContextDefenseOptions {
  contextWindowTokens: number
  contextBudgetRatio: number
  maxSingleToolResultRatio: number
  asciiCharsPerToken: number
  wideTokensPerChar: number
  softTTLMs: number
  hardTTLMs: number
  softRetainChars: number
}

export const DEFAULT_CONTEXT_DEFENSE_OPTIONS: ContextDefenseOptions = {
  // 仅作兜底默认值；应通过 MODEL_CONTEXT_WINDOW 设为模型真实窗口，
  // compressor 的 tokenThreshold 会按此窗口水位自动派生。
  contextWindowTokens: 16_000,
  contextBudgetRatio: 0.75,
  maxSingleToolResultRatio: 0.5,
  asciiCharsPerToken: 4,
  // 中日韩文字通常比英文更耗 token，按每字符约 2 token 保守估算。
  wideTokensPerChar: 2,
  softTTLMs: 5 * 60_000,
  hardTTLMs: 10 * 60_000,
  softRetainChars: 1_500,
}

export interface ContextDefenseResult {
  messages: ModelMessage[]
  messageTimestamps: number[]
  truncated: number
  compacted: number
  softPruned: number
  hardPruned: number
  beforeTokens: number
  afterTokens: number
}

export function resolveDefenseOptions(options: Partial<ContextDefenseOptions> = {}) {
  const resolved = { ...DEFAULT_CONTEXT_DEFENSE_OPTIONS, ...options }
  const positiveIntegers: Array<keyof ContextDefenseOptions> = [
    'contextWindowTokens',
    'softTTLMs',
    'hardTTLMs',
    'softRetainChars',
  ]
  for (const key of positiveIntegers) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`ContextDefenseOptions.${key} 必须是正整数`)
    }
  }
  if (resolved.softTTLMs >= resolved.hardTTLMs) {
    throw new Error('ContextDefenseOptions.softTTLMs 必须小于 hardTTLMs')
  }
  for (const key of ['contextBudgetRatio', 'maxSingleToolResultRatio'] as const) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0 || resolved[key] > 1) {
      throw new Error(`ContextDefenseOptions.${key} 必须在 (0, 1] 范围内`)
    }
  }
  if (!Number.isFinite(resolved.asciiCharsPerToken) || resolved.asciiCharsPerToken <= 0) {
    throw new Error('ContextDefenseOptions.asciiCharsPerToken 必须是正数')
  }
  if (!Number.isFinite(resolved.wideTokensPerChar) || resolved.wideTokensPerChar <= 0) {
    throw new Error('ContextDefenseOptions.wideTokensPerChar 必须是正数')
  }
  return resolved
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function estimateTextTokensResolved(text: string, options: ContextDefenseOptions) {
  let weightedTokens = 0

  for (const character of text) {
    weightedTokens += WIDE_CHAR.test(character)
      ? options.wideTokensPerChar
      : 1 / options.asciiCharsPerToken
  }

  return Math.ceil(weightedTokens)
}

export function estimateTextTokens(
  text: string,
  options: Partial<ContextDefenseOptions> = {},
) {
  return estimateTextTokensResolved(text, resolveDefenseOptions(options))
}

/** 对 CJK 与 ASCII 混合内容做保守、无 tokenizer 依赖的即时估算。 */
export function estimateTokens(
  messages: ModelMessage[],
  options: Partial<ContextDefenseOptions> = {},
) {
  const resolved = resolveDefenseOptions(options)
  let tokens = 0
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : stringify(message.content)
    tokens += estimateTextTokensResolved(content, resolved)
  }
  return tokens
}

/**
 * 用 API 的 prompt token 做精确基准，新增消息只做轻量增量估算。
 * 上下文被修剪后可用 rebase 将估算值同步到防线返回的新水位。
 */
export class TokenTracker {
  private estimate: number

  constructor(
    messages: ModelMessage[] = [],
    private readonly options: Partial<ContextDefenseOptions> = {},
  ) {
    this.estimate = estimateTokens(messages, options)
  }

  updateFromAPI(promptTokens: number) {
    if (!Number.isFinite(promptTokens) || promptTokens < 0) {
      throw new Error(`非法 promptTokens: ${promptTokens}`)
    }
    this.estimate = promptTokens
  }

  addMessages(messages: ModelMessage[]) {
    this.estimate += estimateTokens(messages, this.options)
  }

  rebase(estimatedTokens: number) {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new Error(`非法 estimatedTokens: ${estimatedTokens}`)
    }
    this.estimate = estimatedTokens
  }

  get estimatedTokens() {
    return Math.ceil(this.estimate)
  }
}

function isAnyDefenseMarker(value: string) {
  return [TRUNCATED_MARKER, COMPACTED_MARKER, SOFT_PRUNED_MARKER, EXPIRED_MARKER]
    .some((marker) => value.includes(marker))
}

function isFinalDefenseMarker(value: string) {
  return [COMPACTED_MARKER, SOFT_PRUNED_MARKER, EXPIRED_MARKER]
    .some((marker) => value.includes(marker))
}

function shouldSkipTTLMarker(value: string, hardExpired: boolean) {
  if (value.includes(COMPACTED_MARKER) || value.includes(EXPIRED_MARKER)) return true
  return !hardExpired && value.includes(SOFT_PRUNED_MARKER)
}

export function isFailureToolResult(part: ToolResultPart) {
  if (part.output.type === 'error-text' || part.output.type === 'error-json') return true
  if (part.output.type === 'execution-denied') return true
  if (part.output.type === 'text') return FAILURE_PATTERN.test(part.output.value)
  return false
}

function takeWithinTokenBudget(
  characters: string[],
  maxTokens: number,
  fromEnd: boolean,
  options: ContextDefenseOptions,
) {
  if (maxTokens <= 0) return ''
  let used = 0
  const selected: string[] = []
  const start = fromEnd ? characters.length - 1 : 0
  const end = fromEnd ? -1 : characters.length
  const step = fromEnd ? -1 : 1

  for (let index = start; index !== end; index += step) {
    const character = characters[index]
    const cost = WIDE_CHAR.test(character)
      ? options.wideTokensPerChar
      : 1 / options.asciiCharsPerToken
    if (used + cost > maxTokens) break
    used += cost
    selected.push(character)
  }

  if (fromEnd) selected.reverse()
  return selected.join('')
}

function truncateText(
  text: string,
  maxTokens: number,
  options: ContextDefenseOptions,
) {
  const originalTokens = estimateTextTokensResolved(text, options)
  if (originalTokens <= maxTokens) return text

  const provisionalMarker = `\n\n[truncated: ${text.length} chars; middle omitted]\n\n`
  const contentBudget = Math.max(0, maxTokens - estimateTextTokensResolved(provisionalMarker, options))
  const characters = Array.from(text)
  let head = takeWithinTokenBudget(characters, contentBudget * 0.6, false, options)
  let tail = takeWithinTokenBudget(characters, contentBudget * 0.4, true, options)
  let marker = `\n\n[truncated: ${text.length} -> ${head.length + tail.length} chars]\n\n`
  let result = `${head}${marker}${tail}`

  // 数字位数变化可能让最终标记略超预算；从中间边缘收缩直至满足约束。
  while (estimateTextTokensResolved(result, options) > maxTokens && (head || tail)) {
    if (head.length >= tail.length && head) head = head.slice(0, -1)
    else tail = tail.slice(1)
    marker = `\n\n[truncated: ${text.length} -> ${head.length + tail.length} chars]\n\n`
    result = `${head}${marker}${tail}`
  }
  return result
}

function replaceTextOutput(part: ToolResultPart, value: string): ToolResultPart {
  if (part.output.type !== 'text') return part
  return { ...part, output: { ...part.output, value } }
}

export function truncateToolResults(
  messages: ModelMessage[],
  options: Partial<ContextDefenseOptions> = {},
  initialTokenEstimate?: number,
) {
  const resolved = resolveDefenseOptions(options)
  const maxSingleTokens = Math.floor(
    resolved.contextWindowTokens * resolved.maxSingleToolResultRatio,
  )
  const contextBudgetTokens = Math.floor(
    resolved.contextWindowTokens * resolved.contextBudgetRatio,
  )
  const heuristicBefore = estimateTokens(messages, resolved)
  let estimatedTokens = initialTokenEstimate ?? heuristicBefore
  let truncated = 0

  let result = messages.map((message) => {
    if (message.role !== 'tool') return message
    let changed = false
    const content = message.content.map((part) => {
      if (
        part.type !== 'tool-result' ||
        part.output.type !== 'text' ||
        isAnyDefenseMarker(part.output.value)
      ) {
        return part
      }
      const value = truncateText(part.output.value, maxSingleTokens, resolved)
      if (value === part.output.value) return part
      estimatedTokens -= estimateTextTokensResolved(part.output.value, resolved) -
        estimateTextTokensResolved(value, resolved)
      changed = true
      truncated++
      return replaceTextOutput(part, value)
    })
    return changed ? { ...message, content } : message
  })

  let compacted = 0
  if (estimatedTokens > contextBudgetTokens) {
    result = result.map((message) => {
      if (message.role !== 'tool' || estimatedTokens <= contextBudgetTokens) return message
      let changed = false
      const content = message.content.map((part) => {
        if (
          estimatedTokens <= contextBudgetTokens ||
          part.type !== 'tool-result' ||
          part.output.type !== 'text' ||
          isFinalDefenseMarker(part.output.value) ||
          isFailureToolResult(part)
        ) {
          return part
        }
        const value = `[tool result compacted: ${part.toolName}]`
        estimatedTokens -= estimateTextTokensResolved(part.output.value, resolved) -
          estimateTextTokensResolved(value, resolved)
        changed = true
        compacted++
        return replaceTextOutput(part, value)
      })
      return changed ? { ...message, content } : message
    })
  }

  return {
    messages: result,
    truncated,
    compacted,
    beforeTokens: initialTokenEstimate ?? heuristicBefore,
    afterTokens: Math.max(0, Math.ceil(estimatedTokens)),
  }
}

function softPruneText(text: string, toolName: string, maxRetainChars: number) {
  const marker = `\n\n[soft pruned: ${toolName}; middle omitted]\n\n`
  // 对短输出也至少回收约一半；长输出的每侧保留量不超过配置上限。
  const retainPerSide = Math.max(
    1,
    Math.min(maxRetainChars, Math.floor(Math.max(0, text.length - marker.length) / 4)),
  )
  if (text.length <= retainPerSide * 2 + marker.length) return text
  return `${text.slice(0, retainPerSide)}${marker}${text.slice(-retainPerSide)}`
}

function normalizeTimestamps(messages: ModelMessage[], timestamps: readonly number[], now: number) {
  return messages.map((_, index) => {
    const timestamp = timestamps[index]
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : now
  })
}

export function ttlPrune(
  messages: ModelMessage[],
  messageTimestamps: readonly number[] = [],
  options: Partial<ContextDefenseOptions> = {},
  now = Date.now(),
) {
  const resolved = resolveDefenseOptions(options)
  const timestamps = normalizeTimestamps(messages, messageTimestamps, now)
  let estimatedTokens = estimateTokens(messages, resolved)
  let softPruned = 0
  let hardPruned = 0

  const result = messages.map((message, index) => {
    if (message.role !== 'tool') return message
    const age = Math.max(0, now - timestamps[index])
    if (age < resolved.softTTLMs) return message

    let changed = false
    const content = message.content.map((part) => {
      const hardExpired = age >= resolved.hardTTLMs
      if (
        part.type !== 'tool-result' ||
        part.output.type !== 'text' ||
        shouldSkipTTLMarker(part.output.value, hardExpired) ||
        isFailureToolResult(part)
      ) {
        return part
      }

      const value = hardExpired
        ? `[tool result expired: ${part.toolName}]`
        : softPruneText(part.output.value, part.toolName, resolved.softRetainChars)
      if (value === part.output.value) return part

      estimatedTokens -= estimateTextTokensResolved(part.output.value, resolved) -
        estimateTextTokensResolved(value, resolved)
      changed = true
      if (hardExpired) hardPruned++
      else softPruned++
      return replaceTextOutput(part, value)
    })

    return changed ? { ...message, content } : message
  })

  return {
    messages: result,
    messageTimestamps: timestamps,
    softPruned,
    hardPruned,
    beforeTokens: estimateTokens(messages, resolved),
    afterTokens: Math.max(0, Math.ceil(estimatedTokens)),
  }
}

/** 按动态截断 -> TTL 修剪 -> Token 估算的顺序执行零 LLM 成本防线。 */
export function applyContextDefense(
  messages: ModelMessage[],
  messageTimestamps: readonly number[] = [],
  options: Partial<ContextDefenseOptions> = {},
  runtime: { now?: number; estimatedTokens?: number } = {},
): ContextDefenseResult {
  const resolved = resolveDefenseOptions(options)
  const beforeTokens = runtime.estimatedTokens ?? estimateTokens(messages, resolved)
  const truncated = truncateToolResults(messages, resolved, beforeTokens)
  const ttl = ttlPrune(
    truncated.messages,
    messageTimestamps,
    resolved,
    runtime.now ?? Date.now(),
  )
  const ttlHeuristicSavings = ttl.beforeTokens - ttl.afterTokens

  return {
    messages: ttl.messages,
    messageTimestamps: ttl.messageTimestamps,
    truncated: truncated.truncated,
    compacted: truncated.compacted,
    softPruned: ttl.softPruned,
    hardPruned: ttl.hardPruned,
    beforeTokens,
    afterTokens: Math.max(0, truncated.afterTokens - ttlHeuristicSavings),
  }
}
