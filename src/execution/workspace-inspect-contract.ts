import { isAbsolute } from 'node:path'

export const INSPECT_PROCESS_TOOL_NAME = 'workspace_inspect'
export const WORKSPACE_INSPECT_HELPER_PATH = '/usr/libexec/super-agent/workspace-inspect'
export const INSPECT_ACTIONS = ['list_files', 'read_text', 'search_text'] as const
export const MAX_WORKSPACE_INSPECT_QUERY_BYTES = 256
export const MAX_WORKSPACE_INSPECT_PATH_BYTES = 256
// JSON Schema maxLength is character-based; the parser additionally enforces
// the C helper's byte-based argv contract with the corresponding byte constants.
export const MAX_WORKSPACE_INSPECT_QUERY_CHARS = MAX_WORKSPACE_INSPECT_QUERY_BYTES
export const MAX_WORKSPACE_INSPECT_PATH_CHARS = MAX_WORKSPACE_INSPECT_PATH_BYTES
export const MAX_WORKSPACE_INSPECT_RESULTS = 200

export interface InspectProcessInput {
  readonly action: typeof INSPECT_ACTIONS[number]
  readonly path: string
  readonly limit: number
  readonly query?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exceedsUtf8ByteLimit(value: string, maximum: number) {
  return Buffer.byteLength(value, 'utf8') > maximum
}

function isSafeRelativePath(value: string) {
  if (value === '.') return true
  if (value.length === 0 || value.length > MAX_WORKSPACE_INSPECT_PATH_CHARS
    || exceedsUtf8ByteLimit(value, MAX_WORKSPACE_INSPECT_PATH_BYTES)
    || isAbsolute(value) || /[\0-\x1f\x7f]/.test(value) || value.includes('\\')) return false
  return value.split('/').every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  )
}

/** Single host-side validator shared by tool preflight and sandbox argv mapping. */
export function parseInspectProcessInput(value: unknown): InspectProcessInput {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['action', 'path', 'limit', 'query'].includes(key))
    || typeof value.action !== 'string'
    || !INSPECT_ACTIONS.includes(value.action as InspectProcessInput['action'])
    || typeof value.path !== 'string'
    || !isSafeRelativePath(value.path)
    || !Number.isSafeInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > MAX_WORKSPACE_INSPECT_RESULTS) {
    throw new TypeError('workspace_inspect 必须包含合法 action、相对 path 与结果 limit')
  }
  const search = value.action === 'search_text'
  if (search
    ? typeof value.query !== 'string'
      || value.query.length === 0
      || value.query.length > MAX_WORKSPACE_INSPECT_QUERY_CHARS
      || exceedsUtf8ByteLimit(value.query, MAX_WORKSPACE_INSPECT_QUERY_BYTES)
      || /[\0-\x1f\x7f]/.test(value.query)
    : value.query !== undefined) {
    throw new TypeError('只有 search_text action 必须携带合法 query')
  }
  return Object.freeze({
    action: value.action as InspectProcessInput['action'],
    path: value.path,
    limit: value.limit as number,
    ...(search ? { query: value.query as string } : {}),
  })
}

/** Exact rootfs helper protocol; the model never controls executable or environment. */
export function buildWorkspaceInspectHelperArgv(value: unknown): readonly string[] {
  const input = parseInspectProcessInput(value)
  return Object.freeze([
    WORKSPACE_INSPECT_HELPER_PATH,
    'v1',
    input.action,
    String(input.limit),
    input.path,
    ...(input.query === undefined ? [] : [input.query]),
  ])
}
