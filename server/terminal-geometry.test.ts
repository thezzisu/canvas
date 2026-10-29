import test from 'node:test'
import assert from 'node:assert/strict'
import { fitTerminalGrid } from '../web/src/terminal-geometry.ts'

test('an exact rendered grid retains every cell when resizing, including fractional cell widths', () => {
  const grid = { width: 174, height: 319, cols: 21, rows: 23 }
  assert.deepEqual(fitTerminalGrid(grid, grid), { cols: 21, rows: 23 })
  assert.deepEqual(fitTerminalGrid({ width: 173.99, height: 318.99 }, grid), { cols: 20, rows: 22 })
  assert.deepEqual(fitTerminalGrid({ width: 348, height: 638 }, grid), { cols: 42, rows: 46 })
})
