import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import fg from 'fast-glob'
import type { ToolDefinition } from '../../core/tool-registry.js'
import type { Workspace } from '../../core/workspace.js'

const MAX_SEARCH_FILES = 2_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 50
const MAX_GLOB_RESULTS = 500
const MAX_DIRECTORY_ENTRIES = 500
const MAX_MATCH_LINE_CHARS = 500

export function createFileTools(workspace: Workspace) {
  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: '读取工作区内指定路径的 UTF-8 文件内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内的文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3_000,
    execute: async ({ path }: { path: string }) => {
      const resolved = workspace.resolveExisting(path)
      if ((await stat(resolved)).size > MAX_EDIT_FILE_BYTES) {
        return `文件超过 ${MAX_EDIT_FILE_BYTES} 字节读取限制`
      }
      return readFile(resolved, 'utf-8')
    },
  }

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: '写入工作区内的文件；文件存在时会覆盖，需要用户审批',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的文件路径' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresApproval: true,
    execute: async ({ path, content }: { path: string; content: string }) => {
      if (Buffer.byteLength(content, 'utf-8') > MAX_EDIT_FILE_BYTES) {
        return `写入内容超过 ${MAX_EDIT_FILE_BYTES} 字节限制`
      }
      await writeFile(workspace.resolveForWrite(path), content, 'utf-8')
      return `已写入 ${content.length} 字符到 ${path}`
    },
  }

  const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description: '列出工作区内指定目录的文件和子目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内目录，默认当前工作区' } },
      required: [],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ path = '.' }: { path?: string }) => {
      const directory = workspace.resolveExisting(path)
      const entries = await readdir(directory, { withFileTypes: true })
      const rendered = entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
        .join('\n')
      return entries.length > MAX_DIRECTORY_ENTRIES ? `${rendered}\n... (结果已截断)` : rendered
    },
  }

  const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description: '精确替换工作区文件中的唯一文本片段，需要用户审批',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的文件路径' },
        old_string: { type: 'string', description: '必须唯一匹配的原始文本' },
        new_string: { type: 'string', description: '替换后的文本' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresApproval: true,
    execute: async ({ path, old_string, new_string }: {
      path: string
      old_string: string
      new_string: string
    }) => {
      if (!old_string) return 'old_string 不能为空'
      const resolved = workspace.resolveExisting(path)
      if ((await stat(resolved)).size > MAX_EDIT_FILE_BYTES) {
        return `文件超过 ${MAX_EDIT_FILE_BYTES} 字节编辑限制`
      }
      const content = await readFile(resolved, 'utf-8')
      const count = content.split(old_string).length - 1
      if (count === 0) return '未找到匹配内容，请检查空格和换行'
      if (count > 1) return `找到 ${count} 处匹配，请提供更多上下文使 old_string 唯一`

      const updated = content.replace(old_string, () => new_string)
      if (Buffer.byteLength(updated, 'utf-8') > MAX_EDIT_FILE_BYTES) {
        return `替换后的文件超过 ${MAX_EDIT_FILE_BYTES} 字节限制`
      }
      await writeFile(resolved, updated, 'utf-8')
      return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
    },
  }

  const globTool: ToolDefinition = {
    name: 'glob',
    description: '在工作区内按 glob 模式搜索文件，如 src/**/*.ts',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' },
        path: { type: 'string', description: '工作区内搜索起点，默认当前工作区' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3_000,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
        return 'glob pattern 不允许使用绝对路径或 .. 跳出搜索目录'
      }
      const results = await fg(pattern, {
        cwd: workspace.resolveExisting(path),
        ignore: ['node_modules/**', '.git/**'],
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
      })
      if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`
      const sorted = results.sort()
      const suffix = sorted.length > MAX_GLOB_RESULTS ? '\n... (结果已截断)' : ''
      return sorted.slice(0, MAX_GLOB_RESULTS).join('\n') + suffix
    },
  }

  const grepTool: ToolDefinition = {
    name: 'grep',
    description: '在工作区文件中按正则表达式搜索，返回最多 50 条匹配',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '长度不超过 200 的正则表达式' },
        path: { type: 'string', description: '工作区内文件或目录，默认当前工作区' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3_000,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
      if (pattern.length > 200) return '正则表达式过长（最大 200 字符）'

      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'i')
      } catch {
        return `无效的正则表达式: "${pattern}"`
      }

      const base = workspace.resolveExisting(path)
      const baseStat = await stat(base)
      const files = baseStat.isFile()
        ? [base]
        : (await fg('**/*', {
            cwd: base,
            absolute: true,
            onlyFiles: true,
            followSymbolicLinks: false,
            ignore: ['node_modules/**', '.git/**', 'dist/**'],
          })).slice(0, MAX_SEARCH_FILES)
      const matches: string[] = []

      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break
        const fileStat = await stat(file)
        if (fileStat.size > MAX_SEARCH_FILE_BYTES) continue

        let content: string
        try {
          content = await readFile(file, 'utf-8')
        } catch {
          continue
        }

        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index++) {
          // Bound regex work per line; matching output is truncated separately.
          if (!regex.test(lines[index].slice(0, 10_000))) continue
          const line = lines[index].trimEnd()
          const preview = line.length > MAX_MATCH_LINE_CHARS
            ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…`
            : line
          matches.push(`${relative(baseStat.isFile() ? workspace.root : base, file)}:${index + 1}: ${preview}`)
          if (matches.length >= MAX_MATCHES) break
        }
      }

      if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`
      const suffix = matches.length >= MAX_MATCHES ? '\n... (结果已截断)' : ''
      return matches.join('\n') + suffix
    },
  }

  return [readFileTool, writeFileTool, listDirectoryTool, editFileTool, globTool, grepTool]
}
