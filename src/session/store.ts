import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { modelMessageSchema, type ModelMessage } from 'ai'
import { isStepRecord, type StepRecord } from '../usage/tracker.js'

const DEFAULT_SESSION_DIR = '.sessions'
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

interface EntryBase {
  timestamp: string
}

// 注意：磁盘 JSONL 字段 budgetUsed 与判别符 type:'budget' 是历史字段名，
// 保留原名以兼容已有 .sessions/*.jsonl；仅内部 TS 标识已从 budget 重命名为 cost。

/** 当前的原子事件：步骤消息及其累计成本预算共用一条 JSONL 记录。 */
export interface MessagesEntry extends EntryBase {
  type: 'messages'
  messages: ModelMessage[]
  budgetUsed?: number
  usage?: StepRecord
}

/** 保留对旧格式记录的读取支持，以便恢复已有会话。 */
export interface MessageEntry extends EntryBase {
  type: 'message'
  message: ModelMessage
}

/** 历史独立成本事件；磁盘判别符仍为 'budget' 以兼容旧文件。 */
export interface CostEntry extends EntryBase {
  type: 'budget'
  budgetUsed: number
}

export interface CheckpointEntry extends EntryBase {
  type: 'checkpoint'
  messages: ModelMessage[]
  /** 与 messages 按索引对齐；旧 checkpoint 可能没有该字段。 */
  messageTimestamps?: number[]
  summary: string
  budgetUsed: number
  usageRecords?: StepRecord[]
}

export type SessionEntry = MessagesEntry | MessageEntry | CostEntry | CheckpointEntry

export interface SessionState {
  messages: ModelMessage[]
  messageTimestamps: number[]
  summary: string
  budgetUsed: number
  usageRecords: StepRecord[]
}

export type SessionCheckpointState = Omit<SessionState, 'messageTimestamps' | 'usageRecords'> & {
  messageTimestamps?: number[]
  usageRecords?: StepRecord[]
}

export interface SessionWriter {
  getSessionId(): string
  appendMessages(
    messages: ModelMessage[],
    budgetUsed?: number,
    usage?: StepRecord,
  ): Promise<void>
  appendCheckpoint(state: SessionCheckpointState): Promise<void>
}

export interface SessionStoreOptions {
  directory?: string
  onWarning?: (message: string) => void
}

function validateSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`非法 session ID: ${sessionId}`)
  }
}

function emptyState() {
  const messages: ModelMessage[] = []
  const messageTimestamps: number[] = []
  const usageRecords: StepRecord[] = []
  return { messages, messageTimestamps, summary: '', budgetUsed: 0, usageRecords }
}

function assertCostUsed(budgetUsed: number) {
  if (!Number.isFinite(budgetUsed) || budgetUsed < 0) {
    throw new Error(`非法 budgetUsed: ${budgetUsed}`)
  }
}

function assertMessages(messages: ModelMessage[]) {
  for (const message of messages) {
    if (!modelMessageSchema.safeParse(message).success) {
      throw new Error('拒绝写入结构无效的 ModelMessage')
    }
  }
}

function assertUsageRecords(records: readonly StepRecord[]) {
  if (!records.every(isStepRecord)) throw new Error('usageRecords 包含无效记录')
}

function assertMessageTimestamps(messages: ModelMessage[], timestamps: number[]) {
  if (
    timestamps.length !== messages.length ||
    timestamps.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0)
  ) {
    throw new Error('messageTimestamps 必须与 messages 等长且包含有效时间戳')
  }
}

function parseEntryTimestamp(timestamp: unknown) {
  if (typeof timestamp !== 'string') throw new Error('timestamp 无效')
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) throw new Error('timestamp 无效')
  return parsed
}

/**
 * 只追加写入的会话日志，并通过检查点实现恢复。
 *
 * 消息事件保留原始审计记录。检查点只替换内存中的恢复状态，
 * 因此启动时的内存占用由压缩后的上下文决定，而不是由完整对话记录决定。
 */
export class SessionStore implements SessionWriter {
  private readonly filePath: string
  private readonly onWarning: (message: string) => void

  constructor(
    private readonly sessionId: string,
    options: SessionStoreOptions = {},
  ) {
    validateSessionId(sessionId)
    const directory = resolve(options.directory || DEFAULT_SESSION_DIR)
    mkdirSync(directory, { recursive: true })
    this.filePath = resolve(directory, `${sessionId}.jsonl`)
    this.onWarning = options.onWarning || ((message) => console.warn(message))
  }

  getSessionId() {
    return this.sessionId
  }

  exists() {
    return existsSync(this.filePath)
  }

  async appendMessages(messages: ModelMessage[], budgetUsed?: number, usage?: StepRecord) {
    if (messages.length === 0) return
    assertMessages(messages)
    if (budgetUsed !== undefined) assertCostUsed(budgetUsed)
    if (usage !== undefined) assertUsageRecords([usage])

    await this.appendEntries([
      {
        type: 'messages',
        timestamp: new Date().toISOString(),
        messages,
        ...(budgetUsed === undefined ? {} : { budgetUsed }),
        ...(usage === undefined ? {} : { usage }),
      },
    ])
  }

  async appendCheckpoint(state: SessionCheckpointState) {
    assertMessages(state.messages)
    assertCostUsed(state.budgetUsed)
    const timestamp = new Date().toISOString()
    const messageTimestamps = state.messageTimestamps ??
      state.messages.map(() => Date.parse(timestamp))
    const usageRecords = state.usageRecords ?? []
    assertMessageTimestamps(state.messages, messageTimestamps)
    assertUsageRecords(usageRecords)
    await this.appendEntries([
      {
        type: 'checkpoint',
        timestamp,
        messages: state.messages,
        messageTimestamps,
        summary: state.summary,
        budgetUsed: state.budgetUsed,
        usageRecords,
      },
    ])
  }

  async loadState() {
    if (!this.exists()) return emptyState()

    let state = emptyState()
    const lines = createInterface({
      input: createReadStream(this.filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    let lineNumber = 0

    for await (const line of lines) {
      lineNumber++
      if (!line.trim()) continue

      try {
        const entry = JSON.parse(line) as Partial<SessionEntry>
        if (entry.type === 'messages') {
          if (!Array.isArray(entry.messages)) throw new Error('messages.messages 不是数组')
          const timestamp = parseEntryTimestamp(entry.timestamp)
          const parsedMessages = entry.messages.map((message) => modelMessageSchema.safeParse(message))
          if (parsedMessages.some((parsed) => !parsed.success)) {
            throw new Error('messages 包含无效消息')
          }
          if (entry.budgetUsed !== undefined) {
            if (typeof entry.budgetUsed !== 'number') {
              throw new Error('messages.budgetUsed 无效')
            }
            assertCostUsed(entry.budgetUsed)
          }
          if (entry.usage !== undefined && !isStepRecord(entry.usage)) {
            throw new Error('messages.usage 无效')
          }
          state.messages.push(...parsedMessages.map((parsed) => parsed.data!))
          state.messageTimestamps.push(...entry.messages.map(() => timestamp))
          if (entry.budgetUsed !== undefined) state.budgetUsed = entry.budgetUsed
          if (entry.usage !== undefined) state.usageRecords.push(entry.usage)
          continue
        }

        if (entry.type === 'message') {
          const parsed = modelMessageSchema.safeParse(entry.message)
          if (!parsed.success) throw new Error('message 结构无效')
          const timestamp = parseEntryTimestamp(entry.timestamp)
          state.messages.push(parsed.data)
          state.messageTimestamps.push(timestamp)
          continue
        }

        if (entry.type === 'budget') {
          if (typeof entry.budgetUsed !== 'number') throw new Error('budget.budgetUsed 无效')
          assertCostUsed(entry.budgetUsed)
          state.budgetUsed = entry.budgetUsed
          continue
        }

        if (entry.type === 'checkpoint') {
          if (!Array.isArray(entry.messages)) throw new Error('checkpoint.messages 不是数组')
          const parsedMessages = entry.messages.map((message) => modelMessageSchema.safeParse(message))
          if (parsedMessages.some((parsed) => !parsed.success)) {
            throw new Error('checkpoint 包含无效消息')
          }
          if (typeof entry.summary !== 'string') throw new Error('checkpoint.summary 无效')
          if (typeof entry.budgetUsed !== 'number') {
            throw new Error('checkpoint.budgetUsed 无效')
          }
          assertCostUsed(entry.budgetUsed)
          const usageRecords = entry.usageRecords ?? []
          if (!Array.isArray(usageRecords)) {
            throw new Error('checkpoint.usageRecords 无效')
          }
          assertUsageRecords(usageRecords)

          const checkpointTimestamp = parseEntryTimestamp(entry.timestamp)
          const messageTimestamps = entry.messageTimestamps === undefined
            ? entry.messages.map(() => checkpointTimestamp)
            : entry.messageTimestamps
          if (!Array.isArray(messageTimestamps)) {
            throw new Error('checkpoint.messageTimestamps 无效')
          }
          assertMessageTimestamps(
            parsedMessages.map((parsed) => parsed.data!),
            messageTimestamps,
          )

          state = {
            messages: parsedMessages.map((parsed) => parsed.data!),
            messageTimestamps,
            summary: entry.summary,
            budgetUsed: entry.budgetUsed,
            usageRecords,
          }
          continue
        }

        throw new Error('未知 entry type')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.onWarning(`[Session] 忽略第 ${lineNumber} 行损坏记录: ${reason}`)
      }
    }

    return state
  }

  private async appendEntries(entries: SessionEntry[]) {
    const payload = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    await appendFile(this.filePath, payload, 'utf-8')
  }
}
