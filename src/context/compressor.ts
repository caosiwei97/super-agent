import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolResultPart,
} from 'ai'
import {
  applyContextDefense,
  DEFAULT_CONTEXT_DEFENSE_OPTIONS,
  estimateTokens,
  isFailureToolResult,
  resolveDefenseOptions,
  type ContextDefenseOptions,
} from './defense.js'

export { estimateTokens } from './defense.js'

const CLEARED_TOOL_RESULT = '[tool result cleared]'

export interface CompactionOptions extends Partial<Omit<ContextDefenseOptions, 'asciiCharsPerToken'>> {
  tokenThreshold: number
  keepRecentMessages: number
  keepRecentToolMessages: number
  asciiCharsPerToken: number
  maxSummaryChars: number
}

export const DEFAULT_COMPACTION_OPTIONS: CompactionOptions & ContextDefenseOptions = {
  ...DEFAULT_CONTEXT_DEFENSE_OPTIONS,
  tokenThreshold: 12_000,
  keepRecentMessages: 8,
  keepRecentToolMessages: 4,
  maxSummaryChars: 1_200,
}

function resolveOptions(options: Partial<CompactionOptions>) {
  const resolved = {
    ...DEFAULT_COMPACTION_OPTIONS,
    ...resolveDefenseOptions(options),
    ...options,
  }
  // tokenThreshold 未显式指定时，按窗口水位推导，与 defense 的
  // contextBudgetTokens（contextWindowTokens × contextBudgetRatio）保持一致，
  // 让三层压缩按模型实际上下文窗口判断，而非写死 12k。
  if (options.tokenThreshold === undefined) {
    resolved.tokenThreshold = Math.floor(
      resolved.contextWindowTokens * resolved.contextBudgetRatio,
    )
  }
  const positiveIntegers: Array<keyof CompactionOptions> = [
    'tokenThreshold',
    'keepRecentMessages',
    'maxSummaryChars',
  ]
  for (const key of positiveIntegers) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`CompactionOptions.${key} 必须是正整数`)
    }
  }
  if (!Number.isSafeInteger(resolved.keepRecentToolMessages) || resolved.keepRecentToolMessages < 0) {
    throw new Error('CompactionOptions.keepRecentToolMessages 必须是非负整数')
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

// ── 即时防线后的兜底微压缩 ───────────────────────────

const CLEARABLE_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'list_directory',
  'fetch_url',
])
function isClearedToolResult(part: ToolResultPart) {
  return part.output.type === 'text' && part.output.value === CLEARED_TOOL_RESULT
}

export function microcompact(
  messages: ModelMessage[],
  options: Partial<CompactionOptions> = {},
) {
  const { keepRecentToolMessages } = resolveOptions(options)
  const toolMessageIndices: number[] = []

  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'tool') toolMessageIndices.push(index)
  }

  const clearableMessageIndices = new Set(
    toolMessageIndices.slice(0, Math.max(0, toolMessageIndices.length - keepRecentToolMessages)),
  )
  let cleared = 0

  const compactedMessages = messages.map((message, index) => {
    if (!clearableMessageIndices.has(index) || message.role !== 'tool') return message

    return {
      ...message,
      content: message.content.map((part) => {
        if (
          part.type !== 'tool-result' ||
          !CLEARABLE_TOOLS.has(part.toolName) ||
          isClearedToolResult(part) ||
          isFailureToolResult(part)
        ) {
          return part
        }

        cleared++
        return {
          ...part,
          // AI SDK v6 要求使用结构化的 ToolResultOutput。这里若使用原始字符串，
          // 即使能通过 `any` 类型检查，编码下一次模型请求时仍会失败。
          output: { type: 'text' as const, value: CLEARED_TOOL_RESULT },
        }
      }),
    } satisfies ModelMessage
  })

  return { messages: compactedMessages, cleared }
}

// ── 第二层：模型摘要 ─────────────────────────────────

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 遵守末尾给出的摘要长度限制`

const SUMMARY_HEADER = '[以下是之前对话的压缩摘要]'
const SUMMARY_FOOTER = '[摘要结束，以下是最近的对话]'

export interface CompactionResult {
  messages: ModelMessage[]
  summary: string
  compressedCount: number
  usageTokens: number
  error?: string
}

export interface ContextCompactionResult extends CompactionResult {
  messageTimestamps: number[]
  truncated: number
  compacted: number
  softPruned: number
  hardPruned: number
  cleared: number
  beforeTokens: number
  afterTokens: number
}

export interface CompactionRuntimePolicy {
  allowSummary?: boolean
  estimatedTokens?: number
  now?: number
}

function stripEmbeddedSummary(messages: ModelMessage[], existingSummary: string) {
  if (!existingSummary) return messages

  const first = messages[0]
  const expectedContent = `${SUMMARY_HEADER}\n\n${existingSummary}\n\n${SUMMARY_FOOTER}`
  if (
    (first?.role !== 'assistant' && first?.role !== 'user') ||
    first.content !== expectedContent
  ) {
    return messages
  }

  return messages.slice(1)
}

function messageToText(message: ModelMessage) {
  if (typeof message.content === 'string') return message.content

  return message.content
    .map((part) => {
      if ('text' in part && typeof part.text === 'string') return part.text
      if (part.type === 'tool-call') {
        return `[tool-call ${part.toolName}] ${stringify(part.input)}`
      }
      if (part.type === 'tool-result') {
        return `[tool-result ${part.toolName}] ${stringify(part.output)}`
      }
      return stringify(part)
    })
    .filter(Boolean)
    .join('\n')
}

function usageTokenCount(usage: {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
}) {
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  existingSummary = '',
  options: Partial<CompactionOptions> = {},
) {
  const resolvedOptions = resolveOptions(options)
  // 上一次摘要会作为合成消息注入智能体上下文。生成新摘要前先移除该消息，
  // 否则每次压缩都会把同一份摘要重复发送两次。
  const previousSummary = existingSummary
  const conversationMessages = stripEmbeddedSummary(messages, previousSummary)

  if (
    estimateTokens(messages, resolvedOptions) < resolvedOptions.tokenThreshold ||
    conversationMessages.length <= resolvedOptions.keepRecentMessages
  ) {
    return {
      messages,
      summary: previousSummary,
      compressedCount: 0,
      usageTokens: 0,
    }
  }

  const splitIndex = Math.max(0, conversationMessages.length - resolvedOptions.keepRecentMessages)

  // 保留完整的用户轮次，避免助手的工具调用与触发它的用户请求分离。
  let alignedIndex = splitIndex
  while (alignedIndex > 0 && conversationMessages[alignedIndex].role !== 'user') {
    alignedIndex--
  }
  if (alignedIndex === 0) {
    return {
      messages,
      summary: previousSummary,
      compressedCount: 0,
      usageTokens: 0,
    }
  }

  const toCompress = conversationMessages.slice(0, alignedIndex)
  const toKeep = conversationMessages.slice(alignedIndex)
  const conversationText = toCompress
    .map((message) => {
      const content = messageToText(message)
      return content ? `**${message.role}**: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  if (!conversationText.trim()) {
    return {
      messages,
      summary: previousSummary,
      compressedCount: 0,
      usageTokens: 0,
    }
  }

  const prompt = previousSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${previousSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText

  try {
    const result = await generateText({
      model,
      system: `${COMPRESS_PROMPT}\n- 总长度不得超过 ${resolvedOptions.maxSummaryChars} 字符`,
      prompt,
      temperature: 0,
      maxOutputTokens: resolvedOptions.maxSummaryChars,
    })
    const summary = result.text.trim()

    if (!summary || summary.length > resolvedOptions.maxSummaryChars) {
      return {
        messages,
        summary: previousSummary,
        compressedCount: 0,
        usageTokens: usageTokenCount(result.usage),
      }
    }

    const summaryMessage: ModelMessage = {
      role: 'assistant',
      content: `${SUMMARY_HEADER}\n\n${summary}\n\n${SUMMARY_FOOTER}`,
    }
    const compactedMessages: ModelMessage[] = [summaryMessage, ...toKeep]

    // 模型可能忽略摘要长度要求。若摘要后的表示并未真正变小，
    // 就不能用它替换工作上下文。
    if (
      estimateTokens(compactedMessages, resolvedOptions) >=
      estimateTokens(messages, resolvedOptions)
    ) {
      return {
        messages,
        summary: previousSummary,
        compressedCount: 0,
        usageTokens: usageTokenCount(result.usage),
      }
    }

    return {
      messages: compactedMessages,
      summary,
      compressedCount: toCompress.length,
      usageTokens: usageTokenCount(result.usage),
    }
  } catch (error) {
    return {
      messages,
      summary: previousSummary,
      compressedCount: 0,
      usageTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function remapTimestamps(
  sourceMessages: ModelMessage[],
  sourceTimestamps: readonly number[],
  targetMessages: ModelMessage[],
  now: number,
) {
  const timestampsByMessage = new Map<ModelMessage, number>()
  sourceMessages.forEach((message, index) => {
    timestampsByMessage.set(message, sourceTimestamps[index] ?? now)
  })
  return targetMessages.map((message) => timestampsByMessage.get(message) ?? now)
}

/** 依次运行即时防线、微压缩和摘要，并返回完整的生命周期元数据。 */
export async function compactContext(
  model: LanguageModel,
  messages: ModelMessage[],
  existingSummary = '',
  options: Partial<CompactionOptions> = {},
  policy: CompactionRuntimePolicy = {},
  messageTimestamps: readonly number[] = [],
) {
  const resolvedOptions = resolveOptions(options)
  const now = policy.now ?? Date.now()
  const defenseResult = applyContextDefense(
    messages,
    messageTimestamps,
    resolvedOptions,
    { now, estimatedTokens: policy.estimatedTokens },
  )
  const shouldCompact = defenseResult.afterTokens >= resolvedOptions.tokenThreshold
  const microcompactResult = shouldCompact
    ? microcompact(defenseResult.messages, resolvedOptions)
    : { messages: defenseResult.messages, cleared: 0 }
  const microcompactSavings = estimateTokens(defenseResult.messages, resolvedOptions) -
    estimateTokens(microcompactResult.messages, resolvedOptions)
  const afterMicrocompactTokens = Math.max(0, defenseResult.afterTokens - microcompactSavings)
  const summaryResult = policy.allowSummary === false ||
    afterMicrocompactTokens < resolvedOptions.tokenThreshold
    ? {
        messages: microcompactResult.messages,
        summary: existingSummary,
        compressedCount: 0,
        usageTokens: 0,
      }
    : await summarize(
        model,
        microcompactResult.messages,
        existingSummary,
        resolvedOptions,
      )

  const summarySavings = estimateTokens(microcompactResult.messages, resolvedOptions) -
    estimateTokens(summaryResult.messages, resolvedOptions)
  const timestampsAfterSummary = remapTimestamps(
    microcompactResult.messages,
    defenseResult.messageTimestamps,
    summaryResult.messages,
    now,
  )

  return {
    ...summaryResult,
    messageTimestamps: timestampsAfterSummary,
    truncated: defenseResult.truncated,
    compacted: defenseResult.compacted,
    softPruned: defenseResult.softPruned,
    hardPruned: defenseResult.hardPruned,
    cleared: microcompactResult.cleared,
    beforeTokens: defenseResult.beforeTokens,
    afterTokens: Math.max(0, afterMicrocompactTokens - summarySavings),
  }
}
