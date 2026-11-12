import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalStarts, immediateStart } from './terminal-starts.ts'

test('terminals start two at a time, the nearest first, and the maximized one at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starts = createTerminalStarts(2),
    started: string[] = [],
    ranks: Record<string, number> = { a: 2, b: 2, c: 2, d: 1, e: 2 }
  const handles = Object.fromEntries(
    Object.keys(ranks).map((name) => [
      name,
      starts.request(
        () => ranks[name]!,
        () => started.push(name),
      ),
    ]),
  )
  assert.deepEqual(started, ['a', 'b'])

  // The maximized terminal does not wait for a place.
  starts.request(
    () => immediateStart,
    () => started.push('max'),
  )
  assert.deepEqual(started, ['a', 'b', 'max'])

  // A finished start lets the browser paint, then the lowest rank at that moment goes next.
  ranks.e = 1
  ranks.d = 2
  handles.a!.done()
  assert.deepEqual(started, ['a', 'b', 'max'])
  t.mock.timers.tick(0)
  assert.deepEqual(started, ['a', 'b', 'max'])
  handles.b!.done()
  t.mock.timers.tick(0)
  assert.deepEqual(started, ['a', 'b', 'max', 'e'])

  // A card that leaves gives up its place in the queue, or the one it holds.
  handles.c!.cancel()
  handles.e!.cancel()
  handles.e!.done()
  t.mock.timers.tick(0)
  assert.deepEqual(started, ['a', 'b', 'max', 'e', 'd'])
})

test('a start that never reports back gives its place up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starts = createTerminalStarts(1),
    started: string[] = []
  for (const name of ['a', 'b'])
    starts.request(
      () => 1,
      () => started.push(name),
    )
  t.mock.timers.tick(2999)
  assert.deepEqual(started, ['a'])
  t.mock.timers.tick(1)
  t.mock.timers.tick(0)
  assert.deepEqual(started, ['a', 'b'])
})
