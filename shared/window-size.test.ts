import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTerminalCell } from './settings.ts'
import { defaultWindowSize, normalTerminalGrid } from './window-size.ts'
import { captureToolbarHeight } from './capture.ts'

test('normal shared card geometry retains its default grid and subtracts chrome once', () => {
  assert.deepEqual(defaultTerminalCell(), { width: 7.2, height: 16 })
  assert.deepEqual(defaultWindowSize, { width: 1082, height: 672 })
  assert.deepEqual(normalTerminalGrid(defaultWindowSize, defaultTerminalCell()), { cols: 150, rows: 40 })
  assert.deepEqual(normalTerminalGrid({ width: 1082, height: 600 }, { width: 7.2, height: 17 }), { cols: 150, rows: 33 })
  assert.deepEqual(normalTerminalGrid({ width: 802, height: 572 }, { width: 8, height: 18 }), { cols: 100, rows: 30 })
  assert.deepEqual(normalTerminalGrid({ width: 1, height: 1 }, defaultTerminalCell()), { cols: 2, rows: 1 })
  assert.deepEqual(normalTerminalGrid({ width: 4000, height: 3000 }, { width: 1, height: 1 }), { cols: 500, rows: 200 })
})

test('capture chrome reserves rows without changing normal card font scale or columns', () => {
  const card = { width: 1082, height: 672 }, cell = defaultTerminalCell()
  assert.deepEqual(normalTerminalGrid({ ...card, height: card.height - captureToolbarHeight }, cell), { cols: 150, rows: 37 })
  assert.deepEqual(normalTerminalGrid(card, cell), { cols: 150, rows: 40 })
})
