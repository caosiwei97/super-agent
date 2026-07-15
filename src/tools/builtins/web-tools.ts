import type { ToolDefinition, ToolExecutionContext } from '../../core/tool-registry.js'
import {
  NetworkBroker,
  assertUrlWithinConstraints,
  isPublicAddress,
  networkPort,
  parseNetworkUrl,
  validatePublicUrl,
  type DnsLookup,
  type NetworkDialer,
} from '../../execution/network-broker.js'
import type { ExecutionConstraints } from '../../security/capabilities.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_RESULT_CHARS = 1_500

export type { DnsLookup, NetworkDialer }
export { isPublicAddress, validatePublicUrl }

export interface WebToolDependencies {
  lookup?: DnsLookup
  dial?: NetworkDialer
  maxResponseBytes?: number
  maxRedirects?: number
  requestTimeoutMs?: number
}

/** Resolve the invocation boundary before policy evaluation; DNS remains execution-time state. */
export function getUrlConstraints(rawUrl: string): ExecutionConstraints {
  const url = parseNetworkUrl(rawUrl)
  return {
    networkSchemes: [url.protocol.slice(0, -1)],
    networkHosts: [url.hostname.replace(/^\[|\]$/g, '').toLowerCase()],
    networkPorts: [networkPort(url)],
    maxResultChars: MAX_RESULT_CHARS,
  }
}

export function createWebTools(dependencies: WebToolDependencies = {}): ToolDefinition[] {
  const broker = new NetworkBroker({
    ...(dependencies.lookup === undefined ? {} : { lookup: dependencies.lookup }),
    ...(dependencies.dial === undefined ? {} : { dial: dependencies.dial }),
    ...(dependencies.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: dependencies.requestTimeoutMs }),
  })
  const maxBytes = dependencies.maxResponseBytes ?? MAX_RESPONSE_BYTES
  const maxRedirects = dependencies.maxRedirects ?? MAX_REDIRECTS

  return [
    {
      name: 'fetch_url',
      executionKind: 'network',
      description: '抓取公网 HTTP(S) 页面并转换为纯文本；连接固定到已验证公网 IP',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '公网 http:// 或 https:// URL' } },
        required: ['url'],
        additionalProperties: false,
      },
      getCapabilities: () => ['network.egress', 'external.read'] as const,
      getConstraints: (input: unknown) => getUrlConstraints((input as { url: string }).url),
      supportedConstraintKeys: ['networkSchemes', 'networkHosts', 'networkPorts'],
      isConcurrencySafe: () => true,
      maxResultChars: MAX_RESULT_CHARS,
      execute: async ({ url }: { url: string }, context: ToolExecutionContext) => {
        try {
          const initial = parseNetworkUrl(url)
          assertUrlWithinConstraints(initial, context.constraints)
          const response = await broker.request({
            url: initial.href,
            constraints: context.constraints,
            signal: context.signal,
            deadline: context.deadline,
            maxResponseBytes: maxBytes,
            maxRedirects,
          })
          if (response.status < 200 || response.status >= 300) {
            return `请求失败：HTTP ${response.status}`
          }
          const text = response.body
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || '页面无文本内容'
          return text.slice(0, context.constraints.maxResultChars ?? MAX_RESULT_CHARS)
        } catch (error) {
          if (context.signal.aborted) {
            throw context.signal.reason instanceof Error
              ? context.signal.reason
              : new DOMException('Web request aborted', 'AbortError')
          }
          return `抓取失败：${error instanceof Error ? error.message : error}`
        }
      },
    },
  ]
}
