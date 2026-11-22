import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CoreNotification, CoreRpc } from './rpc.ts'
import { watchCore } from './watch.ts'

function fixture() {
  const order: string[] = [],
    endings: string[] = [],
    values: number[] = []
  let listen!: (event: CoreNotification) => unknown,
    streamClosed!: () => void,
    count = 0,
    gate: Promise<void> | undefined
  const disposable = { [Symbol.dispose]() {} }
  const rpc = {
    async subscribe(_params: object, listener: typeof listen) {
      order.push('subscribe')
      listen = listener
      return {
        stream: {
          onClose(listener: () => void) {
            streamClosed = listener
            return disposable
          },
        },
        start: () => order.push('start'),
        close() {},
      }
    },
    onClose: () => disposable,
    close: () => order.push('close'),
  } as unknown as Pick<CoreRpc, 'subscribe' | 'onClose' | 'close'>
  const watch = watchCore(
    rpc,
    async () => {
      order.push('read')
      await gate
      return ++count
    },
    { snapshot: (value) => values.push(value), ended: (error) => endings.push(error.message) },
  )
  const emit = (method: CoreNotification['method'], type = 'title') =>
    void listen({ method, params: { seq: 1, type } } as unknown as CoreNotification)
  return {
    order,
    endings,
    values,
    watch,
    emit,
    end: () => streamClosed(),
    hold(value?: Promise<void>) {
      gate = value
    },
  }
}

test('the watch reads after the subscription started, and collapses a burst', async () => {
  const f = fixture()
  await sleep(5)
  assert.deepEqual(f.order, ['subscribe', 'start', 'read'])
  for (let i = 0; i < 10; i++) f.emit('event')
  await sleep(150)
  assert.deepEqual(f.values, [1], 'not again within a second of the first read')
  await sleep(1000)
  assert.deepEqual(f.values, [1, 2])
  f.watch.close()
})

test('heartbeats and sizes cause no read; missed events cause one at once', async () => {
  const f = fixture()
  await sleep(5)
  f.emit('heartbeat')
  f.emit('event', 'size')
  await sleep(150)
  assert.deepEqual(f.values, [1])
  f.emit('missed')
  await sleep(5)
  assert.deepEqual(f.values, [1, 2])
  f.watch.close()
})

test('a change during a read is read afterwards, never beside it', async () => {
  const f = fixture()
  await sleep(5)
  let release!: () => void
  f.hold(new Promise<void>((resolve) => (release = resolve)))
  f.emit('missed')
  f.emit('missed')
  await sleep(120)
  assert.equal(f.order.filter((entry) => entry === 'read').length, 2)
  f.hold()
  release()
  await sleep(1150)
  assert.deepEqual(f.values, [1, 2, 3])
  f.watch.close()
})

test('the end of the stream ends the watch; closing it does not', async () => {
  const ended = fixture()
  await sleep(5)
  ended.end()
  assert.deepEqual(ended.endings, ['Core ended the event stream'])
  assert.equal(ended.order.at(-1), 'close')
  const closed = fixture()
  await sleep(5)
  closed.watch.close()
  assert.deepEqual(closed.endings, [])
})
