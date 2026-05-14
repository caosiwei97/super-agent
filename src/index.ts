import 'dotenv/config'
import { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createInterface } from 'node:readline'
import { calculatorTool, weatherTool } from './tools'
import { agentLoop, BudgetState } from './agent-loop'

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`

const tools = { get_weather: weatherTool, calculator: calculatorTool }

const glmClient = createOpenAI({
  baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
  apiKey: process.env.GLM_API_KEY,
})

// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 15000 }

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

    await agentLoop(glmClient.chat('glm-5.1'), tools, messages, SYSTEM, budget)

    ask()
  })
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n')
console.log('试试输入："测试死循环"、"测试重试"、"测试预算" 看三层防护效果\n')

ask()
