import test from 'node:test'
import assert from 'node:assert/strict'
import {
  containTerminalScale,
  fitTerminalGrid,
  ownedFrameTop,
  sameTerminalGrid,
} from './terminal-geometry.ts'

test('containment preserves aspect ratio and upscales only on request', () => {
  const available = { width: 273.6, height: 528.8 },
    native = { width: 274, height: 528 }
  const scale = containTerminalScale(available, native)
  assert.equal(scale, available.width / native.width)
  assert(scale * native.width <= available.width && scale * native.height <= available.height)
  assert.equal(containTerminalScale({ width: 400, height: 100 }, { width: 100, height: 200 }), 0.5)
  assert.equal(containTerminalScale({ width: 400, height: 800 }, { width: 100, height: 200 }), 1)
  assert.equal(
    containTerminalScale({ width: 400, height: 800 }, { width: 100, height: 200 }, true),
    4,
  )
})

test('a frame of another height keeps its bottom row where the asked grid ends', () => {
  // 55 rows shown, 35 asked for as a keyboard opens: the top 20 rows are cut.
  assert.equal(ownedFrameTop(55 * 16, 35, 16), -20 * 16)
  // The keyboard closes: 20 rows of room above the old frame.
  assert.equal(ownedFrameTop(35 * 16, 55, 16), 20 * 16)
  // The frame of the asked grid starts at the top.
  assert.equal(ownedFrameTop(35 * 16, 35, 16), 0)
})

test('a box of whole cells keeps every cell, including fractional cell widths', () => {
  const cell = { width: 538 / 64, height: 319 / 23 }
  for (const cols of [21, 37, 38, 80, 133, 500])
    assert.deepEqual(
      fitTerminalGrid({ width: cols * cell.width, height: 23 * cell.height }, cell),
      {
        cols,
        rows: 23,
      },
    )
  assert.deepEqual(fitTerminalGrid({ width: 21 * cell.width - 0.01, height: 318.99 }, cell), {
    cols: 20,
    rows: 22,
  })
})

test('a grid is never smaller than two columns by one row, or larger than a window may be', () => {
  const cell = { width: 14.4, height: 20 }
  assert.deepEqual(fitTerminalGrid({ width: 212, height: 70 }, cell), { cols: 14, rows: 3 })
  assert.deepEqual(fitTerminalGrid({ width: 1, height: 1 }, cell), { cols: 2, rows: 1 })
  assert.deepEqual(fitTerminalGrid({ width: 1e5, height: 1e5 }, cell), { cols: 500, rows: 200 })
})

test('grids compare by size, and nothing equals a missing grid', () => {
  assert.equal(sameTerminalGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), true)
  assert.equal(sameTerminalGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 25 }), false)
  assert.equal(sameTerminalGrid(undefined, undefined), false)
})
