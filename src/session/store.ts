import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { modelMessageSchema, type ModelMessage } from 'ai'

const DEFAULT_SESSION_DIR = '.sessions'
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

interface EntryBase {
  timestamp: string
}

/** Current atomic event: step messages and their cumulative budget share one JSONL record. */
export interface MessagesEntry extends EntryBase {
  type: 'messages'
  messages: ModelMessage[]
  budgetUsed?: number
}

/** Legacy entries remain readable so existing sessions can be resumed. */
export interface MessageEntry extends EntryBase {
  type: 'message'
  message: ModelMessage
}

export interface BudgetEntry extends EntryBase {
  type: 'budget'
  budgetUsed: number
}

export interface CheckpointEntry extends EntryBase {
  type: 'checkpoint'
  messages: ModelMessage[]
  summary: string
  budgetUsed: number
}

export type SessionEntry = MessagesEntry | MessageEntry | BudgetEntry | CheckpointEntry

export interface SessionState {
  messages: ModelMessage[]
  summary: string
  budgetUsed: number
}

export interface SessionWriter {
  getSessionId(): string
  appendMessages(messages: ModelMessage[], budgetUsed?: number): Promise<void>
  appendCheckpoint(state: SessionState): Promise<void>
}

export interface SessionStoreOptions {
  directory?: string
  onWarning?: (message: string) => void
}

export function createSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${timestamp}_${randomUUID().slice(0, 8)}`
}

function validateSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`非法 session ID: ${sessionId}`)
  }
}

function emptyState() {
  const messages: ModelMessage[] = []
  return { messages, summary: '', budgetUsed: 0 }
}

function assertBudget(budgetUsed: number) {
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

/**
 * Append-only session log with recoverable checkpoints.
 *
 * Message events preserve the raw audit trail. Checkpoints only replace the
 * in-memory recovery state, so startup memory stays bounded by compacted context
 * rather than by the full transcript.
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

  async appendMessages(messages: ModelMessage[], budgetUsed?: number) {
    if (messages.length === 0) return
    assertMessages(messages)
    if (budgetUsed !== undefined) assertBudget(budgetUsed)

    await this.appendEntries([
      {
        type: 'messages',
        timestamp: new Date().toISOString(),
        messages,
        ...(budgetUsed === undefined ? {} : { budgetUsed }),
      },
    ])
  }

  async appendCheckpoint(state: SessionState) {
    assertMessages(state.messages)
    assertBudget(state.budgetUsed)
    await this.appendEntries([
      {
        type: 'checkpoint',
        timestamp: new Date().toISOString(),
        messages: state.messages,
        summary: state.summary,
        budgetUsed: state.budgetUsed,
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
          const parsedMessages = entry.messages.map((message) => modelMessageSchema.safeParse(message))
          if (parsedMessages.some((parsed) => !parsed.success)) {
            throw new Error('messages 包含无效消息')
          }
          if (entry.budgetUsed !== undefined) {
            if (typeof entry.budgetUsed !== 'number') {
              throw new Error('messages.budgetUsed 无效')
            }
            assertBudget(entry.budgetUsed)
            state.budgetUsed = entry.budgetUsed
          }
          state.messages.push(...parsedMessages.map((parsed) => parsed.data!))
          continue
        }

        if (entry.type === 'message') {
          const parsed = modelMessageSchema.safeParse(entry.message)
          if (!parsed.success) throw new Error('message 结构无效')
          state.messages.push(parsed.data)
          continue
        }

        if (entry.type === 'budget') {
          if (typeof entry.budgetUsed !== 'number') throw new Error('budget.budgetUsed 无效')
          assertBudget(entry.budgetUsed)
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
          assertBudget(entry.budgetUsed)

          state = {
            messages: parsedMessages.map((parsed) => parsed.data!),
            summary: entry.summary,
            budgetUsed: entry.budgetUsed,
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
