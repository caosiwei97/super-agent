import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ToolDefinition, ToolExecutionContext } from '../../core/tool-registry.js'
import type { ExecutionConstraints } from '../../security/capabilities.js'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_RESULT_CHARS = 1_500

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface WebToolDependencies {
  fetch?: typeof globalThis.fetch
  lookup?: DnsLookup
  maxResponseBytes?: number
  maxRedirects?: number
}

function ipv4Number(address: string) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inIpv4Cidr(address: number, base: number, prefix: number) {
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (base & mask)
}

function ipv6Number(address: string) {
  let value = address.toLowerCase().split('%')[0]
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (ipv4Tail) {
    const ipv4 = ipv4Number(ipv4Tail)
    if (ipv4 === undefined) return undefined
    value = value.slice(0, -ipv4Tail.length) + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined

  return groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n)
}

/** True only for globally routable addresses; private, loopback and documentation ranges are blocked. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)!
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ]
    return !blocked.some(([base, prefix]) => inIpv4Cidr(value, ipv4Number(base)!, prefix))
  }

  if (family === 6) {
    const value = ipv6Number(address)
    if (value === undefined || value === 0n || value === 1n) return false
    if (value >> 32n === 0n) {
      const compatible = Number(value & 0xffffffffn)
      return isPublicAddress([
        compatible >>> 24,
        (compatible >>> 16) & 255,
        (compatible >>> 8) & 255,
        compatible & 255,
      ].join('.'))
    }
    if (value >> 121n === 0x7en) return false // fc00::/7
    if (value >> 118n === 0x3fan) return false // fe80::/10
    if (value >> 118n === 0x3fbn) return false // deprecated site-local fec0::/10
    if (value >> 120n === 0xffn) return false // multicast
    if (value >> 96n === 0x20010000n) return false // Teredo 2001::/32
    if (value >> 96n === 0x20010db8n) return false // documentation
    if (value >> 112n === 0x2002n) return false // 6to4
    if ((value >> 32n) === (ipv6Number('64:ff9b::')! >> 32n)) return false // NAT64 well-known prefix
    if ((value >> 64n) === (ipv6Number('100::')! >> 64n)) return false // discard-only prefix
    if (value >> 32n === 0xffffn) {
      const mapped = Number(value & 0xffffffffn)
      return isPublicAddress([
        mapped >>> 24,
        (mapped >>> 16) & 255,
        (mapped >>> 8) & 255,
        mapped & 255,
      ].join('.'))
    }
    return true
  }

  return false
}

async function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function parseNetworkUrl(rawUrl: string) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`无效 URL: ${rawUrl}`)
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http:// 或 https:// URL')
  if (url.username || url.password) throw new Error('URL 不允许包含用户名或密码')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error(`不允许访问端口 ${url.port}`)

  return url
}

function networkPort(url: URL) {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}

/** Resolve the invocation boundary before policy evaluation; DNS remains an execution-time check. */
export function getUrlConstraints(rawUrl: string): ExecutionConstraints {
  const url = parseNetworkUrl(rawUrl)
  return {
    networkSchemes: [url.protocol.slice(0, -1)],
    networkHosts: [url.hostname.replace(/^\[|\]$/g, '').toLowerCase()],
    networkPorts: [networkPort(url)],
    maxResultChars: MAX_RESULT_CHARS,
  }
}

function assertUrlWithinConstraints(url: URL, constraints: ExecutionConstraints | undefined) {
  if (!constraints?.networkSchemes
    || !constraints.networkHosts
    || !constraints.networkPorts
    || constraints.maxResultChars === undefined) {
    throw new Error('fetch_url 缺少已授权的网络执行约束')
  }
  const scheme = url.protocol.slice(0, -1)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = networkPort(url)
  if (!constraints.networkSchemes.includes(scheme)
    || !constraints.networkHosts.includes(host)
    || !constraints.networkPorts.includes(port)) {
    throw new Error(`URL 超出已授权网络约束: ${scheme}://${host}:${port}`)
  }
}

export async function validatePublicUrl(rawUrl: string, lookup: DnsLookup = defaultLookup) {
  const url = parseNetworkUrl(rawUrl)

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`禁止访问本地地址: ${hostname}`)
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error(`禁止访问非公网地址: ${hostname}`)
  }
  return url
}

async function readLimitedText(response: Response, maxBytes: number) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new Error(`响应体超过 ${maxBytes} 字节限制`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function createWebTools(dependencies: WebToolDependencies = {}): ToolDefinition[] {
  const fetchImpl = dependencies.fetch || globalThis.fetch
  const lookup = dependencies.lookup || defaultLookup
  const maxBytes = dependencies.maxResponseBytes || MAX_RESPONSE_BYTES
  const maxRedirects = dependencies.maxRedirects ?? MAX_REDIRECTS

  return [
    {
      name: 'fetch_url',
      executionKind: 'network',
      description: '抓取公网 HTTP(S) 页面并转换为纯文本；阻止本地网段、非常用端口和超大响应',
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
          let current = parseNetworkUrl(url)
          assertUrlWithinConstraints(current, context.constraints)
          current = await validatePublicUrl(current.href, lookup)
          for (let redirects = 0; ; redirects++) {
            // The policy snapshot is immutable. Re-check every hop so a server
            // cannot redirect an approved origin to an unapproved destination.
            assertUrlWithinConstraints(current, context.constraints)
            const remaining = context.deadline - Date.now()
            if (remaining <= 0) throw new DOMException('Web request deadline exceeded', 'TimeoutError')
            const requestSignal = AbortSignal.any([
              context.signal,
              AbortSignal.timeout(Math.min(10_000, remaining)),
            ])
            const response = await fetchImpl(current, {
              headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
              redirect: 'manual',
              signal: requestSignal,
            })

            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
              if (redirects >= maxRedirects) throw new Error(`重定向超过 ${maxRedirects} 次`)
              const redirect = parseNetworkUrl(new URL(response.headers.get('location')!, current).href)
              assertUrlWithinConstraints(redirect, context.constraints)
              current = await validatePublicUrl(redirect.href, lookup)
              continue
            }
            if (!response.ok) return `请求失败：HTTP ${response.status}`

            const html = await readLimitedText(response, maxBytes)
            const text = html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim() || '页面无文本内容'
            return text.slice(0, context.constraints!.maxResultChars)
          }
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
