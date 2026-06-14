import 'dotenv/config'
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createInterface } from 'node:readline'
import { allTools } from './tools'
import { agentLoop, BudgetState } from './agent-loop'
import { ToolRegistry } from './tool-registry'

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`

const registry = new ToolRegistry()
registry.register(...allTools)

console.log(`已注册 ${registry.getAll().length} 个工具：`)

for (const tool of registry.getAll()) {
  const flags = [tool.isConcurrencySafe ? '可并发' : '串行', tool.isReadOnly ? '只读' : '读写'].join(', ')
  console.log(`  - ${tool.name}（${flags}）`)
}

const client = createOpenAI({
  baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
  apiKey: process.env.GLM_API_KEY,
})

// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 200000 }

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const messages: ModelMessage[] = []

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({ role: 'user', content: trimmed })

    await agentLoop(client.chat('glm-5.1'), registry, messages, SYSTEM, budget)

    ask()
  })
}

ask()
