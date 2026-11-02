import test from 'node:test'
import assert from 'node:assert/strict'
import { lastWindowCanvas } from './window-canvas.ts'
import type { Canvas } from './types'

const canvases: Canvas[] = [{ id: 'canvas-a', name: 'A', nodes: [
  { type: 'terminal', id: 'card', sourceId: 'source-a', spaceId: 'space', windowId: 'window', x: 0, y: 0, width: 500, height: 300 },
] }]

test('last-used navigation accepts only a surviving reference to the same native window', () => {
  const saved = { getItem: () => 'canvas-a' }
  assert.equal(lastWindowCanvas('backend-window', 'source-a', 'window', canvases, saved), 'canvas-a')
  assert.equal(lastWindowCanvas('backend-window', 'source-b', 'window', canvases, saved), 'overview')
  assert.equal(lastWindowCanvas('backend-window', 'source-a', 'another', canvases, saved), 'overview')
  assert.equal(lastWindowCanvas('backend-window', 'source-a', 'window', [], saved), 'overview')
})

test('new identities and inaccessible browser storage safely fall back to Overview', () => {
  const values = new Map([['canvas:window-canvas:backend-a', 'canvas-a']])
  const saved = { getItem: (key: string) => values.get(key) ?? null }
  assert.equal(lastWindowCanvas('backend-a', 'source-a', 'window', canvases, saved), 'canvas-a')
  assert.equal(lastWindowCanvas('backend-b', 'source-a', 'window', canvases, saved), 'overview')
  assert.equal(lastWindowCanvas('backend-a', 'source-a', 'window', canvases, { getItem() { throw Error('Unavailable') } }), 'overview')
  assert.equal(lastWindowCanvas('backend-a', 'source-a', 'window', canvases, { getItem: () => 'overview' }), 'overview')
})
