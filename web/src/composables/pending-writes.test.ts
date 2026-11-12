import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { computed } from 'vue'
import {
  createKeepaliveCopies,
  createPendingWrites,
  guardPageExit,
  keepaliveFetch,
} from './pending-writes.ts'

test('a write shows saving, then saved for two seconds, then nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = createPendingWrites(),
    status = computed(() => writes.status('note'))
  assert.equal(status.value, undefined)
  writes.start('note')
  assert.equal(status.value, 'saving')
  assert.equal(writes.pending, true)
  writes.saved('note')
  assert.equal(status.value, 'saved')
  assert.equal(writes.pending, false, 'a stored change is safe to close')
  t.mock.timers.tick(1999)
  assert.equal(status.value, 'saved')
  t.mock.timers.tick(1)
  assert.equal(status.value, undefined)
})

test('editing again during the saved period hides the check until the new write lands', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = createPendingWrites()
  writes.start('note')
  writes.saved('note')
  t.mock.timers.tick(1500)
  writes.start('note')
  t.mock.timers.tick(1000)
  assert.equal(writes.status('note'), 'saving', 'the earlier timeout does not clear newer work')
  writes.saved('note')
  t.mock.timers.tick(1999)
  assert.equal(writes.status('note'), 'saved')
})

test('a failure persists until a retry stores the change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = createPendingWrites(),
    retry = mock.fn(() => writes.start('composer'))
  writes.start('composer')
  writes.failed('composer', retry)
  t.mock.timers.tick(60_000)
  assert.equal(writes.status('composer'), 'failed')
  assert.equal(writes.pending, true)
  writes.retry('composer')
  assert.equal(retry.mock.callCount(), 1)
  assert.equal(writes.status('composer'), 'saving')
  writes.failed('composer', retry)
  assert.equal(writes.status('composer'), 'failed', 'another failure keeps the warning')
  writes.start('composer')
  writes.saved('composer')
  assert.equal(writes.status('composer'), 'saved')
  assert.equal(writes.pending, false)
  writes.retry('composer')
  assert.equal(retry.mock.callCount(), 1, 'a stored owner has nothing to retry')
})

test('an upload keeps its owner saving while its text is stored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = createPendingWrites()
  writes.start('note', 'upload')
  writes.start('note')
  writes.saved('note')
  assert.equal(writes.status('note'), 'saving')
  writes.stop('note', 'upload')
  assert.equal(writes.status('note'), 'saved')
  writes.start('other', 'upload')
  writes.stop('other', 'upload')
  assert.equal(writes.status('other'), undefined, 'a transfer that stored nothing shows no check')
})

test('pending aggregates every owner and forgets discarded or reset ones', () => {
  const writes = createPendingWrites()
  assert.equal(writes.pending, false)
  writes.start('note')
  writes.start('layout:canvas')
  writes.start('terminal-upload:1', 'upload')
  writes.saved('note')
  assert.equal(writes.pending, true)
  writes.failed('layout:canvas', () => {})
  writes.discard('layout:canvas')
  assert.equal(writes.status('layout:canvas'), undefined, 'a removed owner drops its failure')
  assert.equal(writes.pending, true)
  writes.start('moved', 'upload')
  writes.start('moved')
  writes.discard('moved')
  assert.equal(writes.status('moved'), 'saving', 'discarding unsaved text keeps a running upload')
  writes.stop('moved', 'upload')
  writes.failed('terminal-upload:1', () => {}, 'upload')
  assert.equal(writes.pending, true)
  writes.reset()
  assert.equal(writes.pending, false)
  assert.equal(writes.status('note'), undefined)
})

function page() {
  const view = new EventTarget(),
    document = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    })
  const hide = () => {
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
  }
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true })
    view.dispatchEvent(event)
    return event
  }
  return { view, document, hide, unload }
}

test('closing prompts only while something is unsaved and sends it immediately', () => {
  const writes = createPendingWrites(),
    { view, document, unload } = page(),
    flush = mock.fn()
  let layoutDraft = false
  writes.onFlush(flush)
  guardPageExit(writes, () => layoutDraft, view, document)
  assert.equal(unload().defaultPrevented, false, 'idle pages close without a prompt')
  assert.equal(flush.mock.callCount(), 0)
  writes.start('composer')
  const armed = unload()
  assert.equal(armed.defaultPrevented, true)
  assert.deepEqual(
    flush.mock.calls.map((call) => call.arguments),
    [[true]],
  )
  writes.saved('composer')
  assert.equal(unload().defaultPrevented, false, 'a stored change no longer blocks closing')
  writes.failed('composer', () => {})
  assert.equal(unload().defaultPrevented, true, 'a failed write still holds unsaved data')
  writes.reset()
  layoutDraft = true
  assert.equal(unload().defaultPrevented, true, 'unapplied layout edits also prompt')
})

test('hiding or leaving the page sends pending writes as keepalive requests', async () => {
  const writes = createPendingWrites(),
    { view, document, hide } = page()
  const fetch = mock.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'),
  )
  const send = keepaliveFetch(fetch)
  let draft: string | undefined = 'unsaved text'
  writes.onFlush((keepalive) => {
    if (draft !== undefined)
      void send('/api/composer', {
        method: 'PATCH',
        body: JSON.stringify({ content: draft }),
        keepalive,
      })
  })
  const stop = guardPageExit(writes, () => false, view, document)
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(fetch.mock.callCount(), 0, 'becoming visible sends nothing')
  hide()
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(fetch.mock.calls[0]!.arguments[1]!.keepalive, true)
  assert.equal(fetch.mock.calls[0]!.arguments[1]!.body, '{"content":"unsaved text"}')
  view.dispatchEvent(new Event('pagehide'))
  assert.equal(
    fetch.mock.calls[1]!.arguments[1]!.keepalive,
    true,
    'pagehide covers browsers that skip visibility changes',
  )
  draft = undefined
  hide()
  assert.equal(fetch.mock.callCount(), 2, 'nothing unsaved means no request')
  draft = 'later'
  stop()
  hide()
  assert.equal(fetch.mock.callCount(), 2, 'the guard detaches')
})

test('keepalive stays within the browser budget and larger writes still go out', async () => {
  const pending: (() => void)[] = []
  const fetch = mock.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push(() => resolve(new Response('{}')))
      }),
  )
  const send = keepaliveFetch(fetch, 10)
  const keepalive = (call: number) => fetch.mock.calls[call]!.arguments[1]!.keepalive
  const first = send('/a', { method: 'PATCH', body: '123456', keepalive: true })
  const second = send('/b', { method: 'PATCH', body: '123456', keepalive: true })
  void send('/c', { method: 'PATCH', body: '123' })
  assert.deepEqual(
    [keepalive(0), keepalive(1), keepalive(2)],
    [true, false, false],
    'over budget falls back; unrequested stays ordinary',
  )
  pending[0]!()
  pending[1]!()
  await Promise.all([first, second])
  void send('/d', { method: 'PATCH', body: 'ü'.repeat(5), keepalive: true })
  assert.equal(keepalive(3), true, 'completed requests release their bytes')
  void send('/e', { method: 'PATCH', body: 'x', keepalive: true })
  assert.equal(keepalive(4), false, 'the budget counts encoded bytes')
})

test('a value goes out as a keepalive copy once, again after it failed or its save settled', () => {
  const copies = createKeepaliveCopies()
  assert.equal(copies.claim('note', 'a'), true)
  assert.equal(copies.claim('note', 'a'), false, 'a request already carries it')
  assert.equal(copies.claim('other', 'a'), true, 'owners are separate')
  assert.equal(copies.claim('note', 'b'), true, 'a newer value needs its own copy')
  copies.release('note', 'a')
  assert.equal(copies.claim('note', 'b'), false, 'an older failure does not release the newer copy')
  copies.release('note', 'b')
  assert.equal(copies.claim('note', 'b'), true)
  copies.forget('note')
  assert.equal(copies.claim('note', 'b'), true)
  assert.equal(copies.claim('other', 'a'), false)
  copies.forget()
  assert.equal(copies.claim('other', 'a'), true)
})
