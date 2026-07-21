import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3

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

/** 仅全局可路由地址返回 `true`；私有、回环和文档专用地址段均会被阻止。 */
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
    if (value >> 118n === 0x3fbn) return false // 已弃用的站点本地地址 fec0::/10
    if (value >> 120n === 0xffn) return false // 多播地址
    if (value >> 96n === 0x20010000n) return false // Teredo 2001::/32
    if (value >> 96n === 0x20010db8n) return false // 文档专用地址
    if (value >> 112n === 0x2002n) return false // 6to4
    if ((value >> 32n) === (ipv6Number('64:ff9b::')! >> 32n)) return false // NAT64 公认前缀
    if ((value >> 64n) === (ipv6Number('100::')! >> 64n)) return false // 仅丢弃前缀
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

export async function validatePublicUrl(rawUrl: string, lookup: DnsLookup = defaultLookup) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`无效 URL: ${rawUrl}`)
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http:// 或 https:// URL')
  if (url.username || url.password) throw new Error('URL 不允许包含用户名或密码')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error(`不允许访问端口 ${url.port}`)

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

export function createWebTools(dependencies: WebToolDependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch
  const lookup = dependencies.lookup || defaultLookup
  const maxBytes = dependencies.maxResponseBytes || MAX_RESPONSE_BYTES
  const maxRedirects = dependencies.maxRedirects ?? MAX_REDIRECTS

  return [
    {
      name: 'fetch_url',
      description: '抓取公网 HTTP(S) 页面并转换为纯文本；阻止本地网段、非常用端口和超大响应',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '公网 http:// 或 https:// URL' } },
        required: ['url'],
        additionalProperties: false,
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      maxResultChars: 1_500,
      execute: async ({ url }: { url: string }) => {
        try {
          let current = await validatePublicUrl(url, lookup)
          for (let redirects = 0; ; redirects++) {
            const response = await fetchImpl(current, {
              headers: { 'User-Agent': 'Mozilla/5.0 ti-agent' },
              redirect: 'manual',
              signal: AbortSignal.timeout(10_000),
            })

            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
              if (redirects >= maxRedirects) throw new Error(`重定向超过 ${maxRedirects} 次`)
              current = await validatePublicUrl(new URL(response.headers.get('location')!, current).href, lookup)
              continue
            }
            if (!response.ok) return `请求失败：HTTP ${response.status}`

            const html = await readLimitedText(response, maxBytes)
            return html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim() || '页面无文本内容'
          }
        } catch (error) {
          return `抓取失败：${error instanceof Error ? error.message : error}`
        }
      },
    },
  ]
}
