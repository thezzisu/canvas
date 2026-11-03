import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import { CaptureService } from './capture.ts'
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
    if (req.url?.startsWith('/mounted-redirect?')) { res.writeHead(302, { Location: req.url.slice('/mounted-redirect?'.length) }).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'", 'X-Frame-Options': 'SAMEORIGIN' })
    res.end('<title>Captured fixture</title>')
  })
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)) })
  const wsServer = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    received.push({ url: req.url!, headers: req.headers })
    wsServer.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  })
  const target = await listen(upstream)
  let service: CaptureService
  const backend = createServer((req, res) => { if (!service.handle(req, res)) res.writeHead(418).end() })
  backend.on('upgrade', (req, socket, head) => { if (!service.handleUpgrade(req, socket, head)) socket.destroy() })
  const { base } = await listen(backend)
  let endpointsClosed = 0
  service = new CaptureService(store, { publicBase: base, prepare: async (_source, host, port) => {
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

test('capture scopes application cookies, preserves app frame policy and never forwards Canvas credentials', async t => {
  const f = await fixture(t)
  const lease = f.service.prepareCapture(f.source, { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', title: 'Fixture' })
  const prepared = new URL(lease.publicUrl)
  assert.equal((await fetch(lease.publicUrl)).status, 404, 'prepared is not an active view before the owned command is ready')
  const presentation = await lease.ready(f.target.base + '/login?token=bootstrap-fixture')
  const auth = await fetch(presentation.url, { redirect: 'manual', headers: { Authorization: 'Bearer canvas-parent', Cookie: 'canvas=parent-cookie' } })
  assert.equal(auth.status, 303); assert.equal(auth.headers.get('location'), lease.publicUrl)
  const cookie = auth.headers.getSetCookie()[0]!
  assert(cookie.includes('Path=' + prepared.pathname)); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Strict'))
  assert(!cookie.includes('Domain=')); assert(!cookie.startsWith('session='))
  const applicationCookie = cookie.split(';')[0]!
  const response = await fetch(lease.publicUrl + 'api?q=%E4%B8%AD', { method: 'POST', body: '中文', headers: {
    Authorization: 'Bearer canvas-parent', Cookie: applicationCookie + '; canvas=parent-cookie', Origin: f.base,
  } })
  assert.equal(await response.text(), '<title>Captured fixture</title>')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', 'capture does not silently bypass an app refusing frames')
  const observed = f.received.at(-1)!
  assert.equal(observed.url, '/api?q=%E4%B8%AD'); assert.equal(observed.body, '中文')
  assert.equal(observed.headers.host, new URL(f.base).host); assert.equal(observed.headers.origin, f.base)
  assert.equal(observed.headers.authorization, undefined); assert.equal(observed.headers.cookie, 'session=application-only')
  const other = f.service.prepareCapture(f.source, { windowId: 'other', paneId: 'other', port: f.target.port, session: 'first' })
  await other.ready()
  await (await fetch(other.publicUrl, { headers: { Cookie: applicationCookie } })).text()
  assert.equal(f.received.at(-1)!.headers.cookie, undefined, 'another app cannot reuse the first capture cookie mapping')
  const redirect = await fetch(lease.publicUrl + 'mounted-redirect?' + prepared.pathname + 'next', { redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), lease.publicUrl + 'next', 'already-prefixed redirects do not leak the upstream loopback origin')
  await assert.rejects(lease.ready('http://127.0.0.1:1/login'), /does not match/u)
})

test('capture WebSocket input uses app cookies and closes on account or source revocation', async t => {
  const f = await fixture(t), ended: string[] = []
  const lease = f.service.prepareCapture(f.source, { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first', onEnded: value => ended.push(value.id) })
  const app = await lease.ready(f.target.base + '/login')
  const response = await fetch(app.url, { redirect: 'manual' }), cookie = response.headers.getSetCookie()[0]!.split(';')[0]!
  const ws = new WebSocket(lease.publicUrl.replace(/^http/u, 'ws') + 'socket', { headers: { Cookie: cookie + '; parent=not-forwarded', Authorization: 'Bearer parent', Origin: f.base } })
  t.after(() => ws.terminate()); await once(ws, 'open')
  const message = once(ws, 'message'); ws.send('actual app input'); assert.equal(String((await message)[0]), 'actual app input')
  assert.equal(f.received.at(-1)!.headers.cookie, 'session=application-only'); assert.equal(f.received.at(-1)!.headers.authorization, undefined)
  const closed = once(ws, 'close'); f.store.removeSession('first'); await closed
  assert.deepEqual(ended, [lease.id]); assert.equal((await fetch(lease.publicUrl)).status, 404)
  const next = f.service.prepareCapture(f.source, { windowId: 'next', paneId: 'next', port: f.target.port, session: 'other' })
  await next.ready(); f.store.put('source', { ...f.source, herdrSession: 'replacement' })
  assert.equal((await fetch(next.publicUrl)).status, 404)
})

test('only the owning session stops a capture and revocation also closes a pending launcher', async t => {
  const f = await fixture(t)
  assert.throws(() => f.service.prepareCapture(f.source, { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'missing' }), /sign in/u)
  let stopped = 0, ended = 0
  const lease = f.service.prepareCapture(f.source, { windowId: 'window', paneId: 'pane', port: f.target.port, session: 'first',
    onStop: () => { stopped++ }, onEnded: () => { ended++ } })
  assert.equal(f.service.stop(lease.id, 'other'), false); assert.equal(stopped, 0)
  assert.equal(f.service.stop(lease.id, 'first'), true); assert.equal(stopped, 1)
  f.store.removeSession('first')
  assert.equal(ended, 1, 'a preparing launcher is revoked too, before an iframe exists')
  assert.equal(f.service.stop(lease.id, 'first'), false)
  await assert.rejects(lease.ready(), /expired/u)
  lease.close(); assert.equal(ended, 1)
})
