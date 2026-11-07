import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import { CaptureError, CaptureService } from './capture.ts'
import { normalizeCapturePublicBase } from './capture-address.ts'
import { Store, type Source } from './state.ts'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  return { base: `http://127.0.0.1:${address.port}`, port: address.port }
}
async function fixture(t: TestContext, onChange?: (sourceId: string, windowId: string) => void) {
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
    if (req.url?.startsWith('/mounted-redirect?')) { res.writeHead(302, { Location: decodeURIComponent(req.url.slice('/mounted-redirect?'.length)) }).end(); return }
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
  const stripMount = (req: import('node:http').IncomingMessage) => {
    if (req.url?.startsWith('/operator/canvas/')) {
      req.url = req.url.slice('/operator/canvas'.length)
      req.headers['x-forwarded-prefix'] = '/operator/canvas'
    }
  }
  const backend = createServer((req, res) => { stripMount(req); if (!service.handle(req, res)) res.writeHead(418).end() })
  backend.on('upgrade', (req, socket, head) => { stripMount(req); if (!service.handleUpgrade(req, socket, head)) socket.destroy() })
  const { base } = await listen(backend)
  let endpointsClosed = 0
  service = new CaptureService(store, { onChange, prepare: async (_source, host, port) => {
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
  for (const host of ['localhost', '127.0.0.1']) {
    const redirect = await fetch(lease.publicUrl + 'mounted-redirect?' + encodeURIComponent(`http://${host}:${f.target.port}/next?q=1`), { redirect: 'manual' })
    assert.equal(redirect.headers.get('location'), lease.publicUrl + 'next?q=1', 'same-service redirects remain on the public capture mount')
  }
  const external = 'https://external.example/help'
  assert.equal((await fetch(lease.publicUrl + 'mounted-redirect?' + encodeURIComponent(external), { redirect: 'manual' })).headers.get('location'), external)
  await assert.rejects(lease.ready(f.target.base + '/?q=' + '中'.repeat(6000)), /Invalid application bootstrap URL/u)
  await assert.rejects(lease.ready('http://127.0.0.1:1/login'), /does not match/u)
})

test('capture WebSocket input uses app cookies and closes on account or source revocation', async t => {
  const f = await fixture(t), ended: string[] = []
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', onEnded: () => ended.push(lease.id) })
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

test('authenticated sessions share capture stop while creator revocation still closes a pending launcher', async t => {
  const f = await fixture(t)
  assert.throws(() => f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'missing' }), /sign in/u)
  let stopped = 0, ended = 0
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first',
    onStop: () => { stopped++ }, onEnded: () => { ended++ } })
  assert.equal(f.service.stop(lease.id, 'missing'), false); assert.equal(stopped, 0)
  assert.equal(f.service.stop(lease.id, 'other'), true); assert.equal(stopped, 1)
  f.store.removeSession('first')
  assert.equal(ended, 1, 'a preparing launcher is revoked too, before an iframe exists')
  assert.equal(f.service.stop(lease.id, 'first'), false)
  await assert.rejects(lease.ready(), /expired/u)
  lease.close(); assert.equal(ended, 1)
})

test('capture fixes its source port before startup and exposes it only after readiness', async t => {
  const f = await fixture(t)
  const options = { publicBase: f.base, windowId: 'window', paneId: 'pane', session: 'first' }
  for (const port of [0, -1, 65536, 1.5]) assert.throws(() => f.service.prepareCapture(f.source, { ...options, port }), /port must be/u)
  const lease = f.service.prepareCapture(f.source, { ...options, port: f.target.port })
  assert.equal((await fetch(lease.publicUrl)).status, 404)
  const presentation = await lease.ready()
  assert.equal(presentation.url, lease.publicUrl, 'the prepared launch URL remains stable')
  assert.equal(await (await fetch(lease.publicUrl)).text(), '<title>Captured fixture</title>')
  await assert.rejects(lease.ready('http://127.0.0.1:1/'), /does not match/u)
  assert.equal(await (await fetch(lease.publicUrl)).text(), '<title>Captured fixture</title>', 'a later ready message cannot redirect the proxy to another listener')
})

test('one pending or ready capture owns a native window until cleanup permits a new command', async t => {
  const changes: Array<[string, string]> = []
  const f = await fixture(t, (source, window) => changes.push([source, window]))
  const options = { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', title: 'Shared app' }
  const first = f.service.prepareCapture(f.source, options)
  const duplicate = () => assert.throws(() => f.service.prepareCapture(f.source, { ...options, session: 'other' }),
    (error: unknown) => error instanceof CaptureError && error.reason === 'capture-already-active')
  duplicate()
  assert.equal(f.service.current(f.source.id, 'window'), null, 'preparing apps are not presented')
  await first.ready(f.target.base + '/launch?q=one#anchor')
  duplicate()
  assert.deepEqual(f.service.current(f.source.id, 'window'), { id: first.id, path: '/launch?q=one#anchor', title: 'Shared app', windowId: 'window', paneId: 'pane' })
  assert.equal(f.service.current(f.source.id, 'another'), null)
  first.close()
  assert.equal(f.service.current(f.source.id, 'window'), null, 'the snapshot is absent immediately on closure')
  const next = f.service.prepareCapture(f.source, { ...options, preview: 'static' })
  await next.ready()
  assert.equal(f.service.current(f.source.id, 'window')?.id, next.id)
  assert.equal(f.service.current(f.source.id, 'window')?.preview, 'static')
  first.close()
  assert.equal(f.service.current(f.source.id, 'window')?.id, next.id, 'late old-lease cleanup never clears a replacement')
  assert.deepEqual(changes, [['source', 'window'], ['source', 'window'], ['source', 'window']])
})

test('a shared capture follows each viewer API authority and mount for HTTP, cookies and WebSockets', async t => {
  const f = await fixture(t)
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first' })
  await lease.ready(f.target.base + '/login')
  await (await fetch(lease.publicUrl + 'login', { redirect: 'manual' })).text()
  const viewerOrigin = 'https://viewer.example', viewerBase = `${viewerOrigin}/operator/canvas/api/capture/${lease.id}/`
  const requestUrl = `${f.base}/operator/canvas/api/capture/${lease.id}/`
  const headers = { 'x-forwarded-host': 'viewer.example', 'x-forwarded-proto': 'https', Origin: viewerOrigin }
  const redirect = await fetch(requestUrl + 'mounted-redirect?' + encodeURIComponent(lease.publicUrl + 'next?q=one'), { headers, redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), viewerBase + 'next?q=one', 'creator-prefixed redirects remain on the viewing endpoint')
  assert.equal((await fetch(requestUrl + 'authenticated', { method: 'POST', body: 'input', headers })).status, 200)
  assert.equal(f.received.at(-1)!.headers.host, 'viewer.example')
  assert.equal(f.received.at(-1)!.headers.origin, viewerOrigin)
  assert.equal(f.received.at(-1)!.headers['x-forwarded-prefix'], new URL(viewerBase).pathname.slice(0, -1))
  assert.equal(f.received.at(-1)!.headers.cookie, 'session=application-only', 'capture cookie paths survive a different viewer prefix')
  const before = f.received.length
  assert.equal((await fetch(requestUrl, { headers: { ...headers, Origin: 'https://unrelated.example' } })).status, 404)
  assert.equal((await fetch(requestUrl, { headers: { ...headers, 'x-forwarded-host': 'one.example,two.example' } })).status, 404)
  assert.equal(f.received.length, before, 'mismatched or ambiguous origins never reach the app')
  const ws = new WebSocket(requestUrl.replace(/^http/u, 'ws') + 'socket', { headers })
  t.after(() => ws.terminate()); await once(ws, 'open')
  const message = once(ws, 'message'); ws.send('alternate viewer'); assert.equal(String((await message)[0]), 'alternate viewer')
  assert.equal(f.received.at(-1)!.headers.host, 'viewer.example')
  assert.equal(f.received.at(-1)!.headers['x-forwarded-prefix'], new URL(viewerBase).pathname.slice(0, -1))
})

test('each capture keeps its authenticated API mount through cookies, redirects and WebSocket routing', async t => {
  const f = await fixture(t)
  const options = { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first' }
  const root = f.service.prepareCapture(f.source, { ...options, publicBase: f.base })
  const mounted = f.service.prepareCapture(f.source, { ...options, windowId: 'mounted', publicBase: f.base + '/operator/canvas/' })
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
  ]) assert.throws(() => f.service.prepareCapture(f.source, { ...options, windowId: 'invalid', publicBase: invalid as string }), /canonical HTTP/u)
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


test('capture cleanup runs once when its owner also closes the lease from onEnded', async t => {
  const f = await fixture(t)
  let ended = 0
  const lease = f.service.prepareCapture(f.source, { publicBase: f.base, session: 'first', port: f.target.port,
    onEnded: () => { ended++; lease.close() } })
  await lease.ready()
  f.store.removeSession('first')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended, 1)
  assert.equal(f.endpointsClosed(), 1)
})

test('only explicit static Markdown document navigations select the frontend, while raw files and HTML remain untouched', async t => {
  const f = await fixture(t)
  const navigate = (url: string, headers: Record<string, string> = { 'sec-fetch-mode': 'navigate' }) => new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(url, { headers }, response => {
      response.resume(); resolve({ status: response.statusCode!, headers: response.headers })
    }); req.once('error', reject); req.end()
  })
  const options = { publicBase: f.base + '/operator/canvas/', session: 'first', port: f.target.port }
  const preview = f.service.prepareCapture(f.source, { ...options, preview: 'static' })
  await preview.ready()
  const target = preview.publicUrl + 'docs/readme.md'
  const navigation = await navigate(target)
  assert.equal(navigation.status, 302)
  const viewer = new URL(navigation.headers.location!)
  assert.equal(viewer.pathname, `/operator/canvas/api/document/${preview.id}/`)
  assert.equal(viewer.searchParams.get('path'), '/docs/readme.md')
  assert.equal((await navigate(target, { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' })).status, 302,
    'plain LAN HTTP browsers may omit Fetch Metadata headers')
  assert.equal((await navigate(target, { 'sec-fetch-mode': 'cors', accept: 'text/html' })).status, 200,
    'an explicit fetch is not document navigation')
  assert.equal(f.service.hasStaticPreview(preview.id), true)
  for (const path of ['page.html', 'docs/readme.md?canvas=raw', 'docs/readme.md?canvas=download'])
    assert.equal((await navigate(preview.publicUrl + path)).status, 200)
  assert.equal((await fetch(target)).status, 200, 'fetch receives original bytes')
  const ordinary = f.service.prepareCapture(f.source, options); await ordinary.ready()
  assert.equal((await navigate(ordinary.publicUrl + 'readme.md')).status, 200)
  f.store.removeSession('first'); assert.equal(f.service.hasStaticPreview(preview.id), false)
})

test('capture failures preserve their specific public category', async t => {
  const f = await fixture(t)
  const options = { publicBase: f.base, windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first' }
  const reason = (expected: string) => (error: unknown) => error instanceof CaptureError && error.reason === expected
  assert.throws(() => f.service.prepareCapture(f.source, { ...options, session: 'missing' }), reason('capture-sign-in'))
  assert.throws(() => f.service.prepareCapture(f.source, { ...options, port: 0 }), reason('capture-invalid-request'))
  const lease = f.service.prepareCapture(f.source, options)
  for (const url of ['not-a-url', 'http://127.0.0.1:1/'])
    await assert.rejects(lease.ready(url), reason('capture-bootstrap-invalid'))
  for (let index = 1; index < 32; index++) f.service.prepareCapture(f.source, { ...options, windowId: `window-${index}` })
  assert.throws(() => f.service.prepareCapture(f.source, { ...options, windowId: 'overflow' }), reason('capture-limit'))
  f.store.removeSession('first')
  await assert.rejects(lease.ready(), reason('capture-expired'))
  f.store.put('source', { ...f.source, transport: 'ssh', target: 'changed.invalid' })
  f.store.addSession('first')
  assert.throws(() => f.service.prepareCapture(f.source, options), reason('capture-connection-changed'))
  const failing = new CaptureService(f.store, { prepare: async () => { throw new Error('PRIVATE_FORWARD_DETAIL') } })
  t.after(() => failing.close())
  f.store.put('source', f.source)
  await assert.rejects(failing.prepareCapture(f.source, options).ready(), reason('capture-forward-unavailable'))
  await failing.close()
  assert.throws(() => failing.prepareCapture(f.source, options), reason('capture-stopping'))
})
