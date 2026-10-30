import test from 'node:test'
import assert from 'node:assert/strict'
import { instanceToken, normalizeApiBase, resolveApiUrl } from '../web/src/instance-url.ts'
import { readStateEvents } from '../web/src/state-stream.ts'

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
