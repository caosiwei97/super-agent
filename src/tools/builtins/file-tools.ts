import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolDefinition, ToolExecutionContext } from '../../core/tool-registry.js'
import type { Workspace } from '../../core/workspace.js'
import { FilesystemBroker } from '../../execution/filesystem-broker.js'
import {
  InvalidRegexPatternError,
  RegexWorkerMatcher,
} from '../../execution/regex-worker.js'
import {
  isPathWithin,
  isSensitivePath,
  isSensitivePathPattern,
} from '../../security/sensitive-paths.js'

const MAX_SEARCH_FILES = 2_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 50
const MAX_GLOB_RESULTS = 500
const MAX_DIRECTORY_ENTRIES = 500
const MAX_MATCH_LINE_CHARS = 500
const MAX_SEARCH_ENTRIES = 20_000
const MAX_GLOB_PATTERN_CHARS = 500
const GLOB_HARD_TIMEOUT_MS = 1_000

function matchGlobSegment(pattern: string, value: string, deadline: number) {
  let patternIndex = 0
  let valueIndex = 0
  let lastStar = -1
  let retryValueIndex = -1
  let steps = 0
  while (valueIndex < value.length) {
    if ((steps++ & 0xff) === 0 && Date.now() >= deadline) {
      throw new DOMException('glob 硬超时', 'TimeoutError')
    }
    const token = pattern[patternIndex]
    if (token === '?' || token === value[valueIndex]) {
      patternIndex++
      valueIndex++
    } else if (token === '*') {
      lastStar = patternIndex++
      retryValueIndex = valueIndex
    } else if (lastStar >= 0) {
      patternIndex = lastStar + 1
      valueIndex = ++retryValueIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++
  return patternIndex === pattern.length
}

/** Linear-state glob matcher for the deliberately small *, ** and ? grammar. */
function matchesGlob(pattern: string, candidate: string, deadline: number) {
  const patterns = pattern.replaceAll('\\', '/').split('/').filter((part) => part !== '')
  const values = candidate.replaceAll('\\', '/').split('/').filter((part) => part !== '')
  const memo = new Map<string, boolean>()
  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result: boolean
    if (patternIndex === patterns.length) result = valueIndex === values.length
    else if (patterns[patternIndex] === '**') {
      result = visit(patternIndex + 1, valueIndex)
        || (valueIndex < values.length && visit(patternIndex, valueIndex + 1))
    } else {
      result = valueIndex < values.length
        && matchGlobSegment(patterns[patternIndex]!, values[valueIndex]!, deadline)
        && visit(patternIndex + 1, valueIndex + 1)
    }
    memo.set(key, result)
    return result
  }
  return visit(0, 0)
}

function readCapabilities(target: string, workspace: Workspace) {
  return isSensitivePath(target, workspace.root)
    ? ['filesystem.read', 'secret.read'] as const
    : ['filesystem.read'] as const
}

function assertConstrainedPath(
  context: ToolExecutionContext,
  field: 'filesystemReadRoots' | 'filesystemWriteRoots',
  target: string,
) {
  const roots = context.constraints?.[field]
  if (!roots?.some((root) => isPathWithin(root, target))) {
    throw new Error(`执行约束不允许访问路径: ${target}`)
  }
}

function assertSensitiveRead(context: ToolExecutionContext, target: string, workspace: Workspace) {
  if (isSensitivePath(target, workspace.root) && !context.capabilities?.includes('secret.read')) {
    throw new Error(`读取敏感路径需要 secret.read: ${target}`)
  }
}

export interface FileToolDependencies {
  readonly filesystem?: FilesystemBroker
  readonly regexTimeoutMs?: number
}

export function createFileTools(workspace: Workspace, dependencies: FileToolDependencies = {}) {
  const filesystem = dependencies.filesystem ?? new FilesystemBroker(workspace.root)
  const readFileTool: ToolDefinition = {
    name: 'read_file',
    executionKind: 'filesystem',
    description: '读取工作区内指定路径的 UTF-8 文件内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内的文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    getCapabilities: (input) => {
      const { path } = input as { path: string }
      return readCapabilities(workspace.resolveExisting(path), workspace)
    },
    getConstraints: (input) => ({
      filesystemReadRoots: [workspace.resolveExisting((input as { path: string }).path)],
    }),
    supportedConstraintKeys: ['filesystemReadRoots'],
    isConcurrencySafe: () => true,
    maxResultChars: 3_000,
    execute: async ({ path }: { path: string }, context) => {
      const resolved = workspace.resolveExisting(path)
      assertConstrainedPath(context, 'filesystemReadRoots', resolved)
      assertSensitiveRead(context, resolved, workspace)
      return filesystem.readText(resolved, MAX_EDIT_FILE_BYTES, context)
    },
    dispose: () => filesystem.close(),
  }

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    executionKind: 'filesystem',
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
    getCapabilities: () => ['filesystem.write'],
    getConstraints: (input) => ({
      filesystemWriteRoots: [workspace.resolveForWrite((input as { path: string }).path)],
    }),
    supportedConstraintKeys: ['filesystemWriteRoots'],
    isConcurrencySafe: () => false,
    execute: async ({ path, content }: { path: string; content: string }, context) => {
      if (Buffer.byteLength(content, 'utf-8') > MAX_EDIT_FILE_BYTES) {
        return `写入内容超过 ${MAX_EDIT_FILE_BYTES} 字节限制`
      }
      const resolved = workspace.resolveForWrite(path)
      assertConstrainedPath(context, 'filesystemWriteRoots', resolved)
      await filesystem.writeTextAtomic(resolved, content, MAX_EDIT_FILE_BYTES, context)
      return `已写入 ${content.length} 字符到 ${path}`
    },
  }

  const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    executionKind: 'filesystem',
    description: '列出工作区内指定目录的文件和子目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内目录，默认当前工作区' } },
      required: [],
      additionalProperties: false,
    },
    getCapabilities: (input) => {
      const { path = '.' } = input as { path?: string }
      return readCapabilities(workspace.resolveExisting(path), workspace)
    },
    getConstraints: (input) => ({
      filesystemReadRoots: [workspace.resolveExisting((input as { path?: string }).path ?? '.')],
    }),
    supportedConstraintKeys: ['filesystemReadRoots'],
    isConcurrencySafe: () => true,
    execute: async ({ path = '.' }: { path?: string }, context) => {
      const directory = workspace.resolveExisting(path)
      assertConstrainedPath(context, 'filesystemReadRoots', directory)
      assertSensitiveRead(context, directory, workspace)
      const entries = await filesystem.listDirectory(directory, MAX_DIRECTORY_ENTRIES, context)
      const canReadSecrets = context.capabilities?.includes('secret.read') === true
      const visible = entries.filter((entry) => canReadSecrets
        || !isSensitivePath(join(directory, entry.name), workspace.root))
      const rendered = [...visible]
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((entry) => `${entry.kind === 'directory' ? '[DIR]' : '[FILE]'} ${entry.name}`)
        .join('\n')
      return entries.length > MAX_DIRECTORY_ENTRIES ? `${rendered}\n... (结果已截断)` : rendered
    },
  }

  const editFileTool: ToolDefinition = {
    name: 'edit_file',
    executionKind: 'filesystem',
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
    getCapabilities: (input) => {
      const { path } = input as { path: string }
      const target = workspace.resolveExisting(path)
      return isSensitivePath(target, workspace.root)
        ? ['filesystem.read', 'filesystem.write', 'secret.read']
        : ['filesystem.read', 'filesystem.write']
    },
    getConstraints: (input) => {
      const { path } = input as { path: string }
      const target = workspace.resolveExisting(path)
      return { filesystemReadRoots: [target], filesystemWriteRoots: [target] }
    },
    supportedConstraintKeys: ['filesystemReadRoots', 'filesystemWriteRoots'],
    isConcurrencySafe: () => false,
    execute: async ({ path, old_string, new_string }: {
      path: string
      old_string: string
      new_string: string
    }, context) => {
      if (!old_string) return 'old_string 不能为空'
      const resolved = workspace.resolveExisting(path)
      assertConstrainedPath(context, 'filesystemReadRoots', resolved)
      assertConstrainedPath(context, 'filesystemWriteRoots', resolved)
      assertSensitiveRead(context, resolved, workspace)
      const content = await filesystem.readText(resolved, MAX_EDIT_FILE_BYTES, context)
      const count = content.split(old_string).length - 1
      if (count === 0) return '未找到匹配内容，请检查空格和换行'
      if (count > 1) return `找到 ${count} 处匹配，请提供更多上下文使 old_string 唯一`

      const updated = content.replace(old_string, () => new_string)
      if (Buffer.byteLength(updated, 'utf-8') > MAX_EDIT_FILE_BYTES) {
        return `替换后的文件超过 ${MAX_EDIT_FILE_BYTES} 字节限制`
      }
      await filesystem.writeTextAtomic(resolved, updated, MAX_EDIT_FILE_BYTES, context)
      return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
    },
  }

  const globTool: ToolDefinition = {
    name: 'glob',
    executionKind: 'filesystem',
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
    getCapabilities: (input) => {
      const { pattern, path = '.' } = input as { pattern: string; path?: string }
      const base = workspace.resolveExisting(path)
      return isSensitivePath(base, workspace.root)
        || isSensitivePath(resolve(base, pattern), workspace.root)
        || isSensitivePathPattern(pattern)
        ? ['filesystem.read', 'secret.read']
        : ['filesystem.read']
    },
    getConstraints: (input) => ({
      filesystemReadRoots: [workspace.resolveExisting((input as { path?: string }).path ?? '.')],
    }),
    supportedConstraintKeys: ['filesystemReadRoots'],
    isConcurrencySafe: () => true,
    maxResultChars: 3_000,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }, context) => {
      if (pattern.length === 0 || pattern.length > MAX_GLOB_PATTERN_CHARS) {
        return `glob pattern 长度必须为 1..${MAX_GLOB_PATTERN_CHARS}`
      }
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
        return 'glob pattern 不允许使用绝对路径或 .. 跳出搜索目录'
      }
      if (/[\[\]{}()!+@]/.test(pattern)) {
        return 'glob pattern 当前只支持字面路径、*、** 和 ?'
      }
      const base = workspace.resolveExisting(path)
      assertConstrainedPath(context, 'filesystemReadRoots', base)
      assertSensitiveRead(context, base, workspace)
      const globDeadline = Math.min(context.deadline, Date.now() + GLOB_HARD_TIMEOUT_MS)
      const globControl = { signal: context.signal, deadline: globDeadline }
      const files = await filesystem.walkFiles(base, {
        maxFiles: MAX_SEARCH_ENTRIES,
        maxEntries: MAX_SEARCH_ENTRIES,
        excludeDirectoryNames: ['node_modules', '.git'],
      }, globControl)
      const results = files.map((file) => relative(base, file)).filter((file) => {
        context.signal.throwIfAborted()
        if (Date.now() >= globDeadline) {
          throw new DOMException('glob 硬超时', 'TimeoutError')
        }
        return matchesGlob(pattern, file, globDeadline)
      })
      const canReadSecrets = context.capabilities?.includes('secret.read') === true
      const visible = results.filter((item) => canReadSecrets
        || !isSensitivePath(join(base, item), workspace.root))
      if (visible.length === 0) return `没有找到匹配 "${pattern}" 的文件`
      const sorted = visible.sort()
      const suffix = sorted.length > MAX_GLOB_RESULTS ? '\n... (结果已截断)' : ''
      return sorted.slice(0, MAX_GLOB_RESULTS).join('\n') + suffix
    },
  }

  const grepTool: ToolDefinition = {
    name: 'grep',
    executionKind: 'filesystem',
    description: '在隔离 worker 中按正则表达式搜索工作区文件，硬超时并返回最多 50 条匹配',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '长度不超过 200 的正则表达式' },
        path: { type: 'string', description: '工作区内文件或目录，默认当前工作区' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    getCapabilities: (input) => {
      const { path = '.' } = input as { path?: string }
      return readCapabilities(workspace.resolveExisting(path), workspace)
    },
    getConstraints: (input) => ({
      filesystemReadRoots: [workspace.resolveExisting((input as { path?: string }).path ?? '.')],
    }),
    supportedConstraintKeys: ['filesystemReadRoots'],
    isConcurrencySafe: () => true,
    maxResultChars: 3_000,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }, context) => {
      if (pattern.length > 200) return '正则表达式过长（最大 200 字符）'

      let matcher: RegexWorkerMatcher
      try {
        matcher = await RegexWorkerMatcher.create(pattern, {
          signal: context.signal,
          deadline: context.deadline,
          timeoutMs: dependencies.regexTimeoutMs,
        })
      } catch (error) {
        if (error instanceof InvalidRegexPatternError) return `无效的正则表达式: "${pattern}"`
        throw error
      }

      try {
        const base = workspace.resolveExisting(path)
        assertConstrainedPath(context, 'filesystemReadRoots', base)
        assertSensitiveRead(context, base, workspace)
        const files = await filesystem.walkFiles(base, {
          maxFiles: MAX_SEARCH_FILES,
          maxEntries: MAX_SEARCH_ENTRIES,
          excludeDirectoryNames: ['node_modules', '.git', 'dist'],
        }, context)
        const matches: string[] = []

        for (const file of files) {
          if (matches.length >= MAX_MATCHES) break
          context.signal.throwIfAborted()
          if (Date.now() >= context.deadline) {
            throw new DOMException('grep deadline 已到期', 'TimeoutError')
          }
          if (!context.capabilities?.includes('secret.read') && isSensitivePath(file, workspace.root)) continue

          let content: string
          try {
            content = await filesystem.readText(file, MAX_SEARCH_FILE_BYTES, context)
          } catch (error) {
            if (context.signal.aborted || Date.now() >= context.deadline) throw error
            continue
          }

          const remaining = MAX_MATCHES - matches.length
          const matchedLines = await matcher.match(content, remaining)
          const lines = content.split('\n')
          for (const index of matchedLines) {
            if (index >= lines.length) throw new Error('Regex worker 返回越界行号')
            const line = lines[index].trimEnd()
            const preview = line.length > MAX_MATCH_LINE_CHARS
              ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…`
              : line
            matches.push(`${relative(files.length === 1 && files[0] === base ? workspace.root : base, file)}:${index + 1}: ${preview}`)
          }
        }

        if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`
        const suffix = matches.length >= MAX_MATCHES ? '\n... (结果已截断)' : ''
        return matches.join('\n') + suffix
      } finally {
        await matcher.close()
      }
    },
  }

  return [readFileTool, writeFileTool, listDirectoryTool, editFileTool, globTool, grepTool]
}
