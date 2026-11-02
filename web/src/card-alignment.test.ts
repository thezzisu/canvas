import test from 'node:test'
import assert from 'node:assert/strict'
import { snapCardPosition, type CardBounds } from './card-alignment.ts'

const card = (id: string, x: number, y: number, width = 480, height = 301.625): CardBounds => ({ id, x, y, width, height })

test('adjacent terminal and note edges meet exactly despite non-grid dimensions', () => {
  const peer = card('peer', 24, 24, 481.25, 301.625)
  assert.equal(snapCardPosition(card('moving', 508, 24), [peer], 1).x, 505.25)
  assert.equal(snapCardPosition(card('moving', 24, 328, 340, 240), [peer], 1).y, 325.625)
  assert.equal(snapCardPosition(card('moving', -460, 24), [peer], 1).x, -456)
  assert.equal(snapCardPosition(card('moving', 24, -275), [peer], 1).y, -277.625)
})

test('same leading and trailing edges align without changing card sizes', () => {
  const moving = card('moving', 98, 113, 340, 240), peer = card('peer', 96, 24, 340, 329.75)
  assert.deepEqual(snapCardPosition(moving, [peer], 1), { x: 96, y: 113.75 })
  assert.equal(moving.width, 340)
  assert.equal(moving.height, 240)
})

test('edge attraction uses screen distance at different canvas zooms', () => {
  const peer = card('peer', 0, 0, 501.5)
  assert.equal(snapCardPosition(card('moving', 513, 48), [peer], .5).x, 501.5)
  assert.equal(snapCardPosition(card('moving', 513, 48), [peer], 2).x, 504)
  assert.equal(snapCardPosition(card('moving', 504.75, 48), [peer], 2).x, 501.5)
})

test('unrelated positions retain grid snapping including negative coordinates', () => {
  assert.deepEqual(snapCardPosition(card('moving', -37, 61), [], 1), { x: -48, y: 72 })
  assert.deepEqual(snapCardPosition(card('moving', 61, 61), [card('moving', 61, 61)], 1), { x: 72, y: 72 })
  assert.equal(snapCardPosition(card('moving', 505, 48), [card('farther', 0, 0, 498), card('closer', 0, 0, 504.25)], 1).x, 504.25)
})
