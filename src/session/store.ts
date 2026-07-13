import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'

const SESSION_DIR = '.sessions'
const DEFAULT_SESSION = 'default'

export interface SessionEntry {
  type: 'message'
  timestamp: string
  message: ModelMessage
}

export class SessionStore {
  private dir: string
  private sessionId: string

  constructor(sessionId: string = DEFAULT_SESSION) {
    this.sessionId = sessionId
    this.dir = SESSION_DIR
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`)
  }

  getSessionId() {
    return this.sessionId
  }

  async append(message: ModelMessage): Promise<void> {
    const entry: SessionEntry = {
      type: 'message',
      timestamp: new Date().toISOString(),
      message,
    }
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err) {
      console.error(`[Session] 写入失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  async appendAll(messages: ModelMessage[]): Promise<void> {
    if (messages.length === 0) return
    // 拼成一个大字符串一次写入，避免逐条 open/write/close 的系统调用开销
    const batch = messages
      .map((message) => {
        const entry: SessionEntry = {
          type: 'message',
          timestamp: new Date().toISOString(),
          message,
        }
        return JSON.stringify(entry)
      })
      .join('\n') + '\n'

    try {
      await appendFile(this.filePath, batch, 'utf-8')
    } catch (err) {
      console.error(`[Session] 批量写入失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) return []

    const content = readFileSync(this.filePath, 'utf-8').trim()
    if (!content) return []

    const messages: ModelMessage[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry: SessionEntry = JSON.parse(line)
        if (entry.type === 'message') {
          messages.push(entry.message)
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages
  }

  exists(): boolean {
    return existsSync(this.filePath)
  }

  getMessageCount(): number {
    if (!existsSync(this.filePath)) return 0
    // 只数行数，不解析 JSON，避免全量解析只为计数
    const content = readFileSync(this.filePath, 'utf-8').trim()
    if (!content) return 0
    return content.split('\n').length
  }
}
