import type { ModelMessage } from 'ai'

/**
 * 会话消息存储。
 *
 * 当前是最小封装：只把 messages 数组及其增删查收口到一个对象，
 * 为将来加持久化（写文件 / DB）留出替换点。
 *
 * 现阶段 agent-loop 仍直接持有 messages 数组做 push，
 * 这里先不强制接线，避免引入引用同步问题；后续逐步收口。
 */
export class SessionStore {
  private messages: ModelMessage[] = []

  add(message: ModelMessage): void {
    this.messages.push(message)
  }

  addMany(messages: ModelMessage[]): void {
    this.messages.push(...messages)
  }

  getAll(): ModelMessage[] {
    return this.messages
  }

  clear(): void {
    this.messages = []
  }
}
