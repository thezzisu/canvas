import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutChange, type OrderedNode } from './order-transition.ts'

const card = (id: string, x = 0, width = 400): OrderedNode => ({
  id,
  type: 'terminal',
  position: { x, y: 0 },
  data: { width, height: 300 },
})

test('overview layout comparison ignores metadata and array order but recognizes visible moves', () => {
  const a = card('a'),
    b = card('b', 420)
  assert.equal(layoutChange([a, b], [b, a]), 'none')
  assert.equal(
    layoutChange([a, b], [{ ...a, data: { ...a.data, status: 'done' } } as OrderedNode, b]),
    'none',
  )
  assert.equal(layoutChange([a, b], [card('b'), card('a', 420)]), 'order')
  assert.equal(layoutChange([], []), 'none')
})

test('membership and terminal-size changes stay immediate instead of becoming an automatic reorder', () => {
  assert.equal(layoutChange([card('a')], []), 'membership')
  assert.equal(layoutChange([], [card('a')]), 'membership')
  assert.equal(layoutChange([card('a')], [card('b')]), 'membership')
  assert.equal(layoutChange([card('a')], [card('a', 0, 600)]), 'resize')
  const before = [card('a'), { ...card('group'), type: 'group' }]
  const after = [card('a', 420), { ...card('group', 0, 800), type: 'group' }]
  assert.equal(
    layoutChange(before, after),
    'order',
    'reordering differently sized cards may resize the computed group',
  )
})
