import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import {
  NetworkBroker,
  dialPinnedAddress,
  type NetworkDialRequest,
  type NetworkDialResponse,
} from '../src/execution/network-broker.js'
import { getUrlConstraints } from '../src/tools/builtins/web-tools.js'

function request(url = 'https://public.example/start') {
  return {
    url,
    constraints: getUrlConstraints('https://public.example/start'),
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    maxResponseBytes: 1024,
    maxRedirects: 3,
  }
}

describe('NetworkBroker pinned-IP boundary', () => {
  it('uses the pinned address for the actual socket while preserving the HTTP Host authority', async (context) => {
    let hostHeader: string | undefined
    const server = createServer((incoming, response) => {
      hostHeader = incoming.headers.host
      response.end('direct')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    context.after(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server address unavailable')

    const response = await dialPinnedAddress({
      url: new URL(`http://must-not-resolve.invalid:${address.port}/probe`),
      address: '127.0.0.1',
      family: 4,
      hostHeader: `must-not-resolve.invalid:${address.port}`,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      maxResponseBytes: 1024,
      requestTimeoutMs: 2_000,
    })

    assert.equal(response.body, 'direct')
    assert.equal(hostHeader, `must-not-resolve.invalid:${address.port}`)
  })

  it('rejects every mixed public/private DNS set before dialing', async () => {
    let dials = 0
    const broker = new NetworkBroker({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      dial: async () => {
        dials++
        throw new Error('must not dial')
      },
    })

    await assert.rejects(broker.request(request()), /禁止访问非公网地址/)
    assert.equal(dials, 0)
  })

  it('rejects mixed public/local-use NAT64 DNS answers before dialing', async () => {
    let dials = 0
    const broker = new NetworkBroker({
      lookup: async () => [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '64:ff9b:1::a00:1', family: 6 },
      ],
      dial: async () => {
        dials++
        throw new Error('must not dial')
      },
    })

    await assert.rejects(broker.request(request()), /禁止访问非公网地址/)
    assert.equal(dials, 0)
  })

  it('pins IPv4 while retaining the original Host header and TLS SNI', async () => {
    let observed: NetworkDialRequest | undefined
    const broker = new NetworkBroker({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async (value) => {
        observed = value
        return { status: 200, headers: {}, body: 'ok' }
      },
    })

    assert.equal((await broker.request(request())).body, 'ok')
    assert.equal(observed?.address, '93.184.216.34')
    assert.equal(observed?.family, 4)
    assert.equal(observed?.url.hostname, 'public.example')
    assert.equal(observed?.hostHeader, 'public.example')
    assert.equal(observed?.tlsServername, 'public.example')
  })

  it('pins a validated IPv6 address without changing hostname authority', async () => {
    let observed: NetworkDialRequest | undefined
    const broker = new NetworkBroker({
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
      dial: async (value) => {
        observed = value
        return { status: 200, headers: {}, body: 'ipv6' }
      },
    })

    assert.equal((await broker.request(request())).body, 'ipv6')
    assert.equal(observed?.address, '2606:4700:4700::1111')
    assert.equal(observed?.family, 6)
    assert.equal(observed?.tlsServername, 'public.example')
  })

  it('resolves and pins again for every redirect, blocking a rebinding answer', async () => {
    let lookups = 0
    const dialed: string[] = []
    const broker = new NetworkBroker({
      lookup: async () => {
        lookups++
        return lookups === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }]
      },
      dial: async ({ address }): Promise<NetworkDialResponse> => {
        dialed.push(address)
        return { status: 302, headers: { location: '/next' }, body: '' }
      },
    })

    await assert.rejects(broker.request(request()), /禁止访问非公网地址/)
    assert.equal(lookups, 2)
    assert.deepEqual(dialed, ['93.184.216.34'])
  })

  it('checks redirect policy before resolving or dialing a new authority', async () => {
    const lookups: string[] = []
    let dials = 0
    const broker = new NetworkBroker({
      lookup: async (hostname) => {
        lookups.push(hostname)
        return [{ address: '93.184.216.34', family: 4 }]
      },
      dial: async () => {
        dials++
        return {
          status: 302,
          headers: { location: 'https://other.example/private' },
          body: '',
        }
      },
    })

    await assert.rejects(broker.request(request()), /超出已授权网络约束/)
    assert.deepEqual(lookups, ['public.example'])
    assert.equal(dials, 1)
  })

  it('bounds an injected dialer with the root cancellation signal', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const broker = new NetworkBroker({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async ({ signal }) => {
        observedSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const pending = broker.request({ ...request(), signal: controller.signal })
    while (!observedSignal) await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort(new DOMException('cancel broker', 'AbortError'))

    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(observedSignal.aborted, true)
  })

  it('enforces request timeout against an injected dialer', async () => {
    let observedSignal: AbortSignal | undefined
    const broker = new NetworkBroker({
      requestTimeoutMs: 20,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async ({ signal }) => {
        observedSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })

    await assert.rejects(broker.request(request()), { name: 'TimeoutError' })
    assert.equal(observedSignal?.aborted, true)
  })
})
