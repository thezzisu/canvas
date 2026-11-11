import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resizeFromDelta,
  snapCardPosition,
  snapCardResize,
  type CardBounds,
} from './card-alignment.ts'

const card = (id: string, x: number, y: number, width = 480, height = 301.625): CardBounds => ({
  id,
  x,
  y,
  width,
  height,
})

test('adjacent terminal and note edges meet exactly despite non-grid dimensions', () => {
  const peer = card('peer', 24, 24, 481.25, 301.625)
  assert.equal(snapCardPosition(card('moving', 508, 24), [peer], 1).x, 505.25)
  assert.equal(snapCardPosition(card('moving', 24, 328, 340, 240), [peer], 1).y, 325.625)
  assert.equal(snapCardPosition(card('moving', -460, 24), [peer], 1).x, -456)
  assert.equal(snapCardPosition(card('moving', 24, -275), [peer], 1).y, -277.625)
})

test('same leading and trailing edges align without changing card sizes', () => {
  const moving = card('moving', 98, 113, 340, 240),
    peer = card('peer', 96, 24, 340, 329.75)
  assert.deepEqual(snapCardPosition(moving, [peer], 1), { x: 96, y: 113.75 })
  assert.equal(moving.width, 340)
  assert.equal(moving.height, 240)
})

test('edge attraction uses screen distance at different canvas zooms', () => {
  const peer = card('peer', 0, 0, 501.5)
  assert.equal(snapCardPosition(card('moving', 513, 48), [peer], 0.5).x, 501.5)
  assert.equal(snapCardPosition(card('moving', 513, 48), [peer], 2).x, 504)
  assert.equal(snapCardPosition(card('moving', 504.75, 48), [peer], 2).x, 501.5)
})

test('unrelated positions retain grid snapping including negative coordinates', () => {
  assert.deepEqual(snapCardPosition(card('moving', -37, 61), [], 1), { x: -48, y: 72 })
  assert.deepEqual(snapCardPosition(card('moving', 61, 61), [card('moving', 61, 61)], 1), {
    x: 72,
    y: 72,
  })
  assert.equal(
    snapCardPosition(
      card('moving', 505, 48),
      [card('farther', 0, 0, 498), card('closer', 0, 0, 504.25)],
      1,
    ).x,
    504.25,
  )
})

const minimum = { width: 240, height: 160 }
test('integer resize measurements do not change an untouched fractional axis', () => {
  const origin = card('card', 0, 0),
    raw = { ...origin, height: 302 }
  const current = resizeFromDelta(origin, raw, { ...raw, width: 500 })
  const result = snapCardResize(origin, current, [], 1, minimum)
  assert.equal(result.width, 504)
  assert.equal(result.height, 301.625)
  const peer = card('peer', 557.5, 0)
  assert.equal(snapCardResize(origin, { ...current, width: 560 }, [peer], 1, minimum).width, 557.5)
  const fractional = card('fractional', 13.2, 17.2, 481.2, 301.2)
  const measured = { ...fractional, width: 481, height: 301 }
  const vertical = resizeFromDelta(fractional, measured, { ...measured, height: 330 })
  assert.equal(vertical.x, fractional.x)
  assert.equal(vertical.width, fractional.width)
  assert.equal(snapCardResize(fractional, vertical, [], 1, minimum).width, fractional.width)
})

test('resize snaps only moving edges and preserves the opposite fractional edges', () => {
  const origin = card('card', 13.5, 17.25, 480, 300)
  const right = snapCardResize(origin, { ...origin, width: 503 }, [], 1, minimum)
  assert.deepEqual(right, { ...origin, width: 528 - origin.x })
  const topLeft = snapCardResize(
    origin,
    { ...origin, x: -20, y: -30, width: 513.5, height: 347.25 },
    [],
    1,
    minimum,
  )
  assert.equal(topLeft.x, -24)
  assert.equal(topLeft.y, -24)
  assert.equal(topLeft.x + topLeft.width, origin.x + origin.width)
  assert.equal(topLeft.y + topLeft.height, origin.y + origin.height)
})

test('resize prioritizes adjacent edges at screen distance without changing the fixed axis', () => {
  const origin = card('card', 0, 0),
    peer = card('peer', 557.5, 389.25)
  assert.equal(snapCardResize(origin, { ...origin, width: 568 }, [peer], 0.5, minimum).width, 557.5)
  const bottom = snapCardResize(origin, { ...origin, height: 391 }, [peer], 1, minimum)
  assert.equal(bottom.height, 389.25)
  assert.equal(bottom.width, origin.width)
})

test('resize respects minimum and maximum size while keeping the opposite side fixed', () => {
  const origin = card('card', 13.5, 17.25, 480, 300)
  const result = snapCardResize(
    origin,
    { ...origin, x: 253.5, width: 240, height: 3000 },
    [],
    1,
    minimum,
  )
  assert(result.width >= 240)
  assert(result.height <= 3000)
  assert.equal(result.x + result.width, origin.x + origin.width)
  assert.equal(result.y, origin.y)
})
