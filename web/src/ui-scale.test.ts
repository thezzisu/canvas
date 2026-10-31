import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUiScale, readUiScale } from './ui-scale.ts'
import { logicalViewportFrame } from './viewport-frame.ts'

test('UI scale accepts the offered percentages and safely defaults invalid local state', () => {
  for (const value of [75, 90, 100, 110, 125, 150]) {
    assert.equal(normalizeUiScale(value), value)
    assert.equal(readUiScale(String(value)), value)
  }
  for (const value of [0, -1, 74, 151, Infinity, NaN, null, true, '125', {}, []]) assert.equal(normalizeUiScale(value), 100)
  for (const value of ['', 'garbage', '125px', 'null', '"125"', '{}', 'NaN', '1e999', '-20', '200']) assert.equal(readUiScale(value), 100)
})

test('logical viewport scales dimensions and offsets exactly once for visual-keyboard and fullscreen frames', () => {
  const physical = { width: 390, height: 487.2, top: 34, left: 8 }
  for (const zoom of [.75, .9, 1, 1.1, 1.25, 1.5]) {
    const logical = logicalViewportFrame(physical, zoom)
    for (const key of ['width', 'height', 'top', 'left'] as const) assert(Math.abs(logical[key] * zoom - physical[key]) < 1e-8)
    const fullscreen = logicalViewportFrame({ width: 390, height: 844, top: 0, left: 0 }, zoom)
    assert.equal(fullscreen.top, 0)
    assert(Math.abs(fullscreen.height * zoom - 844) < 1e-8)
  }
  assert.deepEqual(physical, { width: 390, height: 487.2, top: 34, left: 8 })
})
