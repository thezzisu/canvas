import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import type { RuntimeListing, SourceResource } from './runtimes.ts'
import type { FollowListener } from './source-follow.ts'
import { SourceWatchers } from './source-watchers.ts'
import type { Source } from './state.ts'

function fixture(t: TestContext) {
  const state = {
    sources: [{ id: 's', name: 'One', runtime: 'herdr', transport: 'local' }] as Source[],
  }
  const follows: {
    source: Source
    listener: FollowListener<RuntimeListing>
    refreshed: number
    ended: boolean
  }[] = []
  const watchers = new SourceWatchers({
    sources: () => state.sources,
    follow(source, listener) {
      const follow = { source, listener, refreshed: 0, ended: false }
      follows.push(follow)
      return {
        refresh: () => follow.refreshed++,
        [Symbol.dispose]() {
          follow.ended = true
        },
      }
    },
    project: (_source, resource) => resource,
    graceMs: 30,
  })
  const pushed: SourceResource[] = []
  watchers.changes.subscribe((resource) => pushed.push(resource))
  t.after(() => watchers[Symbol.dispose]())
  return { state, follows, watchers, pushed }
}
const listing = (name: string): RuntimeListing => ({ spaces: [{ id: 'space', name, windows: [] }] })

test('sources are watched only while a browser listens, and a little longer', async (t) => {
  const f = fixture(t)
  f.watchers.sync()
  assert.equal(f.follows.length, 0)
  const first = f.watchers.view()
  assert.equal(f.follows.length, 1)
  first[Symbol.dispose]()
  await sleep(5)
  assert.equal(f.follows[0]!.ended, false)
  const second = f.watchers.view()
  await sleep(50)
  assert.equal(f.follows.length, 1, 'a browser back in time keeps the watch')
  assert.equal(f.follows[0]!.ended, false)
  second[Symbol.dispose]()
  await sleep(50)
  assert.equal(f.follows[0]!.ended, true)
})

test('only a listing that differs is pushed; a new browser has all of it sent again', (t) => {
  const f = fixture(t)
  f.watchers.view()
  const { listener } = f.follows[0]!
  listener.snapshot(listing('a'), 1)
  listener.snapshot(listing('a'), 2)
  assert.equal(f.pushed.length, 1)
  f.watchers.view()
  assert.equal(f.follows[0]!.refreshed, 1)
  listener.snapshot(listing('a'), 3)
  assert.equal(f.pushed.length, 2)
})

test('a broken source is pushed as offline at once, and only once', (t) => {
  const f = fixture(t)
  f.watchers.view()
  const { listener } = f.follows[0]!
  listener.snapshot(listing('a'), 4)
  listener.failed(new Error('unreachable'))
  listener.failed(new Error('unreachable'))
  assert.deepEqual(
    f.pushed.map((resource) => resource.status),
    ['online', 'offline'],
  )
  listener.snapshot(listing('a'), 5)
  assert.equal(f.pushed.at(-1)!.status, 'online')
})

test('an edited connection is watched anew; a renamed one keeps its watch', (t) => {
  const f = fixture(t)
  f.watchers.view()
  f.state.sources = [{ ...f.state.sources[0]!, name: 'Two' }]
  f.watchers.sync()
  assert.equal(f.follows.length, 1)
  f.follows[0]!.listener.snapshot(listing('a'), 6)
  assert.equal(f.pushed[0]!.name, 'Two')
  f.state.sources = [{ ...f.state.sources[0]!, runtime: 'hc' }]
  f.watchers.sync()
  assert.equal(f.follows[0]!.ended, true)
  f.follows[0]!.listener.snapshot(listing('late'), 7)
  assert.equal(f.pushed.length, 1, 'the old connection says nothing more')
  f.state.sources = []
  f.watchers.sync()
  assert.equal(f.follows[1]!.ended, true)
})
