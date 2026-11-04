import test from 'node:test'
import assert from 'node:assert/strict'
import { orderedItems } from './sidebar-order.ts'

const ids = (items: { id: string }[]) => items.map(item => item.id)
const items = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'c', value: 3 }]

test('local order leaves shared source records intact and retains their identities', () => {
  const ordered = orderedItems(items, ['c', 'a', 'b'])
  assert.deepEqual(ids(ordered), ['c', 'a', 'b'])
  assert.deepEqual(ids(items), ['a', 'b', 'c'])
  assert.equal(ordered[0], items[2])
})

test('deleted, duplicate and invalid preferences do not hide new connections or canvases', () => {
  assert.deepEqual(ids(orderedItems(items, ['deleted', 'c', 'c', null, 5, 'b'])), ['c', 'b', 'a'])
  assert.deepEqual(ids(orderedItems([...items, { id: 'new', value: 4 }], ['b', 'a', 'c'])), ['b', 'a', 'c', 'new'])
  for (const invalid of [undefined, null, 'a', {}, 123]) assert.deepEqual(ids(orderedItems(items, invalid)), ['a', 'b', 'c'])
})

test('a drag reconciles stable IDs rather than stale indices after a concurrent list change', () => {
  const changed = [{ id: 'b' }, { id: 'c' }, { id: 'new' }]
  assert.deepEqual(ids(orderedItems(changed, ['c', 'a', 'b'])), ['c', 'b', 'new'])
})
