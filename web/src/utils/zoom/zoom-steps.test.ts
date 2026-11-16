import test from 'node:test'
import assert from 'node:assert/strict'
import { zoomIn, zoomOut, zoomSteps } from './zoom-steps.ts'

const content = { min: 50, max: 200 },
  ui = { min: 75, max: 150 }

test('zoom controls step through one ladder, each within its own range', () => {
  const up = [50]
  while (zoomIn(up.at(-1)!, content) !== up.at(-1)) up.push(zoomIn(up.at(-1)!, content))
  assert.deepEqual(up, [...zoomSteps])
  assert.equal(zoomIn(150, ui), 150)
  assert.equal(zoomOut(75, ui), 75)
  assert.equal(zoomOut(100, ui), 90)
})

test('a value between levels steps to the neighbouring level', () => {
  assert.equal(zoomIn(120, content), 125)
  assert.equal(zoomOut(120, content), 110)
  assert.equal(zoomOut(60, content), 50)
})
