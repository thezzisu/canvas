import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, LayoutConflict, type Canvas } from './state.ts'
import { randomUUID } from 'node:crypto'

test('conditional layout is atomic and preserves concurrent note content and untouched geometry', () => {
  const store = new Store(':memory:')
  try {
    const sourceId = randomUUID(),
      canvas = store.put<Canvas>('canvas', {
        id: randomUUID(),
        name: 'Test',
        nodes: [
          {
            id: 'terminal',
            type: 'terminal',
            sourceId,
            spaceId: 'space',
            windowId: 'window',
            x: 0,
            y: 0,
            width: 500,
            height: 300,
          },
          {
            id: 'note',
            type: 'note',
            title: '',
            content: 'peer edit',
            color: 'blue',
            x: 10,
            y: 20,
            width: 300,
            height: 200,
          },
        ],
      })
    const initial = store.windowSize(sourceId, 'window')
    let events = 0
    store.on('change', () => {
      events++
      assert.equal(store.get<Canvas>('canvas', canvas.id)?.nodes[1]?.x, 80)
    })
    assert.throws(
      () =>
        store.applyLayout(canvas.id, [
          { id: 'terminal', width: 700, expected: { width: initial.width } },
          { id: 'note', x: 80, expected: { x: 999 } },
        ]),
      LayoutConflict,
    )
    assert.deepEqual(store.windowSize(sourceId, 'window'), initial)
    assert.equal(events, 0)
    const changes = [
      { id: 'terminal', width: 700, expected: { width: initial.width } },
      { id: 'note', x: 80, expected: { x: 10 } },
    ]
    const result = store.applyLayout(canvas.id, changes)!
    assert.equal(events, 1)
    assert.equal(store.windowSize(sourceId, 'window').width, 700)
    assert.deepEqual(result.nodes[1], { ...canvas.nodes[1], x: 80 })
    assert.doesNotThrow(
      () => store.applyLayout(canvas.id, changes),
      'retry after lost acknowledgement is idempotent',
    )
    assert.throws(
      () => store.applyLayout(canvas.id, [{ id: 'removed', x: 9, expected: { x: 1 } }]),
      LayoutConflict,
    )
  } finally {
    store.close()
  }
})
