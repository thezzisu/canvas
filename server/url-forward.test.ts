import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import { UrlForwardService, loopbackHost, webUrl } from './url-forward.ts'
import { Store, type Source } from './state.ts'
import type { prepareLoopback } from './providers.ts'

async function listen(server: Server, host = '127.0.0.1') {
  await new Promise<void>(resolve => server.listen(0, host, resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  return { port: address.port, base: `http://${host}:${address.port}` }
}
async function fixture(t: TestContext, prepare?: typeof prepareLoopback, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-forward-')), store = new Store(join(directory, 'state.db'))
  const source: Source = { id: 'source', name: 'Fixture', transport: 'local' }
  store.put('source', source); store.addSession('first'); store.addSession('second')
  const service = new UrlForwardService(store, prepare, now)
  const server = createServer((req, res) => { if (!service.handle(req, res)) res.writeHead(418).end('Other route') })
  server.on('upgrade', (req, socket, head) => { if (!service.handleUpgrade(req, socket, head)) socket.destroy() })
  const { base } = await listen(server)
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { store, source, service, base }
}
async function upstream(t: TestContext, host = '127.0.0.1') {
  const received: Array<{ url: string; method: string; headers: IncomingHttpHeaders; body: string }> = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received.push({ url: req.url!, method: req.method!, headers: req.headers, body: Buffer.concat(chunks).toString() })
    if (req.url === '/pending') return
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/next?x=1#item' }).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'upstream=secret',
      'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin', 'Clear-Site-Data': '"*"',
      'Service-Worker-Allowed': '/', 'Access-Control-Allow-Credentials': 'true', 'Connection': 'X-Hop', 'X-Hop': 'private' })
    res.end('<!doctype html><title>Fixture</title>')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const wsServer = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    received.push({ url: req.url!, method: req.method!, headers: req.headers, body: '' })
    if (req.url === '/no-upgrade') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    wsServer.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  })
  const address = await listen(server, host)
  t.after(async () => { for (const socket of sockets) socket.destroy(); for (const ws of wsServer.clients) ws.terminate(); wsServer.close(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { ...address, received, server, wsServer, sockets }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() > deadline) assert.fail('Fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('forward grants require a live account and registered source, and never proxy non-loopback URLs', async t => {
  const f = await fixture(t)
  assert.throws(() => f.service.open(f.source, 'http://localhost:8080', 'missing'), /sign in/u)
  assert.throws(() => f.service.open({ ...f.source, id: 'missing' }, 'http://localhost:8080', 'first'), /Connection changed/u)
  assert.deepEqual(f.service.open(f.source, 'https://example.test/app', 'first'), { url: 'https://example.test/app', forwarded: false })
  for (const value of ['file:///tmp', 'ftp://localhost', 'http://user:DUMMY_PASSWORD@localhost', 'http://localhost/a\nb']) assert.throws(() => webUrl(value))
  assert.equal(loopbackHost(webUrl('http://localhost.evil.test')), undefined)
  assert.equal(loopbackHost(webUrl('http://0.0.0.0:8080')), '127.0.0.1')
  assert.equal(loopbackHost(webUrl('http://[::]:8080')), '::1')
  assert.equal((await fetch(`${f.base}/api/forward/${'a'.repeat(43)}/`)).status, 404)
  assert.equal((await fetch(`${f.base}/unrelated`)).status, 418)
})

test('HTTP proxy preserves path, query and body while stripping credentials and sandboxing the response', async t => {
  const target = await upstream(t), f = await fixture(t)
  const opened = f.service.open(f.source, `http://localhost:${target.port}/nested/a%20b?q=%2F#fragment`, 'first')
  assert.equal(opened.forwarded, true); assert.match(opened.url, /^\/api\/forward\/[A-Za-z0-9_-]{43}\//u)
  const response = await fetch(f.base + opened.url, { method: 'POST', body: 'payload=中文', headers: {
    Authorization: 'Bearer parent-token', Cookie: 'forgejo=parent-cookie', Origin: 'https://git.example.test',
    Referer: 'https://git.example.test/private', Forwarded: 'host=wrong', 'X-Forwarded-Host': 'wrong',
    'X-Forwarded-Prefix': '/_et/canvas', 'Content-Type': 'application/x-www-form-urlencoded',
  } })
  assert.equal(response.status, 200); assert.match(await response.text(), /Fixture/u)
  const received = target.received[0]!
  assert.equal(received.url, '/nested/a%20b?q=%2F'); assert.equal(received.body, 'payload=中文'); assert.equal(received.method, 'POST')
  assert.equal(received.headers.host, `localhost:${target.port}`); assert.equal(received.headers.origin, `http://localhost:${target.port}`)
  for (const name of ['cookie', 'authorization', 'referer', 'forwarded', 'x-forwarded-host']) assert.equal(received.headers[name], undefined)
  assert.match(String(received.headers['x-forwarded-prefix']), /^\/_et\/canvas\/api\/forward\/[A-Za-z0-9_-]{43}$/u)
  for (const name of ['set-cookie', 'clear-site-data', 'service-worker-allowed', 'access-control-allow-credentials', 'x-hop']) assert.equal(response.headers.get(name), null)
  assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts/u)
  assert(!response.headers.get('content-security-policy')!.includes('allow-same-origin'))
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('cache-control'), 'no-store')
  const redirect = f.service.open(f.source, `http://localhost:${target.port}/redirect`, 'first')
  const redirected = await fetch(f.base + redirect.url, { redirect: 'manual', headers: { 'X-Forwarded-Prefix': '/_et/canvas' } })
  assert.equal(redirected.status, 302)
  assert.equal(redirected.headers.get('location'), '/_et/canvas' + redirect.url.replace(/redirect$/u, 'next?x=1#item'))
})

test('IPv4 loopback addresses retain their exact destination', async t => {
  const target = await upstream(t, '127.0.0.2'), f = await fixture(t)
  assert.equal(loopbackHost(webUrl(target.base)), '127.0.0.2')
  assert.equal(loopbackHost(webUrl('http://127.254.1.9')), '127.254.1.9')
  const opened = f.service.open(f.source, `${target.base}/specific`, 'first')
  const response = await fetch(f.base + opened.url)
  assert.equal(response.status, 200); await response.text()
  assert.equal(target.received[0]!.headers.host, `127.0.0.2:${target.port}`)
})

test('WebSocket proxy echoes frames, strips parent credentials and closes both ends on logout', async t => {
  const target = await upstream(t), f = await fixture(t)
  const opened = f.service.open(f.source, `http://localhost:${target.port}/socket?q=1`, 'first')
  const ws = new WebSocket(f.base.replace(/^http/u, 'ws') + opened.url, { headers: { Cookie: 'parent=secret', Authorization: 'Bearer secret', Origin: 'https://frontend.test' } })
  t.after(() => ws.terminate()); await once(ws, 'open')
  const message = once(ws, 'message'); ws.send('echo fixture'); assert.equal(String((await message)[0]), 'echo fixture')
  assert.equal(target.received[0]!.url, '/socket?q=1')
  assert.equal(target.received[0]!.headers.cookie, undefined); assert.equal(target.received[0]!.headers.authorization, undefined)
  const closed = once(ws, 'close'); f.store.removeSession('first'); await closed
  await until(() => target.wsServer.clients.size === 0)
  assert.equal((await fetch(f.base + opened.url)).status, 404)
})

test('grants share one endpoint while revocation closes only the owning sessions requests', async t => {
  const target = await upstream(t)
  let prepared = 0, closed = 0
  const f = await fixture(t, async (_source, host, port) => {
    assert.equal(host, '127.0.0.1'); assert.equal(port, target.port); prepared++
    return { hostname: host, close: async () => { closed++ } }
  })
  const first = f.service.open(f.source, `http://localhost:${target.port}/pending`, 'first')
  const second = f.service.open(f.source, `http://localhost:${target.port}/ok`, 'second')
  const pending = fetch(f.base + first.url).catch(error => error)
  await until(() => target.received.length === 1)
  await (await fetch(f.base + second.url)).text()
  assert.equal(prepared, 1)
  f.store.removeSession('first'); assert(await pending instanceof Error)
  assert.equal(closed, 0)
  await (await fetch(f.base + second.url)).text()
  f.store.put('source', { ...f.source, herdrSession: 'changed' })
  await until(() => closed === 1)
  assert.equal((await fetch(f.base + second.url)).status, 404)
  await f.service.close(); assert.equal(closed, 1)
})

test('pending endpoint revocation drains before a replacement grant can prepare the same tunnel', async t => {
  const target = await upstream(t)
  let resolveFirst!: (value: Awaited<ReturnType<typeof prepareLoopback>>) => void
  let prepared = 0, closed = 0
  const f = await fixture(t, async (_source, host) => {
    if (++prepared === 1) return await new Promise(resolve => { resolveFirst = resolve })
    return { hostname: host, close: async () => { closed++ } }
  })
  const first = f.service.open(f.source, `http://localhost:${target.port}/first`, 'first')
  const pending = fetch(f.base + first.url).catch(error => error)
  await until(() => prepared === 1)
  f.service.closeSource(f.source.id)
  const next = f.service.open(f.source, `http://localhost:${target.port}/next`, 'first')
  const replacement = fetch(f.base + next.url)
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(prepared, 1)
  resolveFirst({ hostname: '127.0.0.1', close: async () => { closed++ } })
  assert(await pending instanceof Error)
  const response = await replacement; assert.equal(response.status, 200); await response.text()
  assert.equal(prepared, 2); assert.equal(closed, 1); assert.deepEqual(target.received.map(item => item.url), ['/next'])
  await f.service.close(); assert.equal(closed, 2)
})

test('idle grants expire, and opening the service again creates a fresh capability', async t => {
  let now = 1000
  const target = await upstream(t), f = await fixture(t, undefined, () => now)
  const first = f.service.open(f.source, `http://localhost:${target.port}/`, 'first')
  await (await fetch(f.base + first.url)).text()
  now += 31 * 60_000
  const next = f.service.open(f.source, `http://localhost:${target.port}/`, 'first')
  assert.notEqual(next.url, first.url)
  assert.equal((await fetch(f.base + first.url)).status, 404)
  await (await fetch(f.base + next.url)).text()
})

test('a cancelled request cannot send a delayed POST after endpoint preparation completes', async t => {
  const target = await upstream(t)
  let complete!: (value: Awaited<ReturnType<typeof prepareLoopback>>) => void
  const f = await fixture(t, async () => await new Promise(resolve => { complete = resolve }))
  const opened = f.service.open(f.source, `http://localhost:${target.port}/action`, 'first'), controller = new AbortController()
  const pending = fetch(f.base + opened.url, { method: 'POST', body: 'do not deliver', signal: controller.signal }).catch(error => error)
  await until(() => !!complete); controller.abort(); assert(await pending instanceof Error)
  await new Promise(resolve => setTimeout(resolve, 10))
  complete({ hostname: '127.0.0.1', close: async () => {} })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(target.received.length, 0)
  await (await fetch(f.base + opened.url)).text()
  assert.equal(target.received[0]!.method, 'GET')
})

test('HTTP upgrade rejection closes the pending proxy handshake', async t => {
  const f = await fixture(t), target = await upstream(t)
  const opened = f.service.open(f.source, `http://localhost:${target.port}/`, 'first')
  const response = await new Promise<number>(resolve => {
    const req = request(f.base + opened.url, { headers: { Connection: 'Upgrade', Upgrade: 'unexpected' } }, res => { res.resume(); resolve(res.statusCode!) })
    req.end()
  })
  assert.equal(response, 404)
  const noUpgrade = f.service.open(f.source, `http://localhost:${target.port}/no-upgrade`, 'first')
  const ws = new WebSocket(f.base.replace(/^http/u, 'ws') + noUpgrade.url)
  const rejected = await new Promise<number>(resolve => {
    ws.on('error', () => {})
    ws.on('unexpected-response', (_request, incoming) => { const status = incoming.statusCode!; incoming.resume(); ws.terminate(); resolve(status) })
  })
  assert.equal(rejected, 502)
})
