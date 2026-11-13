import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CellRun } from '../../../../shared/cell-wire.ts'
import { cellRange, selectedSpan, selectionText, wordRange } from './cell-selection.ts'

const lines: CellRun[][] = [
  [
    { column: 0, columns: 6, style: 0, wide: false, text: 'ab cd ' },
    { column: 6, columns: 4, style: 0, wide: true, text: ['中', '文'] },
  ],
  [{ column: 0, columns: 10, style: 0, wide: false, text: 'see (x.y) ' }],
]

test('a range is ordered and spans whole rows between its ends', () => {
  const range = cellRange({ column: 4, row: 1 }, { column: 3, row: 0 })
  assert.deepEqual(range, { start: { column: 3, row: 0 }, end: { column: 4, row: 1 } })
  assert.deepEqual(selectedSpan(range, 0, 10), [3, 10])
  assert.deepEqual(selectedSpan(range, 1, 10), [0, 5])
})

test('selected text keeps wide cells whole and drops the blanks that end a row', () => {
  assert.equal(
    selectionText(lines, { start: { column: 3, row: 0 }, end: { column: 6, row: 0 } }),
    'cd 中',
  )
  assert.equal(
    selectionText(lines, { start: { column: 7, row: 0 }, end: { column: 9, row: 1 } }),
    '中文\nsee (x.y)',
  )
})

test('a word ends at blanks, brackets and quotes', () => {
  assert.deepEqual(wordRange(lines[1]!, { column: 6, row: 1 }), {
    start: { column: 5, row: 1 },
    end: { column: 7, row: 1 },
  })
  assert.deepEqual(wordRange(lines[0]!, { column: 9, row: 0 }), {
    start: { column: 6, row: 0 },
    end: { column: 9, row: 0 },
  })
  const blank = { column: 2, row: 0 }
  assert.deepEqual(wordRange(lines[0]!, blank), { start: blank, end: blank })
})
