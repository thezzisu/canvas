import test from 'node:test'
import assert from 'node:assert/strict'
import { formatInstanceLink, instanceToken, isCanvasSession, normalizeApiBase, parseInstanceLink, resolveApiUrl } from './instance-url.ts'
import { readStateEvents } from './state-stream.ts'
import { removeSessionToken, sessionToken, storeSessionToken, tokenKey } from './instance-session.ts'

test('instance API URLs preserve deployment prefixes and reject foreign or escaped destinations', () => {
  const base = normalizeApiBase(' https://canvas.example/prefix ')
  assert.equal(base, 'https://canvas.example/prefix/')
  assert.equal(resolveApiUrl(base, '/api/state').href, `${base}api/state`)
  assert.equal(resolveApiUrl(base, '/api/terminal?windowId=w1%3At1').href, `${base}api/terminal?windowId=w1%3At1`)
  assert.equal(resolveApiUrl(base, `${base}api/media/scoped`).href, `${base}api/media/scoped`)
  for (const path of ['https://elsewhere.example/api/state', '//elsewhere.example/api/state', '../api/state', '/other/api/state', '/api/../../state', '/api/files/id#fragment'])
    assert.throws(() => resolveApiUrl(base, path))
  for (const value of ['ftp://canvas.example/', 'https://user:DUMMY_PASSWORD@canvas.example/', 'https://canvas.example/?token=value', 'https://canvas.example/#token'])
    assert.throws(() => normalizeApiBase(value))
})

test('a session never follows an instance address edited in another browser tab', () => {
  const stored = JSON.stringify({ base: 'https://canvas.example/first/', token: 'test-session' })
  assert.equal(instanceToken(stored, 'https://canvas.example/first/'), 'test-session')
  assert.equal(instanceToken(stored, 'https://canvas.example/second/'), '')
  assert.equal(instanceToken(stored, 'https://different.example/first/'), '')
  assert.equal(instanceToken('invalid JSON', 'https://canvas.example/first/'), '')
})

test('persistent sessions remain scoped to instance ID and exact API base', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const one = { id: 'one', base: 'https://one.example/canvas/' }, two = { id: 'two', base: 'https://two.example/canvas/' }
  storeSessionToken(one, 'synthetic-one', storage); storeSessionToken(two, 'synthetic-two', storage)
  assert.equal(sessionToken(one, storage), 'synthetic-one')
  assert.equal(sessionToken(two, storage), 'synthetic-two')
  assert.equal(sessionToken({ ...one, base: 'https://changed.example/canvas/' }, storage), '')
  assert.equal(sessionToken({ ...one, id: 'missing' }, storage), '')
  removeSessionToken(one.id, storage)
  assert.equal(values.has(tokenKey(one.id)), false)
  assert.equal(sessionToken(two, storage), 'synthetic-two')
  storeSessionToken(two, '', storage); assert.equal(values.size, 0)
})

test('server setup links normalize the address and consume only their own query fields', () => {
  const result = parseInstanceLink('https://frontend.example/app/?server=HTTPS%3A%2F%2FBACKEND.EXAMPLE%3A443%2Fcanvas&name=%20Personal%20%20server%20&theme=dark&token=ignored#section')!
  assert.deepEqual(result.server, { base: 'https://backend.example/canvas/', name: 'Personal server' })
  assert.equal(result.invalid, false)
  assert.equal(result.url.href, 'https://frontend.example/app/?theme=dark&token=ignored#section')
  assert.equal(parseInstanceLink('https://frontend.example/?token=ignored'), undefined)
  assert.equal(parseInstanceLink('https://frontend.example/?server=http%3A%2F%2Flocalhost%3A3010')!.server?.name, 'localhost:3010')
  const onlyName = parseInstanceLink('https://frontend.example/?name=Ignored&keep=1#section')!
  assert.equal(onlyName.server, undefined)
  assert.equal(onlyName.invalid, false)
  assert.equal(onlyName.url.href, 'https://frontend.example/?keep=1#section')
})

test('invalid or ambiguous server setup links cannot import credentials or redirect the page', () => {
  for (const server of ['javascript:alert(1)', 'data:text/plain,hello', '//backend.example/', 'ftp://backend.example/',
    'https://user:DUMMY_PASSWORD@backend.example/', 'https://backend.example/?token=ignored', 'https://backend.example/#secret', '']) {
    const link = new URL('https://frontend.example/app/?keep=1#section')
    link.searchParams.set('server', server)
    const result = parseInstanceLink(link.href)!
    assert.equal(result.invalid, true, server)
    assert.equal(result.server, undefined)
    assert.equal(result.url.href, 'https://frontend.example/app/?keep=1#section')
  }
  assert.equal(parseInstanceLink('https://frontend.example/?server=https://one.example/&server=https://two.example/')!.invalid, true)
})

test('shared links round-trip the instance and username without session or navigation data', () => {
  const server = { base: 'https://backend.example/canvas/', name: '工作站 & Lab', username: '张子苏 + tester' }
  const href = formatInstanceLink('https://frontend.example/app/?token=synthetic&password=ignored#canvas-private', server)
  const url = new URL(href)
  assert.equal(url.pathname, '/app/')
  assert.equal(url.hash, '')
  assert.deepEqual([...url.searchParams.keys()], ['server', 'name', 'username'])
  const parsed = parseInstanceLink(href)!
  assert.deepEqual(parsed.server, server)
  assert.equal(parsed.invalid, false)
  assert.equal(parsed.url.href, 'https://frontend.example/app/')
  assert.throws(() => formatInstanceLink('https://user:DUMMY_PASSWORD@frontend.example/', server))
})

test('shared usernames are optional, bounded and unambiguous', () => {
  const valid = 'https://frontend.example/?server=https%3A%2F%2Fbackend.example%2F'
  assert.equal(parseInstanceLink(`${valid}&username=%20canvas%20`)!.server?.username, 'canvas')
  assert.equal(parseInstanceLink(`${valid}&username=`)!.server?.username, undefined)
  for (const extra of ['&username=one&username=two', '&name=one&name=two', `&username=${'a'.repeat(201)}`, '&username=line%0Abreak'])
    assert.equal(parseInstanceLink(valid + extra)!.invalid, true)
  for (const href of ['javascript:alert(1)', 'https://user:DUMMY_PASSWORD@frontend.example/?server=https://backend.example/'])
    assert.equal(parseInstanceLink(href)!.invalid, true)
  assert.equal(parseInstanceLink('https://frontend.example/?username=canvas&keep=1')!.url.href, 'https://frontend.example/?keep=1')
})

test('session discovery rejects static SPA fallbacks and malformed API responses', () => {
  for (const value of [undefined, null, '<!doctype html>', [], {}, { authenticated: 'false' }, { authenticated: false, username: {} }])
    assert.equal(isCanvasSession(value), false)
  assert.equal(isCanvasSession({ authenticated: false }), true)
  assert.equal(isCanvasSession({ authenticated: true, username: 'fixture' }), true)
})

test('state streaming reads UTF-8 and SSE fields across arbitrary network chunk boundaries', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: state\r\nid: instance:2\r\ndata: {"name":\r\ndata: "画布"}\r\n\r\nevent: unauthorized\ndata: {}\n\n')
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return }
    const next = Math.min(bytes.length, offset + (offset % 5) + 1)
    controller.enqueue(bytes.slice(offset, next)); offset = next
  } })
  const events: Array<{ event: string; data: string }> = []
  await readStateEvents(stream, (event, data) => events.push({ event, data }))
  assert.deepEqual(events.map(item => item.event), ['state', 'unauthorized'])
  assert.deepEqual(JSON.parse(events[0]!.data), { name: '画布' })
  assert.equal(stream.locked, false)
})

test('state streaming releases a reader when its receiver rejects a frame', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: state\ndata: {}\n\n'))
  }, cancel() { cancelled = true } })
  await assert.rejects(readStateEvents(stream, () => { throw new Error('stale context') }), /stale context/)
  assert.equal(cancelled, true)
  assert.equal(stream.locked, false)
})
