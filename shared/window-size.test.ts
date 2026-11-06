import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTerminalCell } from './settings.ts'
import { defaultWindowSize, normalTerminalGrid } from './window-size.ts'

test('normal shared card geometry retains its default grid and subtracts chrome once', () => {
  assert.deepEqual(normalTerminalGrid(defaultWindowSize, defaultTerminalCell()), { cols: 150, rows: 40 })
  assert.deepEqual(normalTerminalGrid({ width: 1082, height: 600 }, { width: 7.2, height: 17 }), { cols: 150, rows: 33 })
  assert.deepEqual(normalTerminalGrid({ width: 802, height: 572 }, { width: 8, height: 18 }), { cols: 100, rows: 30 })
  assert.deepEqual(normalTerminalGrid({ width: 1, height: 1 }, defaultTerminalCell()), { cols: 2, rows: 1 })
  assert.deepEqual(normalTerminalGrid({ width: 4000, height: 3000 }, { width: 1, height: 1 }), { cols: 500, rows: 200 })
})
