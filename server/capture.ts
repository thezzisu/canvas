import { randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { prepareLoopback } from './providers.ts'
import { sourceConnectionKey, type Source, type Store } from './state.ts'

const PREFIX = '/api/capture/'
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const unavailable = 'Captured application unavailable'

export interface CapturePresentation {
  type: 'capture'
  id: string
  url: string
  windowId: string
  paneId: string
  title: string
}
export interface CapturePreparation {
  windowId: string
  paneId: string
  session: string
  port: number
  title?: string
  onStop?(): void
  onEnded?(message: { type: 'capture-ended'; id: string; windowId: string; paneId: string }): void
}
export interface CaptureLease {
  id: string
  publicUrl: string
  ready(bootstrapUrl?: string): Promise<CapturePresentation>
  close(): void
}
interface Capture extends CapturePreparation {
  id: string
  source: Source
  sourceKey: string
  publicUrl: URL
  ready: boolean
  endpoint?: ReturnType<typeof prepareLoopback>
  closing?: Promise<void>
  cookies: Map<string, string>
  connections: Set<() => void>
}
export interface CaptureOptions {
  /** Public backend base, including any reverse-proxy mount. No inferred Host. */
  publicBase: string
  prepare?: typeof prepareLoopback
}

/** Explicitly trusted commands, bound to a live source/account lease.
 * Applications retain their own cookies and frame policy. This is not the
 * opaque preview proxy and must be embedded from a different frontend origin.
 */
export class CaptureService {
  private readonly captures = new Map<string, Capture>()
  private readonly publicBase: URL
  private readonly prepare: typeof prepareLoopback
  private closed = false
  private timer: ReturnType<typeof setInterval>
  constructor(private readonly store: Store, options: CaptureOptions) {
    this.publicBase = new URL(options.publicBase.endsWith('/') ? options.publicBase : options.publicBase + '/')
    if (!['http:', 'https:'].includes(this.publicBase.protocol) || this.publicBase.username || this.publicBase.password || this.publicBase.search || this.publicBase.hash)
      throw new Error('Capture public base must be an HTTP(S) backend URL')
    this.prepare = options.prepare || prepareLoopback
    store.on('sessions', this.prune); store.on('change', this.prune)
    this.timer = setInterval(this.prune, 1000); this.timer.unref()
  }
  prepareCapture(source: Source, options: CapturePreparation): CaptureLease {
    if (this.closed || !this.store.hasSession(options.session)) throw new Error('Please sign in')
    const current = this.store.get<Source>('source', source.id)
    if (!current || sourceConnectionKey(current) !== sourceConnectionKey(source)) throw new Error('Connection changed')
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Capture port must be between 1 and 65535')
    if (!options.windowId || !options.paneId || options.windowId.length > 4096 || options.paneId.length > 4096) throw new Error('Capture terminal identity is invalid')
    if (this.captures.size >= 32) throw new Error('At most 32 captured applications are supported')
    const id = randomBytes(32).toString('base64url')
    const publicUrl = new URL(this.publicBase.pathname.replace(/\/$/u, '') + PREFIX + id + '/', this.publicBase)
    const title = (options.title || 'Application').replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 160)
    const capture: Capture = { ...options, title, id, source: { ...source }, sourceKey: sourceConnectionKey(source), publicUrl, ready: false,
      cookies: new Map(), connections: new Set() }
    this.captures.set(id, capture)
    return { id, publicUrl: publicUrl.href, ready: async bootstrapUrl => {
      if (!this.valid(capture)) throw new Error('Capture expired')
      const url = this.bootstrap(capture, bootstrapUrl)
      // Open only this source's declared loopback service; no browser-host or
      // arbitrary origin input becomes a connection target.
      capture.endpoint ??= this.prepare(capture.source, '127.0.0.1', capture.port)
      await capture.endpoint
      if (!this.valid(capture)) throw new Error('Capture expired')
      capture.ready = true
      return { type: 'capture', id, url, windowId: capture.windowId, paneId: capture.paneId, title }
    }, close: () => { void this.remove(capture) } }
  }
  private bootstrap(capture: Capture, value?: string): string {
    if (!value) return capture.publicUrl.href
    if (value.length > 16384 || /[\x00-\x20\x7f]/u.test(value)) throw new Error('Invalid application bootstrap URL')
    const url = new URL(value)
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid application bootstrap URL')
    if (url.origin === capture.publicUrl.origin && url.pathname.startsWith(capture.publicUrl.pathname)) return url.href
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port || 80) !== capture.port)
      throw new Error('Application bootstrap URL does not match the captured service')
    return capture.publicUrl.href.replace(/\/$/u, '') + url.pathname + url.search + url.hash
  }
  private valid(capture: Capture): boolean {
    const source = this.store.get<Source>('source', capture.source.id)
    return !this.closed && this.captures.get(capture.id) === capture && this.store.hasSession(capture.session)
      && !!source && sourceConnectionKey(source) === capture.sourceKey
  }
  private prune = () => { for (const capture of this.captures.values()) if (!this.valid(capture)) void this.remove(capture) }
  private remove(capture: Capture): Promise<void> {
    if (capture.closing) return capture.closing
    if (this.captures.get(capture.id) === capture) this.captures.delete(capture.id)
    for (const cancel of capture.connections) cancel()
    capture.connections.clear()
    capture.ready = false
    capture.onEnded?.({ type: 'capture-ended', id: capture.id, windowId: capture.windowId, paneId: capture.paneId })
    capture.closing = (capture.endpoint || Promise.resolve(undefined)).then(endpoint => endpoint?.close(), () => {}).catch(() => {})
    return capture.closing
  }
  closeSource(sourceId: string): void { for (const capture of this.captures.values()) if (capture.source.id === sourceId) void this.remove(capture) }
  stop(id: string, session: string): boolean {
    const capture = this.captures.get(id)
    if (!capture || capture.session !== session || !this.valid(capture)) return false
    capture.onStop?.()
    return true
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    this.store.off('sessions', this.prune); this.store.off('change', this.prune)
    await Promise.all([...this.captures.values()].map(capture => this.remove(capture)))
  }
  private target(request: IncomingMessage): { capture: Capture; path: string } | undefined {
    const url = new URL(request.url || '/', 'http://canvas.invalid')
    const match = /^\/api\/capture\/([A-Za-z0-9_-]{43})(\/.*)?$/u.exec(url.pathname)
    const capture = match && this.captures.get(match[1]!)
    if (!capture || !capture.ready || !this.valid(capture)) return
    return { capture, path: (match![2] || '/') + url.search }
  }
  private requestHeaders(request: IncomingMessage, capture: Capture, upgrade = false): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {}
    const blocked = new Set([...hop, ...String(request.headers.connection || '').toLowerCase().split(/\s*,\s*/u),
      'cookie', 'authorization', 'host', 'origin', 'referer', 'forwarded'])
    for (const [name, value] of Object.entries(request.headers))
      if (!blocked.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('sec-fetch-')) headers[name] = value
    headers.host = capture.publicUrl.host
    if (request.headers.origin) headers.origin = capture.publicUrl.origin
    headers['x-forwarded-prefix'] = capture.publicUrl.pathname.replace(/\/$/u, '')
    headers['x-forwarded-proto'] = capture.publicUrl.protocol.slice(0, -1)
    // Browser cookie paths/names are scoped per capture. Only cookies issued by
    // this captured application are restored to its upstream names.
    const cookies: string[] = []
    for (const part of String(request.headers.cookie || '').split(';')) {
      const at = part.indexOf('='), name = part.slice(0, at).trim()
      const upstreamName = capture.cookies.get(name)
      if (at > 0 && upstreamName) cookies.push(upstreamName + '=' + part.slice(at + 1).trim())
    }
    if (cookies.length) headers.cookie = cookies.join('; ')
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    return headers
  }
  private responseHeaders(headers: IncomingMessage['headers'], capture: Capture, path: string): OutgoingHttpHeaders {
    const result: OutgoingHttpHeaders = {}
    const blocked = new Set([...hop, ...String(headers.connection || '').toLowerCase().split(/\s*,\s*/u), 'set-cookie', 'clear-site-data', 'service-worker-allowed'])
    for (const [name, value] of Object.entries(headers)) if (!blocked.has(name)) result[name] = value
    const rewritten: string[] = []
    for (const line of headers['set-cookie'] || []) {
      if (line.length > 16384) continue
      const parts = line.split(';'), at = parts[0]!.indexOf('='), originalName = parts[0]!.slice(0, at).trim()
      if (at < 1 || !cookieName.test(originalName)) continue
      const browserName = `cvcap-${capture.id}-${Buffer.from(originalName).toString('base64url')}`
      if (capture.cookies.size >= 64 && !capture.cookies.has(browserName)) continue
      capture.cookies.set(browserName, originalName)
      const attributes = parts.slice(1).filter(part => !/^\s*(?:domain|path|secure)(?:\s*=|\s*$)/iu.test(part))
      rewritten.push(browserName + parts[0]!.slice(at) + '; Path=' + capture.publicUrl.pathname +
        attributes.map(part => ';' + part).join('') + (capture.publicUrl.protocol === 'https:' ? '; Secure' : ''))
    }
    if (rewritten.length) result['set-cookie'] = rewritten
    if (headers.location) {
      try {
        const upstream = new URL(`http://127.0.0.1:${capture.port}`)
        const location = new URL(headers.location, upstream.origin + path)
        if (location.origin === upstream.origin || location.origin === capture.publicUrl.origin) {
          result.location = location.pathname.startsWith(capture.publicUrl.pathname) ? capture.publicUrl.origin + location.pathname + location.search + location.hash
            : capture.publicUrl.origin + capture.publicUrl.pathname.replace(/\/$/u, '') + location.pathname + location.search + location.hash
        }
      } catch { delete result.location }
    }
    result['cache-control'] = 'no-store'
    result['referrer-policy'] = 'no-referrer'
    result['x-content-type-options'] = 'nosniff'
    return result
  }
  private compatibleOrigin(request: IncomingMessage, capture: Capture): boolean {
    return !request.headers.origin || request.headers.origin === capture.publicUrl.origin
  }
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (!request.url?.startsWith(PREFIX)) return false
    const target = this.target(request)
    if (!target || ['CONNECT', 'TRACE'].includes(request.method || '') || !this.compatibleOrigin(request, target.capture)) {
      response.writeHead(404).end(unavailable); return true
    }
    const { capture, path } = target
    const cancel = () => response.destroy(); capture.connections.add(cancel)
    response.once('close', () => capture.connections.delete(cancel))
    void capture.endpoint!.then(transport => {
      if (response.destroyed || !this.valid(capture)) return cancel()
      const upstream = httpRequest({ ...transport, port: capture.port, method: request.method, path,
        headers: this.requestHeaders(request, capture), timeout: 30_000 }, incoming => {
        // The startup timeout must not terminate a healthy idle SSE stream.
        upstream.setTimeout(0)
        response.writeHead(incoming.statusCode || 502, this.responseHeaders(incoming.headers, capture, path))
        incoming.once('error', cancel); incoming.pipe(response)
      })
      response.once('close', () => upstream.destroy())
      upstream.once('timeout', () => upstream.destroy())
      upstream.once('error', () => { if (!response.headersSent) response.writeHead(502).end(unavailable); else cancel() })
      request.pipe(upstream)
    }).catch(() => { if (!response.headersSent) response.writeHead(502).end(unavailable); else cancel() })
    return true
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!request.url?.startsWith(PREFIX)) return false
    const target = this.target(request)
    if (!target || request.headers.upgrade?.toLowerCase() !== 'websocket' || !this.compatibleOrigin(request, target.capture)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return true
    }
    const { capture, path } = target
    let upstreamSocket: Duplex | undefined
    const cancel = () => socket.destroy(); capture.connections.add(cancel)
    socket.on('error', cancel)
    socket.once('close', () => { capture.connections.delete(cancel); upstreamSocket?.destroy() })
    void capture.endpoint!.then(transport => {
      if (socket.destroyed || !this.valid(capture)) return cancel()
      const upstream = httpRequest({ ...transport, port: capture.port, path, headers: this.requestHeaders(request, capture, true), timeout: 10_000 })
      socket.once('close', () => upstream.destroy())
      upstream.once('upgrade', (response, peer, remaining) => {
        upstream.setTimeout(0); peer.setTimeout(0)
        upstreamSocket = peer
        const headers = this.responseHeaders(response.headers, capture, path)
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).filter(([, value]) => value !== undefined)
          .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`)).join('\r\n') + '\r\n\r\n')
        if (remaining.length) socket.write(remaining)
        if (head.length) peer.write(head)
        peer.on('error', cancel); peer.once('close', cancel); socket.pipe(peer); peer.pipe(socket)
      })
      upstream.once('response', response => { response.destroy(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
      upstream.once('timeout', () => upstream.destroy()); upstream.once('error', cancel); upstream.end()
    }).catch(cancel)
    return true
  }
}
