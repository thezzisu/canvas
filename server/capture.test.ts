import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import { CaptureService, normalizeCapturePublicBase } from './capture.ts'
import { Store, type Source } from './state.ts'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  return { base: `http://127.0.0.1:${address.port}`, port: address.port }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cv-capture-test-')), store = new Store(join(root, 'state.db'))
  const source: Source = { id: 'source', name: 'Fixture', transport: 'local' }
  store.put('source', source); store.addSession('first'); store.addSession('other')
  const received: Array<{ url: string; headers: IncomingHttpHeaders; body?: string }> = []
  const upstreamSockets = new Set<import('node:net').Socket>()
  const upstream = createServer(async (req, res) => {
    const bytes: Buffer[] = []; for await (const part of req) bytes.push(Buffer.from(part))
    received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(bytes).toString() })
    if (req.url === '/pending') return
    if (req.url?.startsWith('/login')) {
      res.writeHead(303, { Location: './', 'Set-Cookie': 'session=application-only; Path=/; Domain=ignored.test; HttpOnly; SameSite=Strict' }).end(); return
    }
    const url = new URL(req.url!, 'http://fixture.invalid')
    if (url.pathname.endsWith('/set-cookies')) {
      res.writeHead(200, { 'Set-Cookie': url.searchParams.getAll('cookie') }).end(); return
    }
    if (url.pathname === '/authenticated' && !req.headers.cookie?.split('; ').includes('session=application-only')) {
      res.writeHead(401).end('Application authentication required'); return
    }
    if (req.url?.startsWith('/mounted-redirect?')) { res.writeHead(302, { Location: req.url.slice('/mounted-redirect?'.length) }).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'", 'X-Frame-Options': 'SAMEORIGIN' })
    res.end('<title>Captured fixture</title>')
  })
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)) })
  const wsServer = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    received.push({ url: req.url!, headers: req.headers })
    if (!req.headers.cookie?.split('; ').includes('session=application-only')) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    wsServer.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  })
  const target = await listen(upstream)
  let service: CaptureService
  // Simulate a reverse proxy stripping exactly its public mount before Canvas.
  const stripMount = (req: import('node:http').IncomingMessage) => { if (req.url?.startsWith('/operator/canvas/')) req.url = req.url.slice('/operator/canvas'.length) }
  const backend = createServer((req, res) => { stripMount(req); if (!service.handle(req, res)) res.writeHead(418).end() })
  backend.on('upgrade', (req, socket, head) => { stripMount(req); if (!service.handleUpgrade(req, socket, head)) socket.destroy() })
  const { base } = await listen(backend)
  let endpointsClosed = 0
  service = new CaptureService(store, { prepare: async (_source, host, port) => {
    assert.equal(host, '127.0.0.1'); assert.equal(port, target.port)
    return { hostname: host, close: async () => { endpointsClosed++ } }
  } })
  t.after(async () => {
    await service.close()
    for (const ws of wsServer.clients) ws.terminate()
    for (const socket of upstreamSockets) socket.destroy()
    wsServer.close(); backend.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => backend.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
    store.close(); await rm(root, { recursive: true, force: true })
  })
  return { store, source, service, base, target, received, endpointsClosed: () => endpointsClosed }
}

test('capture authenticates without browser cookies, preserves app frame policy and never forwards Canvas credentials', async t => {
  const f = await fixture(t)
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', title: 'Fixture' })
  const prepared = new URL(lease.publicUrl)
  assert.equal((await fetch(lease.publicUrl)).status, 404, 'prepared is not an active view before the owned command is ready')
  const presentation = await lease.ready(f.target.base + '/login?token=bootstrap-fixture')
  const auth = await fetch(presentation.url, { redirect: 'manual', headers: { Authorization: 'Bearer canvas-parent', Cookie: 'canvas=parent-cookie' } })
  assert.equal(auth.status, 303); assert.equal(auth.headers.get('location'), lease.publicUrl)
  assert.deepEqual(auth.headers.getSetCookie(), [], 'app credentials stay out of browser state and work through ingress stripping Cookie')
  assert.equal((await fetch(lease.publicUrl + 'authenticated')).status, 200, 'the proxy authenticates the next request without a browser Cookie header')
  const response = await fetch(lease.publicUrl + 'authenticated?q=%E4%B8%AD', { method: 'POST', body: '中文', headers: {
    Authorization: 'Bearer canvas-parent', Cookie: 'session=forged; canvas=parent-cookie', Origin: f.base,
  } })
  assert.equal(await response.text(), '<title>Captured fixture</title>')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', 'capture does not silently bypass an app refusing frames')
  const observed = f.received.at(-1)!
  assert.equal(response.status, 200); assert.equal(observed.url, '/authenticated?q=%E4%B8%AD'); assert.equal(observed.body, '中文')
  assert.equal(observed.headers.host, new URL(f.base).host); assert.equal(observed.headers.origin, f.base)
  assert.equal(observed.headers.authorization, undefined); assert.equal(observed.headers.cookie, 'session=application-only')
  const other = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'other', paneId: 'other', port: f.target.port, session: 'first' })
  await other.ready()
  assert.equal((await fetch(other.publicUrl + 'authenticated', { headers: { Cookie: 'session=application-only' } })).status, 401)
  assert.equal(f.received.at(-1)!.headers.cookie, undefined, 'another capture cannot inherit credentials or import them from browser cookies')
  const redirect = await fetch(lease.publicUrl + 'mounted-redirect?' + prepared.pathname + 'next', { redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), lease.publicUrl + 'next', 'already-prefixed redirects do not leak the upstream loopback origin')
  await assert.rejects(lease.ready('http://127.0.0.1:1/login'), /does not match/u)
})

test('capture WebSocket input uses app cookies and closes on account or source revocation', async t => {
  const f = await fixture(t), ended: string[] = []
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', onEnded: value => ended.push(value.id) })
  const app = await lease.ready(f.target.base + '/login')
  const response = await fetch(app.url, { redirect: 'manual' })
  assert.deepEqual(response.headers.getSetCookie(), [])
  const ws = new WebSocket(lease.publicUrl.replace(/^http/u, 'ws') + 'socket', { headers: { Authorization: 'Bearer parent', Origin: f.base } })
  t.after(() => ws.terminate()); await once(ws, 'open')
  const message = once(ws, 'message'); ws.send('actual app input'); assert.equal(String((await message)[0]), 'actual app input')
  assert.equal(f.received.at(-1)!.headers.cookie, 'session=application-only'); assert.equal(f.received.at(-1)!.headers.authorization, undefined)
  const closed = once(ws, 'close'); f.store.removeSession('first'); await closed
  assert.deepEqual(ended, [lease.id]); assert.equal((await fetch(lease.publicUrl)).status, 404)
  const next = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'next', paneId: 'next', port: f.target.port, session: 'other' })
  await next.ready()
  assert.equal((await fetch(next.publicUrl + 'authenticated')).status, 401, 'revoked application auth never carries into a new capture')
  f.store.put('source', { ...f.source, herdrSession: 'replacement' })
  assert.equal((await fetch(next.publicUrl)).status, 404)
})

test('only the owning session stops a capture and revocation also closes a pending launcher', async t => {
  const f = await fixture(t)
  assert.throws(() => f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'missing' }), /sign in/u)
  let stopped = 0, ended = 0
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first',
    onStop: () => { stopped++ }, onEnded: () => { ended++ } })
  assert.equal(f.service.stop(lease.id, 'other'), false); assert.equal(stopped, 0)
  assert.equal(f.service.stop(lease.id, 'first'), true); assert.equal(stopped, 1)
  f.store.removeSession('first')
  assert.equal(ended, 1, 'a preparing launcher is revoked too, before an iframe exists')
  assert.equal(f.service.stop(lease.id, 'first'), false)
  await assert.rejects(lease.ready(), /expired/u)
  lease.close(); assert.equal(ended, 1)
})

test('auto-port capture prepares its public mount before startup and binds only the reported source port', async t => {
  const f = await fixture(t)
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: 0, session: 'first' })
  assert.equal((await fetch(lease.publicUrl)).status, 404)
  await assert.rejects(lease.ready(), /listening port/u)
  assert.equal((await fetch(lease.publicUrl)).status, 404, 'an undiscovered service is never exposed')
  const presentation = await lease.ready(undefined, f.target.port)
  assert.equal(presentation.url, lease.publicUrl, 'the launch URL remains stable when the command selects its port')
  assert.equal(await (await fetch(lease.publicUrl)).text(), '<title>Captured fixture</title>')
  await assert.rejects(lease.ready(undefined, f.target.port === 65535 ? 65534 : f.target.port + 1), /cannot change/u)
  assert.equal(await (await fetch(lease.publicUrl)).text(), '<title>Captured fixture</title>', 'a later ready message cannot redirect the proxy to another listener')
})

test('each capture keeps its authenticated API mount through cookies, redirects and WebSocket routing', async t => {
  const f = await fixture(t)
  const options = { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first' }
  const root = f.service.prepareCapture(f.source, { ...options, publicBase: f.base })
  const mounted = f.service.prepareCapture(f.source, { ...options, publicBase: f.base + '/operator/canvas/' })
  const rootUrl = new URL(root.publicUrl), mountedUrl = new URL(mounted.publicUrl)
  assert.equal(rootUrl.origin, mountedUrl.origin, 'a mounted capture uses the same public server authority')
  assert.equal(rootUrl.pathname, `/api/capture/${root.id}/`)
  assert.equal(mountedUrl.pathname, `/operator/canvas/api/capture/${mounted.id}/`)
  const first = await root.ready(f.target.base + '/login'), second = await mounted.ready(f.target.base + '/login')
  const rootResponse = await fetch(first.url, { redirect: 'manual' })
  const response = await fetch(second.url, { redirect: 'manual' })
  assert.equal(rootResponse.headers.get('location'), root.publicUrl)
  assert.equal(response.headers.get('location'), mounted.publicUrl)
  assert.deepEqual(response.headers.getSetCookie(), [], 'mounted capture auth also stays on the server')
  const redirect = await fetch(mounted.publicUrl + 'mounted-redirect?' + mountedUrl.pathname + 'next', { redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), mounted.publicUrl + 'next')
  const ws = new WebSocket(mounted.publicUrl.replace(/^http/u, 'ws') + 'socket?q=1', { headers: { Cookie: 'session=forged', Origin: f.base } })
  t.after(() => ws.terminate()); await once(ws, 'open')
  const message = once(ws, 'message'); ws.send('mounted input'); assert.equal(String((await message)[0]), 'mounted input')
  assert.equal(f.received.at(-1)!.url, '/socket?q=1', 'the source application receives only its own path')
  assert.equal(f.received.at(-1)!.headers['x-forwarded-prefix'], mountedUrl.pathname.slice(0, -1))
  assert.equal(f.received.at(-1)!.headers.cookie, 'session=application-only')
  await (await fetch(root.publicUrl)).text()
  assert.equal(f.received.at(-1)!.headers['x-forwarded-prefix'], rootUrl.pathname.slice(0, -1), 'another capture cannot replace a previous capture base')

  assert.equal(normalizeCapturePublicBase(f.base), f.base + '/')
  assert.equal(normalizeCapturePublicBase(f.base + '/operator/canvas/'), f.base + '/operator/canvas/')
  const credentialBase = new URL(f.base)
  credentialBase.username = randomUUID()
  for (const invalid of [
    undefined, '', '/relative/', 'ftp://example.test/', credentialBase.href,
    f.base + '/operator//canvas/', f.base + '/operator/../canvas/', f.base + '/operator/./canvas/',
    f.base + '/operator%2Fcanvas/', f.base + '/operator/%2e%2e/canvas/', f.base + '/operator\\canvas/',
    f.base + '/operator/?q=1', f.base + '/operator/#part', f.base + '/operator/?',
  ]) assert.throws(() => f.service.prepareCapture(f.source, { ...options, publicBase: invalid as string }), /canonical HTTP/u)
})

test('application cookie paths, expiry and deletion apply to the logical public mount', async t => {
  const f = await fixture(t)
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base + '/operator/canvas/', windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first' })
  await lease.ready()
  const setCookies = async (cookies: string[], path = 'set-cookies') => {
    const url = new URL(lease.publicUrl + path)
    for (const cookie of cookies) url.searchParams.append('cookie', cookie)
    const response = await fetch(url)
    assert.deepEqual(response.headers.getSetCookie(), [])
    await response.text()
  }
  await setCookies([
    'session=application-only; Path=/; HttpOnly',
    'scoped=source-relative; Path=/private; HttpOnly',
    `public=forwarded-prefix; Path=${new URL(lease.publicUrl).pathname}private; HttpOnly`,
    'expired=unused; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'alive=max-age-wins; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'secure=https-only; Path=/; Secure',
  ])
  await setCookies(['default=directory; HttpOnly'], 'private/set-cookies')
  await (await fetch(lease.publicUrl + 'private/data')).text()
  assert.equal(f.received.at(-1)!.headers.cookie, 'scoped=source-relative; public=forwarded-prefix; default=directory; session=application-only; alive=max-age-wins')
  await (await fetch(lease.publicUrl + 'private-sibling')).text()
  assert.equal(f.received.at(-1)!.headers.cookie, 'session=application-only; alive=max-age-wins', 'a path prefix alone does not grant a sibling route the scoped cookies')
  await setCookies(['session=; Path=/; Max-Age=0', 'alive=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
  assert.equal((await fetch(lease.publicUrl + 'authenticated')).status, 401, 'cookie deletion removes application authentication')
  assert.equal(f.received.at(-1)!.headers.cookie, undefined)
})
