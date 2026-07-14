#!/usr/bin/env node
import 'dotenv/config'
import { runCli } from '../cli/main.js'

runCli(process.argv.slice(2)).catch((error) => {
  console.error('启动失败:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
