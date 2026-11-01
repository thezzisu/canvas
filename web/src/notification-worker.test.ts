import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { notificationWorker } from '../../pwa.config.ts'

const source = await readFile(new URL('../notification-worker.js', import.meta.url), 'utf8')
async function click(url: string, windows: Array<{ url: string; focus(): Promise<void>; postMessage(value: unknown): void }>) {
  let listener: (event: unknown) => void = () => {}, task: Promise<void> | undefined, closed = false
  const opened: string[] = []
  runInNewContext(source, { URL, URLSearchParams, self: {
    location: { origin: 'https://canvas.example' },
    addEventListener: (_name: string, receive: typeof listener) => { listener = receive },
    clients: { matchAll: async () => windows, openWindow: async (value: string) => { opened.push(value) } },
  } })
  listener({ notification: { data: { type: 'canvas-notification', url, instance: 'backend', sourceId: 'source', windowId: 'window' }, close() { closed = true } },
    waitUntil(value: Promise<void>) { task = value } })
  await task
  return { opened, closed }
}
test('notification click focuses the matching saved instance without switching another client', async () => {
  const focused: string[] = [], messages: any[] = []
  const client = (instance: string) => ({ url: `https://canvas.example/#instance=${instance}&canvas=overview`,
    focus: async () => { focused.push(instance) }, postMessage: (value: unknown) => { messages.push(value) } })
  const result = await click('https://canvas.example/#instance=b&canvas=overview&view=paged', [client('a'), client('b')])
  assert.deepEqual(focused, ['b']); assert.equal(messages.length, 1)
  assert.equal(messages[0].type, 'canvas:notification-open'); assert.equal(messages[0].windowId, 'window')
  assert(result.closed); assert.deepEqual(result.opened, [])
})
test('a closed matching view opens its safe frontend URL; external destinations are rejected', async () => {
  const url = 'https://canvas.example/#instance=b&canvas=overview'
  assert.deepEqual((await click(url, [])).opened, [url])
  assert.deepEqual(await click('https://elsewhere.example/', []), { opened: [], closed: false })
})
test('the worker extension is content-addressed and contains no push subscription handler', () => {
  assert.equal(notificationWorker.source, source)
  assert.match(notificationWorker.fileName, /^assets\/notification-worker-[a-f0-9]{12}\.js$/)
  assert(!/addEventListener\(['"]push/.test(source))
})
