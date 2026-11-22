import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { closeRuntimeConnections } from './source-connections.ts'
import { followSource, refreshSource, type StartWatch } from './source-follow.ts'
import type { Source } from './state.ts'

function fixture(t: TestContext) {
  const source: Source = { id: randomUUID(), name: 'Fixture', runtime: 'herdr', transport: 'local' }
  const watches: {
    snapshot(value: number, readAt: number): void
    ended(error: Error): void
    refreshed: number
    closed: boolean
  }[] = []
  const state = { refuse: false, starts: 0 }
  const start: StartWatch<number> = async (_source, handlers) => {
    state.starts++
    if (state.refuse) throw new Error('refused')
    const watch = { ...handlers, refreshed: 0, closed: false }
    watches.push(watch)
    return { refresh: () => watch.refreshed++, close: () => (watch.closed = true) }
  }
  const follow = () => {
    const seen: (number | string)[] = []
    const following = followSource(source, start, {
      snapshot: (value) => seen.push(value),
      failed: (error) => seen.push(error.message),
    })
    return { seen, following }
  }
  t.after(() => closeRuntimeConnections(source.id))
  return { source, watches, state, follow }
}

test('followers of a connection share one watch, which ends with the last of them', async (t) => {
  const f = fixture(t)
  const first = f.follow()
  await sleep(1)
  const second = f.follow()
  assert.equal(f.watches.length, 1)
  assert.equal(f.watches[0]!.refreshed, 1, 'a newcomer has the source read again')
  f.watches[0]!.snapshot(7, 1)
  assert.deepEqual([first.seen, second.seen], [[7], [7]])
  first.following[Symbol.dispose]()
  assert.equal(f.watches[0]!.closed, false)
  second.following[Symbol.dispose]()
  assert.equal(f.watches[0]!.closed, true)
})

test('a broken watch is told of at once and opened again', async (t) => {
  const f = fixture(t)
  const { seen } = f.follow()
  await sleep(1)
  f.watches[0]!.ended(new Error('broken'))
  assert.deepEqual(seen, ['broken'])
  assert.deepEqual(f.follow().seen, ['broken'], 'a newcomer is told too')
  await sleep(300)
  assert.equal(f.watches.length, 2)
  f.watches[0]!.snapshot(1, 1)
  f.watches[1]!.snapshot(2, 2)
  assert.deepEqual(seen, ['broken', 2], 'what the old watch says no longer counts')
})

test('while a source keeps failing, refreshes wait for its retries', async (t) => {
  const f = fixture(t)
  f.state.refuse = true
  f.follow()
  await sleep(1)
  assert.equal(f.state.starts, 1)
  for (let i = 0; i < 5; i++) refreshSource(f.source)
  await sleep(100)
  assert.equal(f.state.starts, 1, 'each attempt may cost an SSH login')
  await sleep(700)
  assert.equal(f.state.starts, 3, 'retried after 250 ms, then 500 ms')
  f.state.refuse = false
  await sleep(1100)
  assert.equal(f.watches.length, 1)
})

test("releasing a source's connections closes its watch for good", async (t) => {
  const f = fixture(t)
  const { seen } = f.follow()
  await sleep(1)
  await closeRuntimeConnections(f.source.id)
  assert.equal(f.watches[0]!.closed, true)
  f.watches[0]!.ended(new Error('late'))
  await sleep(300)
  assert.deepEqual(seen, [])
  assert.equal(f.watches.length, 1)
})
