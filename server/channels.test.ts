import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, Latest } from './channels.ts'

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test('an event reaches its subscribers until they or the channel are disposed', () => {
  const events = new Events<number>(),
    heard: number[] = []
  const subscription = events.subscribe((value) => heard.push(value))
  events.emit(1)
  subscription[Symbol.dispose]()
  events.emit(2)
  events.subscribe((value) => heard.push(value * 10))
  events[Symbol.dispose]()
  events.emit(3)
  events.subscribe((value) => heard.push(value * 100))
  events.emit(4)
  assert.deepEqual(heard, [1])
})

test('a new subscriber is given the latest value, never an older one after a newer one', async () => {
  const latest = new Latest<string>(),
    heard: string[] = []
  latest.set('old')
  latest.subscribe((value) => heard.push(value))
  // A value set before the replay runs reaches the subscriber first; the replay is then owed nothing.
  latest.set('new')
  await tick()
  assert.deepEqual(heard, ['new'])
  const late: string[] = []
  latest.subscribe((value) => late.push(value))
  await tick()
  assert.deepEqual(late, ['new'])
})

test('a keyed value equal to the current one tells nobody; clearing tells nobody either', async () => {
  const latest = new Latest<{ name: string }>((value) => JSON.stringify(value)),
    heard: string[] = []
  latest.subscribe((value) => heard.push(value.name))
  assert.equal(latest.set({ name: 'a' }), true)
  assert.equal(latest.set({ name: 'a' }), false)
  latest.clear()
  assert.equal(latest.current, undefined)
  const replayed: string[] = []
  latest.subscribe((value) => replayed.push(value.name))
  await tick()
  assert.deepEqual(replayed, [], 'nothing current, nothing replayed')
  assert.equal(latest.set({ name: 'a' }), true, 'after clearing, the same value is news again')
  assert.deepEqual(heard, ['a', 'a'])
})

test('without replay or once disposed, nothing earlier or later arrives', async () => {
  const latest = new Latest<number>(),
    heard: number[] = []
  latest.set(1)
  latest.subscribe((value) => heard.push(value), { replay: false })
  await tick()
  const gone = latest.subscribe((value) => heard.push(value * 10))
  gone[Symbol.dispose]()
  await tick()
  latest.set(2)
  latest[Symbol.dispose]()
  latest.set(3)
  await tick()
  assert.deepEqual(heard, [2])
})
