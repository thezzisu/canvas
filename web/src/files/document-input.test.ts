import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { bindDocumentInput, useDocumentInputMode } from './document-input.ts'

test('only a source- and origin-verified document handshake receives current and changing input hints', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const host = new EventTarget()
  let dispose = () => {}
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  t.after(() => {
    dispose()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: unknown }).window
  })
  const received: unknown[] = [],
    peer = { postMessage: (message: unknown, origin: string) => received.push([message, origin]) }
  const frame = Object.assign(new EventTarget(), {
    src: 'https://backend.test/api/capture/fixture/',
    contentWindow: peer,
  }) as unknown as HTMLIFrameElement
  const touch = ref(false)
  dispose = bindDocumentInput(frame, touch)
  const ready = (source: unknown, origin: string) =>
    host.dispatchEvent(
      Object.assign(new Event('message'), {
        source,
        origin,
        data: { type: 'canvas:document-ready' },
      }),
    )
  assert.equal(received.length, 1, 'before handshake only a non-sensitive query is sent')
  touch.value = true
  await nextTick()
  assert.equal(received.length, 1)
  ready(peer, 'https://other.test')
  ready({}, 'https://backend.test')
  assert.equal(received.length, 1)
  ready(peer, 'https://backend.test')
  assert.deepEqual(received.at(-1), [
    { type: 'canvas:document-input', touch: true },
    'https://backend.test',
  ])
  touch.value = false
  await nextTick()
  assert.deepEqual(received.at(-1), [
    { type: 'canvas:document-input', touch: false },
    'https://backend.test',
  ])
  frame.dispatchEvent(new Event('load'))
  const count = received.length
  touch.value = true
  await nextTick()
  assert.equal(received.length, count, 'navigation invalidates the old document handshake')
  dispose()
  ready(peer, 'https://backend.test')
  assert.equal(received.length, count, 'released owners have no message listener')
})

test('embedded documents retain canonical fallback, pin their parent origin and release listeners with their scope', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    sent: unknown[] = []
  const parent = { postMessage: (message: unknown) => sent.push(message) }
  const host = Object.assign(new EventTarget(), { parent })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: unknown }).window
  })
  const scope = effectScope(),
    fallback = ref(true),
    mode = scope.run(() => useDocumentInputMode(fallback))!
  t.after(() => scope.stop())
  assert.equal(mode.value, true)
  assert.equal(sent.length, 1)
  const send = (source: unknown, origin: string, type: string, touch?: boolean) =>
    host.dispatchEvent(
      Object.assign(new Event('message'), { source, origin, data: { type, touch } }),
    )
  send({}, 'https://wrong.test', 'canvas:document-input', false)
  assert.equal(mode.value, true)
  send(parent, 'https://frontend.test', 'canvas:document-query')
  send(parent, 'https://frontend.test', 'canvas:document-input', false)
  assert.equal(mode.value, false)
  send(parent, 'https://wrong.test', 'canvas:document-input', true)
  assert.equal(mode.value, false)
  scope.stop()
  send(parent, 'https://frontend.test', 'canvas:document-input', true)
  assert.equal(mode.value, false)
})
