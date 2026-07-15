import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { ExecutionConstraints } from '../security/capabilities.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface ResolvedNetworkAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type DnsLookup = (hostname: string) => Promise<readonly {
  readonly address: string
  readonly family: number
}[]>

export interface NetworkDialRequest {
  readonly url: URL
  readonly address: string
  readonly family: 4 | 6
  readonly hostHeader: string
  readonly tlsServername?: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly maxResponseBytes: number
  readonly requestTimeoutMs: number
}

export interface NetworkDialResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export type NetworkDialer = (request: NetworkDialRequest) => Promise<NetworkDialResponse>

export interface NetworkBrokerOptions {
  readonly lookup?: DnsLookup
  readonly dial?: NetworkDialer
  readonly requestTimeoutMs?: number
}

export interface NetworkBrokerRequest {
  readonly url: string
  readonly constraints: ExecutionConstraints
  readonly signal: AbortSignal
  readonly deadline: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
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
  let value = address.toLowerCase().split('%')[0]!
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

type IpCidr = readonly [base: string, prefix: number]

/**
 * Conservative denylist derived from the IANA special-purpose registries.
 *
 * Agent egress does not need protocol anycast, transition or benchmarking
 * ranges, so registered special-purpose blocks remain denied even when IANA
 * marks an individual allocation as globally reachable. Multicast and the
 * deprecated IPv6 site-local range are included as additional non-unicast
 * boundaries.
 */
const SPECIAL_IPV4_CIDRS: readonly IpCidr[] = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])

const SPECIAL_IPV6_CIDRS: readonly IpCidr[] = Object.freeze([
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible encodings
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // well-known IPv4/IPv6 translation
  ['64:ff9b:1::', 48], // local-use IPv4/IPv6 translation
  ['100::', 64], // discard-only
  ['100:0:0:1::', 64], // dummy prefix
  ['2001::', 23], // IETF protocol assignments, including Teredo/ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['2620:4f:8000::', 48], // direct delegation AS112
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment-routing SIDs
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
])

function inIpv6Cidr(address: bigint, base: bigint, prefix: number) {
  if (prefix === 0) return true
  const shift = BigInt(128 - prefix)
  return address >> shift === base >> shift
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)!
    return !SPECIAL_IPV4_CIDRS.some(
      ([base, prefix]) => inIpv4Cidr(value, ipv4Number(base)!, prefix),
    )
  }

  if (family === 6) {
    const value = ipv6Number(address)
    const globalUnicast = ipv6Number('2000::')!
    return value !== undefined
      && inIpv6Cidr(value, globalUnicast, 3)
      && !SPECIAL_IPV6_CIDRS.some(([base, prefix]) => {
      const baseValue = ipv6Number(base)
      return baseValue !== undefined && inIpv6Cidr(value, baseValue, prefix)
      })
  }
  return false
}

function canonicalHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

export function parseNetworkUrl(rawUrl: string) {
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

export function networkPort(url: URL) {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}

export function assertUrlWithinConstraints(url: URL, constraints: ExecutionConstraints | undefined) {
  if (!constraints?.networkSchemes || !constraints.networkHosts || !constraints.networkPorts) {
    throw new Error('网络请求缺少已授权的执行约束')
  }
  const scheme = url.protocol.slice(0, -1)
  const host = canonicalHostname(url)
  const port = networkPort(url)
  if (!constraints.networkSchemes.includes(scheme)
    || !constraints.networkHosts.includes(host)
    || !constraints.networkPorts.includes(port)) {
    throw new Error(`URL 超出已授权网络约束: ${scheme}://${host}:${port}`)
  }
}

async function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function controlError(signal: AbortSignal, deadline: number) {
  if (signal.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Network request aborted', 'AbortError')
  }
  if (Date.now() >= deadline) return new DOMException('Network request deadline exceeded', 'TimeoutError')
  return undefined
}

async function waitWithControl<T>(promise: Promise<T>, signal: AbortSignal, deadline: number) {
  const initial = controlError(signal, deadline)
  if (initial) throw initial
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      callback()
    }
    const onAbort = () => finish(() => reject(controlError(signal, deadline)))
    const timer = setTimeout(
      () => finish(() => reject(new DOMException('Network request deadline exceeded', 'TimeoutError'))),
      Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_DELAY_MS),
    )
    timer.unref()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

export async function resolvePublicAddresses(
  url: URL,
  lookup: DnsLookup = defaultLookup,
  signal = new AbortController().signal,
  deadline = Date.now() + DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<readonly ResolvedNetworkAddress[]> {
  const hostname = canonicalHostname(url)
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`禁止访问本地地址: ${hostname}`)
  }
  const literalFamily = isIP(hostname)
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await waitWithControl(Promise.resolve().then(() => lookup(hostname)), signal, deadline)
  if (answers.length === 0) throw new Error(`DNS 未返回地址: ${hostname}`)

  const normalized = answers.map(({ address, family }) => {
    const actualFamily = isIP(address)
    if ((actualFamily !== 4 && actualFamily !== 6) || actualFamily !== family) {
      throw new Error(`DNS 返回非法地址: ${hostname}`)
    }
    return Object.freeze({ address, family: actualFamily })
  })
  if (normalized.some(({ address }) => !isPublicAddress(address))) {
    throw new Error(`禁止访问非公网地址: ${hostname}`)
  }
  return Object.freeze(normalized)
}

/** Compatibility helper. Production requests must still go through NetworkBroker to pin the dial. */
export async function validatePublicUrl(rawUrl: string, lookup: DnsLookup = defaultLookup) {
  const url = parseNetworkUrl(rawUrl)
  await resolvePublicAddresses(url, lookup)
  return url
}

function normalizeHeaders(headers: IncomingHttpHeaders) {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return Object.freeze(result)
}

/** Native direct dial: no global fetch, shared Agent, or proxy environment is consulted. */
export const dialPinnedAddress: NetworkDialer = async (input) => {
  const remaining = input.deadline - Date.now()
  if (remaining <= 0) throw new DOMException('Network request deadline exceeded', 'TimeoutError')
  const requestSignal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(Math.min(input.requestTimeoutMs, remaining)),
  ])
  const hostname = canonicalHostname(input.url)
  const options: RequestOptions = {
    protocol: input.url.protocol,
    hostname,
    port: networkPort(input.url),
    path: `${input.url.pathname}${input.url.search}`,
    method: 'GET',
    headers: {
      Host: input.hostHeader,
      'User-Agent': 'Mozilla/5.0 SuperAgent',
      Accept: 'text/html, text/plain, application/xhtml+xml',
    },
    agent: false,
    family: input.family,
    signal: requestSignal,
    lookup: (_requestedHostname, _options, callback) => {
      callback(null, input.address, input.family)
    },
    ...(input.tlsServername === undefined ? {} : { servername: input.tlsServername }),
  }
  const start = input.url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<NetworkDialResponse>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
    }
    const request = start(options, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += value.length
        if (bytes > input.maxResponseBytes) {
          const error = new Error(`响应体超过 ${input.maxResponseBytes} 字节限制`)
          finish(() => reject(error))
          response.destroy(error)
          request.destroy(error)
          return
        }
        chunks.push(Buffer.from(value))
      })
      response.once('end', () => finish(() => resolve(Object.freeze({
        status: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }))))
      response.once('error', (error) => finish(() => reject(error)))
    })
    request.once('error', (error) => finish(() => reject(error)))
    request.end()
  })
}

export class NetworkBroker {
  private readonly lookup: DnsLookup
  private readonly dial: NetworkDialer
  private readonly requestTimeoutMs: number

  constructor(options: NetworkBrokerOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup
    this.dial = options.dial ?? dialPinnedAddress
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs 必须是正安全整数')
    }
  }

  async request(input: NetworkBrokerRequest): Promise<NetworkDialResponse> {
    if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes <= 0) {
      throw new TypeError('maxResponseBytes 必须是正安全整数')
    }
    if (!Number.isSafeInteger(input.maxRedirects) || input.maxRedirects < 0) {
      throw new TypeError('maxRedirects 必须是非负安全整数')
    }
    let current = parseNetworkUrl(input.url)
    for (let redirects = 0; ; redirects++) {
      const runtimeError = controlError(input.signal, input.deadline)
      if (runtimeError) throw runtimeError
      assertUrlWithinConstraints(current, input.constraints)
      const addresses = await resolvePublicAddresses(
        current,
        this.lookup,
        input.signal,
        input.deadline,
      )
      const pinned = addresses[0]!
      const hostname = canonicalHostname(current)
      const dialDeadline = Math.min(
        input.deadline,
        Date.now() + this.requestTimeoutMs,
      )
      const dialSignal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(Math.max(1, dialDeadline - Date.now())),
      ])
      const response = await waitWithControl(this.dial({
        url: current,
        address: pinned.address,
        family: pinned.family,
        hostHeader: current.host,
        ...(current.protocol === 'https:' && isIP(hostname) === 0
          ? { tlsServername: hostname }
          : {}),
        signal: dialSignal,
        deadline: dialDeadline,
        maxResponseBytes: input.maxResponseBytes,
        requestTimeoutMs: this.requestTimeoutMs,
      }), dialSignal, dialDeadline)
      if (Buffer.byteLength(response.body, 'utf8') > input.maxResponseBytes) {
        throw new Error(`响应体超过 ${input.maxResponseBytes} 字节限制`)
      }

      const location = response.headers.location
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects >= input.maxRedirects) throw new Error(`重定向超过 ${input.maxRedirects} 次`)
        current = parseNetworkUrl(new URL(location, current).href)
        // The next loop checks policy before DNS and pins a fresh vetted answer.
        continue
      }
      return response
    }
  }
}
