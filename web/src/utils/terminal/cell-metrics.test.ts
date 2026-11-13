import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellFromPoint, cellGeometry, columnEdge, unitsToCss } from './cell-metrics.ts'

const font = { advance: 8.4, fontHeight: 18, size: 14, lineHeight: 1, ligatures: false, ratio: 1 }

test('without ligatures a cell is a whole number of layout units', () => {
  for (const ratio of [1, 1.5, 2, 2.625, 3])
    for (const advance of [7.2, 7.03125, 8.4, 8.203125, 9.0001]) {
      const cell = cellGeometry({ ...font, advance, ratio })
      assert.equal(cell.units, ratio * 64)
      assert.equal(
        Number.isInteger(+(cell.width * cell.units).toFixed(6)),
        true,
        `${advance}@${ratio}`,
      )
      // Measurement noise below a hundredth of a unit is not worth a whole unit of spacing.
      assert.ok(cell.spacing > -0.011 / cell.units && cell.spacing < 1 / cell.units)
      assert.ok(Math.abs(cell.width - cell.spacing - advance) < 1e-9)
      // Any number of cells is then an exact length: no drift over a long row.
      assert.equal(columnEdge(500, cell), 500 * Math.round(cell.width * cell.units))
    }
})

test("with ligatures the cell keeps the font's advance and edges are rounded one by one", () => {
  const cell = cellGeometry({ ...font, ligatures: true })
  assert.equal(cell.width, 8.4)
  assert.equal(cell.spacing, 0)
  let worst = 0
  for (let column = 0; column <= 500; column++)
    worst = Math.max(worst, Math.abs(columnEdge(column, cell) / cell.units - column * 8.4))
  assert.ok(worst <= 0.5 / 64 + 1e-9, `${worst}`)
})

test('rows are whole layout pixels, as xterm.js sizes them', () => {
  assert.equal(cellGeometry(font).height, 18)
  assert.equal(cellGeometry({ ...font, ratio: 2 }).height, 18)
  // 18 px is 47.25 device pixels at 2.625: 48 of them, never a fraction.
  assert.equal(cellGeometry({ ...font, ratio: 2.625 }).height, 48 / 2.625)
  assert.equal(cellGeometry({ ...font, ratio: 2.625, lineHeight: 1.2 }).height, 57 / 2.625)
  assert.equal(cellGeometry({ ...font, fontHeight: 0.2 }).height, 1)
})

test('a light line is at least one layout pixel and grows with the font and the ratio', () => {
  assert.equal(cellGeometry({ ...font, size: 8 }).light, 1)
  assert.equal(cellGeometry(font).light, 1)
  assert.equal(cellGeometry({ ...font, ratio: 2 }).light, 2)
  assert.equal(cellGeometry({ ...font, ratio: 2.625 }).light, 3)
  assert.equal(cellGeometry({ ...font, size: 30 }).light, 3)
})

test('a length in layout units survives the browser truncating or rounding it', () => {
  for (const units of [64, 128, 168])
    for (const count of [1, 538, 1153, 268800]) {
      const css = unitsToCss(count, units)
      assert.equal(Math.floor(css * units), count)
      assert.equal(Math.round(css * units), count)
      // Two such lengths added, as a row's height and the part under the next row are.
      assert.equal(Math.floor((css + unitsToCss(7, units)) * units), count + 7)
      assert.equal(Math.round((css - unitsToCss(7, units)) * units), count - 7)
    }
})

test('a point maps to its cell whatever scales the grid', () => {
  const grid = { cols: 80, rows: 24 }
  for (const scale of [1, 0.5, 0.37, 2.625]) {
    const box = { left: 100, top: 50, width: 80 * 8.40625 * scale, height: 24 * 18 * scale }
    const at = (column: number, row: number, fx: number, fy: number) =>
      cellFromPoint(
        box,
        grid,
        box.left + (column + fx) * 8.40625 * scale,
        box.top + (row + fy) * 18 * scale,
      )
    for (const [column, row] of [
      [0, 0],
      [79, 23],
      [40, 12],
    ] as const)
      for (const fraction of [0.01, 0.5, 0.99])
        assert.deepEqual(at(column, row, fraction, fraction), { column, row })
  }
  const box = { left: 0, top: 0, width: 800, height: 240 }
  assert.deepEqual(cellFromPoint(box, grid, -5, -5), { column: 0, row: 0 })
  assert.deepEqual(cellFromPoint(box, grid, 800, 240), { column: 79, row: 23 })
  assert.deepEqual(cellFromPoint({ ...box, width: 0, height: 0 }, grid, 5, 5), {
    column: 0,
    row: 0,
  })
})
