import { randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { prepareLoopback } from './providers.ts'
import { isLoopbackHost } from './loopback.ts'
import { sourceConnectionKey, type Source, type Store } from './state.ts'

const PREFIX = '/api/forward/'
const IDLE = 30 * 60_000
const SANDBOX = "sandbox allow-scripts allow-forms allow-downloads allow-popups allow-modals; object-src 'none'"
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function webUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value)) throw new Error('Invalid web address')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address')
  return url
}
export function loopbackHost(url: URL): string | undefined {
  const host = url.hostname.toLowerCase()
  if (host === '[::1]' || host === '[::]') return '::1'
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return '127.0.0.1'
  if (isLoopbackHost(host)) return host
}
interface Grant {
  id: string; session: string; sourceId: string; sourceKey: string; origin: string
  host: string; port: number; protocol: string; used: number; active: number
  connections: Set<() => void>
}
interface Endpoint { users: Set<string>; ready: ReturnType<typeof prepareLoopback>; closing?: Promise<void> }
export interface OpenedUrl { url: string; forwarded: boolean }

/** Only a registered source's loopback service is reachable through a scoped grant. */
export class UrlForwardService {
  private grants = new Map<string, Grant>()
  private endpoints = new Map<string, Endpoint>()
  private timer: ReturnType<typeof setInterval>
  private closing?: Promise<void>
  constructor(private readonly store: Store, private readonly prepare = prepareLoopback, private readonly now = Date.now) {
    store.on('sessions', this.prune); store.on('change', this.prune)
    this.timer = setInterval(this.prune, 60_000); this.timer.unref()
  }
  open(source: Source, value: unknown, session: string): OpenedUrl {
    if (this.closing) throw new Error('Web service closed')
    if (!this.store.hasSession(session)) throw new Error('Please sign in')
    const current = this.store.get<Source>('source', source.id)
    if (!current || sourceConnectionKey(current) !== sourceConnectionKey(source)) throw new Error('Connection changed')
    this.prune()
    const url = webUrl(value), host = loopbackHost(url)
    if (!host) return { url: url.href, forwarded: false }
    const sourceKey = sourceConnectionKey(source), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    let grant = [...this.grants.values()].find(g => g.session === session && g.sourceId === source.id && g.sourceKey === sourceKey && g.origin === url.origin)
    if (!grant) {
      if (this.grants.size >= 64) throw new Error('Too many open web services')
      grant = { id: randomBytes(32).toString('base64url'), session, sourceId: source.id, sourceKey,
        origin: url.origin, host, port, protocol: url.protocol, used: this.now(), active: 0, connections: new Set() }
      this.grants.set(grant.id, grant)
    }
    grant.used = this.now()
    return { url: `${PREFIX}${grant.id}${url.pathname}${url.search}${url.hash}`, forwarded: true }
  }
  private key(grant: Grant) { return `${grant.sourceId}:${grant.sourceKey}:${grant.host}:${grant.port}` }
  private valid(grant: Grant) {
    const source = this.store.get<Source>('source', grant.sourceId)
    return this.store.hasSession(grant.session) && !!source && sourceConnectionKey(source) === grant.sourceKey
      && (grant.active > 0 || this.now() - grant.used < IDLE)
  }
  private release(key: string, endpoint: Endpoint) {
    return endpoint.closing ??= endpoint.ready.then(value => value.close(), () => {}).catch(() => {}).finally(() => {
      if (this.endpoints.get(key) === endpoint) this.endpoints.delete(key)
    })
  }
  private remove(grant: Grant) {
    this.grants.delete(grant.id)
    for (const cancel of grant.connections) cancel()
    const key = this.key(grant), endpoint = this.endpoints.get(key)
    endpoint?.users.delete(grant.id)
    if (endpoint && !endpoint.users.size) void this.release(key, endpoint)
  }
  private prune = () => { for (const grant of this.grants.values()) if (!this.valid(grant)) this.remove(grant) }
  closeSource(sourceId: string) { for (const grant of this.grants.values()) if (grant.sourceId === sourceId) this.remove(grant) }
  close() {
    return this.closing ??= (async () => {
      clearInterval(this.timer); this.store.off('sessions', this.prune); this.store.off('change', this.prune)
      for (const grant of [...this.grants.values()]) this.remove(grant)
      await Promise.all([...this.endpoints].map(([key, endpoint]) => this.release(key, endpoint)))
    })()
  }
  private target(request: IncomingMessage) {
    const url = new URL(request.url || '/', 'http://canvas.invalid')
    const match = /^\/api\/forward\/([A-Za-z0-9_-]{43})(\/.*)?$/u.exec(url.pathname)
    const grant = match && this.grants.get(match[1]!)
    if (!grant) return
    if (!this.valid(grant)) { this.remove(grant); return }
    grant.used = this.now()
    return { grant, path: (match![2] || '/') + url.search }
  }
  private async endpoint(grant: Grant) {
    const key = this.key(grant)
    let endpoint = this.endpoints.get(key)
    if (endpoint?.closing) { await endpoint.closing; endpoint = this.endpoints.get(key) }
    if (!this.grants.has(grant.id) || !this.valid(grant)) throw new Error('Web service expired')
    if (!endpoint) {
      const source = this.store.get<Source>('source', grant.sourceId)
      if (!source || !this.valid(grant)) throw new Error('Web service expired')
      endpoint = { users: new Set(), ready: this.prepare(source, grant.host, grant.port) }
      this.endpoints.set(key, endpoint)
      endpoint.ready.catch(() => { if (this.endpoints.get(key) === endpoint) this.endpoints.delete(key) })
    }
    endpoint.users.add(grant.id)
    const transport = await endpoint.ready
    if (!this.grants.has(grant.id) || !this.valid(grant)) throw new Error('Web service expired')
    return transport
  }
  private headers(request: IncomingMessage, grant: Grant, upgrade = false): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {}
    const blocked = new Set([...hop, ...String(request.headers.connection || '').toLowerCase().split(/\s*,\s*/u), 'cookie', 'authorization', 'host', 'origin', 'referer', 'forwarded'])
    for (const [name, value] of Object.entries(request.headers)) if (!blocked.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('sec-fetch-')) headers[name] = value
    headers.host = new URL(grant.origin).host
    if (request.headers.origin) headers.origin = grant.origin
    headers['x-forwarded-prefix'] = this.prefix(request, grant)
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    return headers
  }
  private prefix(request: IncomingMessage, grant: Grant) {
    const prefix = request.headers['x-forwarded-prefix']
    return (typeof prefix === 'string' && /^(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(prefix) ? prefix.replace(/\/$/u, '') : '') + PREFIX + grant.id
  }
  private responseHeaders(headers: IncomingMessage['headers'], request: IncomingMessage, grant: Grant, path: string): OutgoingHttpHeaders {
    const result: OutgoingHttpHeaders = {}
    const blocked = new Set([...hop, ...String(headers.connection || '').toLowerCase().split(/\s*,\s*/u),
      'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
      'access-control-allow-credentials', 'access-control-allow-origin', 'clear-site-data', 'service-worker-allowed'])
    for (const [name, value] of Object.entries(headers)) {
      if (!blocked.has(name)) result[name] = value
    }
    if (headers.location) {
      try {
        const location = new URL(headers.location, grant.origin + path)
        if (location.origin === grant.origin) result.location = this.prefix(request, grant) + location.pathname + location.search + location.hash
      } catch { delete result.location }
    }
    result['content-security-policy'] = SANDBOX
    result['cross-origin-resource-policy'] = 'cross-origin'
    result['access-control-allow-origin'] = '*'
    result['referrer-policy'] = 'no-referrer'
    result['cache-control'] = 'no-store'
    result['x-content-type-options'] = 'nosniff'
    return result
  }
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (!request.url?.startsWith(PREFIX)) return false
    const target = this.target(request)
    if (!target || ['CONNECT', 'TRACE'].includes(request.method || '')) { response.writeHead(404).end('Web service unavailable'); return true }
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With', 'Access-Control-Max-Age': '600' }).end(); return true
    }
    const { grant, path } = target
    grant.active++
    const cancel = () => response.destroy()
    grant.connections.add(cancel)
    let done = false
    const finish = () => { if (done) return; done = true; grant.active--; grant.used = this.now(); grant.connections.delete(cancel) }
    response.once('close', finish)
    void this.endpoint(grant).then(transport => {
      if (response.destroyed) return
      const upstream = (grant.protocol === 'https:' ? httpsRequest : httpRequest)({ ...transport, port: grant.port,
        servername: new URL(grant.origin).hostname.replace(/^\[|\]$/gu, ''), method: request.method, path,
        headers: this.headers(request, grant), timeout: 30_000 }, incoming => {
        response.writeHead(incoming.statusCode || 502, this.responseHeaders(incoming.headers, request, grant, path))
        incoming.once('error', () => response.destroy())
        incoming.pipe(response)
      })
      response.once('close', () => upstream.destroy())
      upstream.once('timeout', () => upstream.destroy(new Error('Web service timed out')))
      upstream.once('error', () => { if (response.destroyed) return; if (!response.headersSent) response.writeHead(502).end('Web service unavailable'); else response.destroy() })
      request.pipe(upstream)
    }).catch(() => { if (response.destroyed) return; if (!response.headersSent) response.writeHead(502).end('Web service unavailable'); else response.destroy() })
    return true
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!request.url?.startsWith(PREFIX)) return false
    const target = this.target(request)
    if (!target || request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return true }
    const { grant, path } = target
    grant.active++
    const cancel = () => socket.destroy()
    grant.connections.add(cancel)
    let upstreamSocket: Duplex | undefined
    socket.on('error', cancel)
    socket.once('close', () => { grant.active--; grant.used = this.now(); grant.connections.delete(cancel); upstreamSocket?.destroy() })
    void this.endpoint(grant).then(transport => {
      if (socket.destroyed) return
      const upstream = (grant.protocol === 'https:' ? httpsRequest : httpRequest)({ ...transport, port: grant.port,
        servername: new URL(grant.origin).hostname.replace(/^\[|\]$/gu, ''), path,
        headers: this.headers(request, grant, true), timeout: 10_000 })
      socket.once('close', () => upstream.destroy())
      upstream.on('upgrade', (response, peer, remaining) => {
        upstreamSocket = peer
        const headers = this.responseHeaders(response.headers, request, grant, path)
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n\r\n')
        if (remaining.length) socket.write(remaining)
        if (head.length) peer.write(head)
        peer.on('error', cancel); peer.once('close', cancel)
        socket.pipe(peer); peer.pipe(socket)
      })
      upstream.once('response', response => { response.destroy(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
      upstream.once('timeout', () => upstream.destroy())
      upstream.once('error', () => socket.destroy())
      upstream.end()
    }).catch(() => socket.destroy())
    return true
  }
}
