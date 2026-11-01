import test from 'node:test'
import assert from 'node:assert/strict'
import { cardZoomKey, pruneCardZooms } from './card-zoom.ts'
import type { Canvas } from './types.ts'

test('content zoom belongs to a shared card and is removed only after its last reference', () => {
  const values = new Map([[cardZoomKey('instance', 'note'), '150'], [cardZoomKey('instance', 'removed'), '80'], [cardZoomKey('other', 'note'), '120']])
  const storage = { get length() { return values.size }, key: (index: number) => [...values.keys()][index] || null,
    removeItem: (key: string) => { values.delete(key) } } as Storage
  const canvas: Canvas = { id: 'remaining', name: 'Canvas', nodes: [{ id: 'note', type: 'note', title: '', content: '', color: 'yellow', x: 0, y: 0, width: 320, height: 240 }] }
  pruneCardZooms('instance', [canvas], storage)
  assert.equal(values.get(cardZoomKey('instance', 'note')), '150')
  assert.equal(values.has(cardZoomKey('instance', 'removed')), false)
  pruneCardZooms('instance', [], storage)
  assert.deepEqual([...values], [[cardZoomKey('other', 'note'), '120']])
})
