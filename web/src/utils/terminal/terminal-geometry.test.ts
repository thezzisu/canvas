import test from 'node:test'
import assert from 'node:assert/strict'
import {
  containTerminalScale,
  fitTerminalGrid,
  placeFrame,
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

test('a view that asks for the size shows any frame at its font, bottom rows in place', () => {
  const available = { width: 400, height: 35 * 16 },
    asked = { rows: 35, cellHeight: 16 }
  const place = (width: number, rows: number) =>
    placeFrame({ frame: { width, height: rows * 16 }, available, asked, upscale: true })
  // 55 rows shown, 35 asked for as a keyboard opens: the top 20 rows are cut.
  assert.deepEqual(place(400, 55), { scale: 1, top: -20 * 16 })
  // The keyboard closed again: 20 rows of room above a frame of 15.
  assert.deepEqual(place(400, 15), { scale: 1, top: 20 * 16 })
  // The frame of the asked grid starts at the top.
  assert.deepEqual(place(400, 35), { scale: 1, top: 0 })
  // The shared window's wider frame, after a reconnect or before the first answer: not scaled.
  assert.deepEqual(place(1080, 40), { scale: 1, top: -5 * 16 })
})

test('a projection shows the whole frame, and grows only in a maximized view', () => {
  const frame = { width: 1080, height: 640 },
    place = (width: number, height: number, upscale: boolean) =>
      placeFrame({ frame, available: { width, height }, upscale })
  assert.deepEqual(place(540, 640, false), { scale: 0.5, top: 0 })
  assert.deepEqual(place(2160, 1280, false), { scale: 1, top: 0 })
  assert.deepEqual(place(2160, 1280, true), { scale: 2, top: 0 })
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
