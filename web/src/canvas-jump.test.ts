import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjacentCanvas, anchoredViewport, canvasAnchor } from './canvas-jump.ts'

test('window canvas neighbours follow sidebar order without wrapping', () => {
  const entries = [{ id: 'overview', name: 'Overview' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  assert.equal(adjacentCanvas(entries, 'overview', 'previous'), undefined)
  assert.equal(adjacentCanvas(entries, 'overview', 'next')?.id, 'a')
  assert.equal(adjacentCanvas(entries, 'a', 'previous')?.id, 'overview')
  assert.equal(adjacentCanvas(entries, 'b', 'next'), undefined)
  assert.equal(adjacentCanvas(entries, 'missing', 'next'), undefined)
})

test('an anchored window keeps its exact screen position and scale on another canvas', () => {
  const anchor = canvasAnchor({ sourceId: 's', windowId: 'w' }, { x: 120, y: -40 }, { x: 33.5, y: 210, zoom: .75 })
  assert.deepEqual(anchor, { sourceId: 's', windowId: 'w', x: 123.5, y: 180, zoom: .75 })
  const viewport = anchoredViewport(anchor, { x: 2048, y: 96.25 })
  assert.equal(viewport.zoom, .75)
  assert.equal(viewport.x + 2048 * viewport.zoom, anchor.x)
  assert.equal(viewport.y + 96.25 * viewport.zoom, anchor.y)
})
