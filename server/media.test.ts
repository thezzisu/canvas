import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MediaTickets } from './media.ts'
import { createApp } from './app.ts'
import { Store } from './state.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-media-')), store = new Store(join(dir, 'state.db'))
  store.addSession('owner'); store.addSession('other')
  const bytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n')
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, {
    allowedOrigins: new Set(['https://c.zzs1.cn']),
    openDownload: async (id, session) => id === 'file' && session === 'owner' ? {
      body: Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'Content-Disposition': 'attachment; filename="report.pdf"' },
      previewHeaders: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'Content-Disposition': 'inline; filename="report.pdf"' },
    } : undefined,
  })
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`http://canvas.test${path}`, {
    method, headers: { Origin: 'https://c.zzs1.cn', Authorization: 'Bearer owner', 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { store, bytes, call }
}

test('cross-origin API accepts only configured exact origins and uses no credentials', async t => {
  const f = await fixture(t)
  const preflight = await f.call('/api/state', 'OPTIONS', undefined, { Authorization: '', 'Access-Control-Request-Headers': 'authorization,content-type' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://c.zzs1.cn')
  assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/u)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  assert.equal((await f.call('/api/state')).status, 200)
  assert.equal((await f.call('/api/state', 'GET', undefined, { Origin: 'https://c.zzs1.cn.other.test' })).status, 403)
  assert.equal((await f.call('/api/state', 'GET', undefined, { Origin: 'null' })).status, 403)
})

test('media tickets authorize exact objects and stream reusable PDF range, preview and download responses', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('/api/media-tickets', 'POST', { path: '/api/downloads/file' }, { Authorization: '' })).status, 401)
  assert.equal((await f.call('/api/media-tickets', 'POST', { path: '/api/downloads/file' }, { Authorization: 'Bearer other' })).status, 404)
  for (const path of ['/api/state', '/api/downloads/file?preview=1', 'https://other.test/api/files/file', '/api/files/../state'])
    assert.equal((await f.call('/api/media-tickets', 'POST', { path })).status, 400)
  const result = await f.call('/api/media-tickets', 'POST', { path: '/api/downloads/file' })
  assert.equal(result.status, 200)
  const { url } = await result.json()
  assert.match(url, /^\/api\/media\/[A-Za-z0-9_-]{43}$/u)
  const response = await f.call(url, 'GET', undefined, { Authorization: '' })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes)
  assert.match(response.headers.get('content-disposition')!, /^inline/u)
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin')
  assert.equal(response.headers.get('x-frame-options'), null)
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'self' https://c.zzs1.cn")
  for (const [range, start, end] of [['bytes=2-10', 2, 11], ['bytes=-4', f.bytes.length - 4, f.bytes.length], ['bytes=9-', 9, f.bytes.length]] as const) {
    const partial = await f.call(url, 'GET', undefined, { Authorization: '', Range: range })
    assert.equal(partial.status, 206)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), f.bytes.subarray(start, end))
    assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end - 1}/${f.bytes.length}`)
  }
  const head = await f.call(url, 'HEAD', undefined, { Authorization: '' })
  assert.equal(head.headers.get('content-length'), String(f.bytes.length)); assert.equal(await head.text(), '')
  assert.equal((await f.call(url, 'GET', undefined, { Range: 'bytes=999-' })).status, 416)
  const download = await (await f.call('/api/media-tickets', 'POST', { path: '/api/downloads/file', download: true })).json()
  const attachment = await f.call(download.url, 'GET', undefined, { Authorization: '' })
  assert.match(attachment.headers.get('content-disposition')!, /^attachment/u); await attachment.body?.cancel()
  f.store.removeSession('owner')
  assert.equal((await f.call(url, 'GET', undefined, { Authorization: '' })).status, 404)
})

test('media tickets expire and active formats stay sandboxed', async () => {
  let now = 1000, active = true
  const tickets = new MediaTickets(() => active, async () => ({ body: Readable.from(['<svg/>']), headers: {
    'Content-Type': 'image/svg+xml', 'Content-Length': '6', 'X-Frame-Options': 'DENY',
  } }), new Set(['https://c.zzs1.cn']), () => now)
  const ticket = (await tickets.create('/api/files/image', 'owner'))!, id = ticket.url.split('/').at(-1)!
  const response = (await tickets.open(id, 'GET'))!
  assert.match(response.headers.get('content-security-policy')!, /sandbox;/u)
  assert.equal(response.headers.get('x-frame-options'), null); await response.body?.cancel()
  now = ticket.expiresAt
  assert.equal(await tickets.open(id, 'GET'), undefined)
  active = false
  assert.equal(await tickets.create('/api/files/image', 'owner'), undefined)
})
