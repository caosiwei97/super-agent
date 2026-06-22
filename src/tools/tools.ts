import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import type { ToolDefinition } from '../core/tool-registry.js'
import { execSync } from 'node:child_process'
import fg from 'fast-glob'
import { createServer, Server } from 'node:http'

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的天气信息',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如"北京"、"上海"' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: '晴，15-25°C，东南风 2 级',
      上海: '多云，18-22°C，西南风 3 级',
      深圳: '阵雨，22-28°C，南风 2 级',
      广州: '多云转晴，20-28°C，东风 3 级',
      杭州: '晴，14-24°C，北风 2 级',
      成都: '阴，16-22°C，微风',
    }
    return data[city] || `${city}：暂无数据`
  },
}

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)()
      return `${expression} = ${result}`
    } catch {
      return `无法计算: ${expression}`
    }
  },
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取指定路径的文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500,
  execute: async ({ path }: { path: string }) => {
    const resolved = resolve(path)
    return readFileSync(resolved, 'utf-8')
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件。如果文件已存在则覆盖',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    const resolved = resolve(path)
    writeFileSync(resolved, content, 'utf-8')
    return `已写入 ${content.length} 字符到 ${path}`
  },
}

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为当前目录' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = '.' }: { path?: string }) => {
    const resolved = resolve(path)
    const entries = readdirSync(resolved)
    return entries
      .map((name) => {
        try {
          const stat = statSync(join(resolved, name))
          return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`
        } catch {
          return `[?] ${name}`
        }
      })
      .join('\n')
  },
}
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
    const resolved = resolve(path)
    if (!existsSync(resolved)) return `文件不存在: ${path}`

    const content = readFileSync(resolved, 'utf-8')
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`
    }

    const updated = content.replace(old_string, new_string)
    writeFileSync(resolved, updated, 'utf-8')
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
  },
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ['node_modules/**', '.git/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`
    return results.sort().join('\n')
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const baseDir = resolve(path)
    const regex = new RegExp(pattern, 'i')
    const matches: string[] = []
    const SKIP = new Set(['node_modules', '.git', 'dist'])
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock'])

    function searchFile(filePath: string) {
      if (matches.length >= 50) return
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      if (BIN_EXT.has(ext)) return

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch {
        return
      }

      const lines = content.split('\n')
      const rel = relative(baseDir, filePath)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`)
          if (matches.length >= 50) return
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue
        const full = join(dir, name)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) walk(full)
          else searchFile(full)
        } catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir)
    if (stat.isFile()) {
      searchFile(baseDir)
    } else {
      walk(baseDir)
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : ''
    return matches.join('\n') + suffix
  },
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    try {
      execSync('echo test', { stdio: 'ignore' })
    } catch {
      return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return output || '(命令执行成功，无输出)'
    } catch (err: any) {
      const stderr = err.stderr || ''
      const stdout = err.stdout || ''
      return `命令执行失败 (exit ${err.status || 1}):\n${stderr || stdout || err.message}`
    }
  },
}

const MOCK_PAGES: Record<string, string> = {
  'https://esm.sh': `esm.sh - 一个免费的 ES module CDN。直接 import "https://esm.sh/react@18" 就能用最新版 React，自动处理依赖打包、TypeScript 支持和 JSX 转换，配合浏览器 import maps 可以零构建运行 React 项目。`,

  'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling': `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数

通过 stopWhen: stepCountIs(N) 实现多步工具执行。
当模型在一个 step 中发出多个 tool-call 时，工具会默认并行执行。`,

  'https://ai-sdk.dev/docs/ai-sdk-core/generating-text': `AI SDK Core - Generating Text
streamText() 返回流式响应，包含文本和工具调用的增量更新。
通过 fullStream 可以拿到所有事件类型：text-delta、tool-call、tool-result、finish。
generateText() 是非流式版本，最终返回完整结果。`,
}

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）。让 Agent 阅读外部资料、文档、博客',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 1500,
  execute: async ({ url }: { url: string }) => {
    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key]
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return `请求失败：HTTP ${res.status}`
      const html = await res.text()
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || '页面无文本内容'
      )
    } catch (err: any) {
      return `抓取失败：${err.message}`
    }
  },
}
let previewServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器，让浏览器能访问生成的网页应用。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'number', description: '端口号，默认 8080' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    const root = resolve('app')
    if (!existsSync(root)) return '错误：app/ 目录不存在，请先用 write_file 生成应用文件'

    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html')
      const filePath = join(root, urlPath === '/' ? '/index.html' : urlPath)
      try {
        if (!filePath.startsWith(root)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        const content = readFileSync(filePath)
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(content)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })

    return new Promise<string>((resolve, reject) => {
      previewServer!.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') resolve(`端口 ${port} 已被占用，预览可能已经在跑了`)
        else reject(err)
      })
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}（点击 WebContainer 的 Preview 标签查看）`)
      })
    })
  },
}

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
]
