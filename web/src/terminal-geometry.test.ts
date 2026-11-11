import test from 'node:test'
import assert from 'node:assert/strict'
import { containTerminalScale, fitTerminalGrid, styledSize, terminalFrameReady, terminalMetrics } from './terminal-geometry.ts'

test('only the complete matching native frame releases a geometry transition', () => {
  const grid = { cols: 80, rows: 24 }
  assert.equal(terminalFrameReady(undefined, grid, { start: 0, end: 23 }), false)
  assert.equal(terminalFrameReady({ cols: 100, rows: 30 }, grid, { start: 0, end: 23 }), false)
  assert.equal(terminalFrameReady(grid, grid, { start: 2, end: 23 }), false)
  assert.equal(terminalFrameReady(grid, grid, { start: 0, end: 22 }), false)
  assert.equal(terminalFrameReady(grid, grid, { start: 0, end: 23 }), true)
  assert.equal(terminalFrameReady({ cols: 2, rows: 1 }, { cols: 2, rows: 1 }, { start: 0, end: 0 }), true)
})

test('containment includes native pixel rounding and preserves aspect ratio', () => {
  const available = { width: 273.6, height: 528.8 }, native = { width: 274, height: 528 }
  const scale = containTerminalScale(available, native)
  assert.equal(scale, available.width / native.width)
  assert(scale * native.width <= available.width && scale * native.height <= available.height)
  assert.equal(containTerminalScale({ width: 400, height: 100 }, { width: 100, height: 200 }), .5)
  assert.equal(containTerminalScale({ width: 400, height: 800 }, { width: 100, height: 200 }), 1)
  assert.equal(containTerminalScale({ width: 400, height: 800 }, { width: 100, height: 200 }, true), 4)
})

test('an exact rendered grid retains every cell when resizing, including fractional cell widths', () => {
  const grid = { width: 174, height: 319, cols: 21, rows: 23 }
  assert.deepEqual(fitTerminalGrid(grid, grid), { cols: 21, rows: 23 })
  assert.deepEqual(fitTerminalGrid({ width: 173.99, height: 318.99 }, grid), { cols: 20, rows: 22 })
  assert.deepEqual(fitTerminalGrid({ width: 348, height: 638 }, grid), { cols: 42, rows: 46 })
})

test('large text in a narrow viewport fits below twenty columns without clipping', () => {
  assert.deepEqual(fitTerminalGrid({ width: 212, height: 70 }, { width: 288, height: 100, cols: 20, rows: 5 }), { cols: 14, rows: 3 })
  assert.deepEqual(fitTerminalGrid({ width: 1, height: 1 }, { width: 288, height: 100, cols: 20, rows: 5 }), { cols: 2, rows: 1 })
})

test('rounded DOM widths cannot make a fixed 273.6px viewport alternate between 37 and 38 columns', () => {
  const available = { width: 273.6, height: 528.8 }
  const initial = { width: 720, height: 480, cols: 100, rows: 30 }
  const narrow = { width: 266, height: 528, cols: 37, rows: 33 }
  const wide = { width: 274, height: 528, cols: 38, rows: 33 }
  assert.equal(fitTerminalGrid(available, narrow).cols, 38)
  assert.equal(fitTerminalGrid(available, wide).cols, 37)
  let reference = initial, previous = initial
  for (const rendered of [narrow, wide, narrow, wide, wide]) {
    reference = terminalMetrics(reference, previous, rendered)
    assert.deepEqual(fitTerminalGrid(available, reference), { cols: 38, rows: 33 })
    previous = rendered
  }
})

test('font invalidation and a same-grid size change replace metrics, while an external grid resize does not', () => {
  const original = { width: 720, height: 480, cols: 100, rows: 30 }
  const external = { width: 274, height: 528, cols: 38, rows: 33 }
  assert.equal(terminalMetrics(original, original, external), original)
  const newFont = { ...external, width: 304, height: 594 }
  assert.equal(terminalMetrics(original, external, newFont), newFont)
  assert.equal(terminalMetrics(undefined, undefined, newFont), newFont)
  assert.deepEqual(fitTerminalGrid({ width: 273.6, height: 528.8 }, newFont), { cols: 34, rows: 29 })
})

test('the rendered screen size comes from the inline size xterm assigns, without reading computed styles', () => {
  assert.deepEqual(styledSize({ style: { width: '723px', height: '460px' } } as HTMLElement), { width: 723, height: 460 })
  assert.equal(styledSize({ style: { width: '', height: '460px' } } as HTMLElement), undefined, 'an unmeasured screen has no size')
  assert.equal(styledSize({ style: { width: '0px', height: '0px' } } as HTMLElement), undefined)
})
